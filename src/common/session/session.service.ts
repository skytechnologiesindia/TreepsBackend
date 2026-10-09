import { Injectable } from '@nestjs/common';
import { DRIVER_ROLE, RIDER_ROLE, SESSION_TOKEN_TTL_SECONDS, SESSION_TOUCH_INTERVAL_MS } from '../../config/tokens.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { newOpaqueToken, sha256Hex } from '../tokens.js';
import type { Session, SessionRole, SessionTokens } from './session.types.js';

// Anything with the two session tables: the PrismaService itself or a transaction client.
type SessionDb = Pick<PrismaService, 'refreshToken' | 'driverRefreshToken'>;

const TTL_MS = SESSION_TOKEN_TTL_SECONDS * 1000;

// THE ONLY place that reads or writes sessions (decision 175). The guard, logout and verify-otp call
// this service and never query the session tables themselves, so a cache (for example Redis) can be
// added later inside this one class.
//
// Storage reuses the old refresh-token tables, so no migration was needed (decision 174): RefreshToken
// holds rider sessions and DriverRefreshToken holds driver sessions. tokenHash is the SHA-256 of the
// token (the token itself is never stored), expiresAt is the sliding expiry, createdAt is the login
// time, and "last used" is derived: expiresAt minus 30 days (it is rewritten at most once an hour).
// The revokedAt column is no longer used; a row that has it set is an old refresh token and is ignored.
// In Express terms: an express-session store with a tiny interface.
@Injectable()
export class SessionService {
  constructor(private readonly prisma: PrismaService) {}

  // Creates the session for (account, device) and returns the one and only copy of the token. A device
  // has one session: an earlier one for the same device is deleted first, so logging in again on the
  // same install replaces it. Pass a transaction client to make this part of that transaction.
  async create(input: { role: SessionRole; accountId: string; deviceId: string; now: Date }, db: SessionDb = this.prisma): Promise<SessionTokens> {
    const { role, accountId, deviceId, now } = input;
    const token = newOpaqueToken();
    const data = { tokenHash: sha256Hex(token), deviceId, expiresAt: new Date(now.getTime() + TTL_MS), createdAt: now };
    await this.deleteForDevice(role, accountId, deviceId, db);
    if (role === RIDER_ROLE) await db.refreshToken.create({ data: { ...data, riderId: accountId } });
    else await db.driverRefreshToken.create({ data: { ...data, driverId: accountId } });
    return { accessToken: token, expiresInSeconds: SESSION_TOKEN_TTL_SECONDS };
  }

  // The session for a presented token, or null if it is unknown or expired. The token is hashed
  // here; the hash never leaves this class.
  async findByToken(token: string, now: Date): Promise<Session | null> {
    const tokenHash = sha256Hex(token);
    const [rider, driver] = await Promise.all([
      this.prisma.refreshToken.findUnique({ where: { tokenHash } }),
      this.prisma.driverRefreshToken.findUnique({ where: { tokenHash } }),
    ]);
    const live = (row: { revokedAt: Date | null; expiresAt: Date } | null) => row !== null && row.revokedAt === null && row.expiresAt.getTime() > now.getTime();
    if (rider && live(rider)) return { id: rider.id, role: RIDER_ROLE, accountId: rider.riderId, deviceId: rider.deviceId, expiresAt: rider.expiresAt };
    if (driver && live(driver)) return { id: driver.id, role: DRIVER_ROLE, accountId: driver.driverId, deviceId: driver.deviceId, expiresAt: driver.expiresAt };
    return null;
  }

  // Sliding expiry: moves expiresAt to now + 30 days, but writes at most once an hour per session
  // (a request inside the hour changes nothing). The update only matches if expiresAt is still the
  // value that was read, so parallel requests make one write between them.
  async touch(session: Session, now: Date): Promise<void> {
    const lastUsedAt = session.expiresAt.getTime() - TTL_MS;
    if (now.getTime() - lastUsedAt < SESSION_TOUCH_INTERVAL_MS) return;
    const where = { id: session.id, expiresAt: session.expiresAt };
    const data = { expiresAt: new Date(now.getTime() + TTL_MS) };
    if (session.role === RIDER_ROLE) await this.prisma.refreshToken.updateMany({ where, data });
    else await this.prisma.driverRefreshToken.updateMany({ where, data });
  }

  // Logout: the session of one device. Deleting an absent session is not an error.
  async deleteForDevice(role: SessionRole, accountId: string, deviceId: string, db: SessionDb = this.prisma): Promise<void> {
    if (role === RIDER_ROLE) await db.refreshToken.deleteMany({ where: { riderId: accountId, deviceId } });
    else await db.driverRefreshToken.deleteMany({ where: { driverId: accountId, deviceId } });
  }

  // Every session of the account, optionally keeping one device (the driver's "one active session":
  // all others are deleted after a login). Also used when an account is banned.
  async deleteAllForAccount(role: SessionRole, accountId: string, options: { exceptDeviceId?: string } = {}, db: SessionDb = this.prisma): Promise<void> {
    const deviceId = options.exceptDeviceId === undefined ? {} : { deviceId: { not: options.exceptDeviceId } };
    if (role === RIDER_ROLE) await db.refreshToken.deleteMany({ where: { riderId: accountId, ...deviceId } });
    else await db.driverRefreshToken.deleteMany({ where: { driverId: accountId, ...deviceId } });
  }
}
