import { Inject, Injectable } from '@nestjs/common';
import { DriverStatus } from '@prisma/client';
import { classifyRefreshToken } from '../../common/auth/refresh-rotation.js';
import { CLOCK, type Clock } from '../../common/clock.js';
import { AppException } from '../../common/errors/app.exception.js';
import { AccessTokenService, type AuthTokens } from '../../common/jwt/access-token.service.js';
import { newOpaqueToken, sha256Hex } from '../../common/tokens.js';
import { REFRESH_TOKEN_TTL_SECONDS } from '../../config/tokens.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { DriverLogoutDto } from './dto/logout.dto.js';
import type { DriverRefreshDto } from './dto/refresh.dto.js';

const BANNED: ReadonlySet<DriverStatus> = new Set([DriverStatus.SUSPENDED, DriverStatus.BLOCKED, DriverStatus.DELETED]);
const invalid = () => new AppException('REFRESH_TOKEN_INVALID');

// Refresh and logout for the driver (docs/api/driver-refresh.md and driver-logout.md, decisions 170
// to 172). A driver has one active device, so "the session" is the one DriverDevice row and its
// DriverRefreshToken rows. In Express terms: the refresh-token endpoints of an auth router.
@Injectable()
export class DriverSessionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly accessTokens: AccessTokenService,
  ) {}

  async refresh(dto: DriverRefreshDto): Promise<{ tokens: AuthTokens }> {
    const now = this.clock();

    // 1. The token row. Unknown, or issued to another device: the one error, nothing else happens.
    // Only driver tokens live in this table, so a rider token is simply unknown here.
    const row = await this.prisma.driverRefreshToken.findUnique({ where: { tokenHash: sha256Hex(dto.refreshToken) } });
    if (!row || row.deviceId !== dto.deviceId) throw invalid();

    // 2. Reuse check (see refresh-rotation.ts). Theft ends every session of the driver; a retry
    // inside the grace window only gets the error.
    const state = classifyRefreshToken(row, now);
    if (state === 'REUSED') {
      await this.endAllSessions(row.driverId);
      throw invalid();
    }
    if (state !== 'USABLE') throw invalid();

    // 3. A banned driver loses every session.
    const driver = await this.prisma.driver.findUnique({ where: { id: row.driverId } });
    if (!driver) throw invalid();
    if (BANNED.has(driver.status)) {
      await this.endAllSessions(driver.id);
      throw new AppException('ACCOUNT_BANNED');
    }

    // 4. Rotate in one transaction. The conditional update lets exactly one of two parallel calls
    // through: the other waits on the row, then matches nothing and gets the plain error.
    const refreshToken = newOpaqueToken();
    await this.prisma.$transaction(async (tx) => {
      const rotated = await tx.driverRefreshToken.updateMany({
        where: { id: row.id, revokedAt: null, expiresAt: { gt: now } },
        data: { revokedAt: now },
      });
      if (rotated.count === 0) throw invalid();
      await tx.driverRefreshToken.create({
        data: {
          tokenHash: sha256Hex(refreshToken),
          driverId: row.driverId,
          deviceId: row.deviceId,
          expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000), // a fresh 30 days
          createdAt: now,
        },
      });
      await tx.driverDevice.updateMany({ where: { driverId: row.driverId, deviceId: row.deviceId }, data: { lastSeenAt: now } });
    });

    const access = this.accessTokens.issueForDriver({ driverId: row.driverId, deviceId: row.deviceId, now });
    return {
      tokens: {
        accessToken: access.token,
        accessTokenExpiresInSeconds: access.expiresInSeconds,
        refreshToken,
        refreshTokenExpiresInSeconds: REFRESH_TOKEN_TTL_SECONDS,
      },
    };
  }

  // Always succeeds. A known token (even an old or expired one) ends that device's session; an
  // unknown one changes nothing. The reply never says which.
  async logout(dto: DriverLogoutDto): Promise<{ loggedOut: true }> {
    const row = await this.prisma.driverRefreshToken.findUnique({ where: { tokenHash: sha256Hex(dto.refreshToken) } });
    if (row) {
      await this.prisma.$transaction(async (tx) => {
        await tx.driverRefreshToken.deleteMany({ where: { driverId: row.driverId, deviceId: row.deviceId } });
        await tx.driverDevice.deleteMany({ where: { driverId: row.driverId, deviceId: row.deviceId } });
      });
    }
    return { loggedOut: true };
  }

  // Deletes every device and refresh token of the driver, so every token they held is now unknown.
  private async endAllSessions(driverId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.driverRefreshToken.deleteMany({ where: { driverId } });
      await tx.driverDevice.deleteMany({ where: { driverId } });
    });
  }
}
