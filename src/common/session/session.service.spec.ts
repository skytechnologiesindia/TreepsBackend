import { InMemoryAuthDb } from '../../modules/rider-auth/testing/in-memory-auth-db.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { sha256Hex } from '../tokens.js';
import { SessionService } from './session.service.js';

const NOW = new Date('2026-10-09T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function setup() {
  const db = new InMemoryAuthDb();
  return { db, sessions: new SessionService(db as unknown as PrismaService) };
}

describe('SessionService', () => {
  it('create returns an opaque url-safe token of at least 32 bytes and stores only its SHA-256 hash', async () => {
    const { db, sessions } = setup();
    const { accessToken, expiresInSeconds } = await sessions.create({ role: 'RIDER', accountId: 'r1', deviceId: 'd1', now: NOW });
    expect(accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url
    expect(expiresInSeconds).toBe(2_592_000);
    expect(db.tables.refreshToken).toHaveLength(1);
    expect(db.tables.refreshToken[0]).toMatchObject({ riderId: 'r1', deviceId: 'd1', tokenHash: sha256Hex(accessToken) });
    expect(db.tables.refreshToken[0].expiresAt.getTime()).toBe(NOW.getTime() + 30 * DAY);
    expect(JSON.stringify(db.tables.refreshToken)).not.toContain(accessToken);
  });

  it('every token is different', async () => {
    const { sessions } = setup();
    const tokens = await Promise.all(Array.from({ length: 20 }, (_, i) => sessions.create({ role: 'RIDER', accountId: 'r1', deviceId: `d${i}`, now: NOW })));
    expect(new Set(tokens.map((t) => t.accessToken)).size).toBe(20);
  });

  it('findByToken finds a rider session and a driver session with the right role', async () => {
    const { sessions } = setup();
    const rider = await sessions.create({ role: 'RIDER', accountId: 'r1', deviceId: 'd1', now: NOW });
    const driver = await sessions.create({ role: 'DRIVER', accountId: 'dr1', deviceId: 'd2', now: NOW });
    expect(await sessions.findByToken(rider.accessToken, NOW)).toMatchObject({ role: 'RIDER', accountId: 'r1', deviceId: 'd1' });
    expect(await sessions.findByToken(driver.accessToken, NOW)).toMatchObject({ role: 'DRIVER', accountId: 'dr1', deviceId: 'd2' });
  });

  it('findByToken returns null for unknown and for expired tokens', async () => {
    const { sessions } = setup();
    const { accessToken } = await sessions.create({ role: 'RIDER', accountId: 'r1', deviceId: 'd1', now: NOW });
    expect(await sessions.findByToken('nope', NOW)).toBeNull();
    expect(await sessions.findByToken(accessToken, new Date(NOW.getTime() + 30 * DAY - 1))).not.toBeNull();
    expect(await sessions.findByToken(accessToken, new Date(NOW.getTime() + 30 * DAY))).toBeNull();
  });

  it('the same device has one session: creating again replaces the first', async () => {
    const { db, sessions } = setup();
    const first = await sessions.create({ role: 'RIDER', accountId: 'r1', deviceId: 'd1', now: NOW });
    const second = await sessions.create({ role: 'RIDER', accountId: 'r1', deviceId: 'd1', now: NOW });
    expect(await sessions.findByToken(first.accessToken, NOW)).toBeNull();
    expect(await sessions.findByToken(second.accessToken, NOW)).not.toBeNull();
    expect(db.tables.refreshToken).toHaveLength(1);
  });

  it('different devices of a rider keep separate sessions', async () => {
    const { sessions } = setup();
    const a = await sessions.create({ role: 'RIDER', accountId: 'r1', deviceId: 'd1', now: NOW });
    const b = await sessions.create({ role: 'RIDER', accountId: 'r1', deviceId: 'd2', now: NOW });
    expect(await sessions.findByToken(a.accessToken, NOW)).not.toBeNull();
    expect(await sessions.findByToken(b.accessToken, NOW)).not.toBeNull();
  });

  it('touch writes at most once an hour', async () => {
    const { db, sessions } = setup();
    const { accessToken } = await sessions.create({ role: 'RIDER', accountId: 'r1', deviceId: 'd1', now: NOW });
    const at = (ms: number) => new Date(NOW.getTime() + ms);
    let session = (await sessions.findByToken(accessToken, at(30 * 60_000)))!;
    await sessions.touch(session, at(30 * 60_000));
    expect(db.calls['refreshToken.updateMany'] ?? 0).toBe(0);
    session = (await sessions.findByToken(accessToken, at(2 * 3_600_000)))!;
    await sessions.touch(session, at(2 * 3_600_000));
    expect(db.calls['refreshToken.updateMany']).toBe(1);
    expect(db.tables.refreshToken[0].expiresAt.getTime()).toBe(at(2 * 3_600_000).getTime() + 30 * DAY);
    session = (await sessions.findByToken(accessToken, at(2 * 3_600_000 + 5 * 60_000)))!;
    await sessions.touch(session, at(2 * 3_600_000 + 5 * 60_000));
    expect(db.calls['refreshToken.updateMany']).toBe(1);
  });

  it('logout deletes the session AND the device row of that device only (the push token goes with it)', async () => {
    const { db, sessions } = setup();
    db.tables.device.push({ id: 'x1', riderId: 'r1', deviceId: 'd1', fcmToken: 'tok-1' }, { id: 'x2', riderId: 'r1', deviceId: 'd2', fcmToken: 'tok-2' });
    db.tables.driverDevice.push({ id: 'y1', driverId: 'dr1', deviceId: 'd1', fcmToken: 'tok-3' });
    await sessions.create({ role: 'RIDER', accountId: 'r1', deviceId: 'd1', now: NOW });
    await sessions.create({ role: 'RIDER', accountId: 'r1', deviceId: 'd2', now: NOW });
    await sessions.create({ role: 'DRIVER', accountId: 'dr1', deviceId: 'd1', now: NOW });
    await sessions.logout('RIDER', 'r1', 'd1');
    await sessions.logout('RIDER', 'r1', 'd1'); // absent rows are fine
    expect(db.tables.device.map((d) => d.deviceId)).toEqual(['d2']);
    expect(db.tables.refreshToken.map((r) => r.deviceId)).toEqual(['d2']);
    expect(db.tables.driverDevice).toHaveLength(1);
    await sessions.logout('DRIVER', 'dr1', 'd1');
    expect(db.tables.driverDevice).toHaveLength(0);
    expect(db.tables.driverRefreshToken).toHaveLength(0);
  });

  it('deleteForDevice removes one device session and nothing else; deleting an absent one is fine', async () => {
    const { sessions } = setup();
    const a = await sessions.create({ role: 'RIDER', accountId: 'r1', deviceId: 'd1', now: NOW });
    const b = await sessions.create({ role: 'RIDER', accountId: 'r1', deviceId: 'd2', now: NOW });
    await sessions.deleteForDevice('RIDER', 'r1', 'd1');
    await sessions.deleteForDevice('RIDER', 'r1', 'd1');
    expect(await sessions.findByToken(a.accessToken, NOW)).toBeNull();
    expect(await sessions.findByToken(b.accessToken, NOW)).not.toBeNull();
  });

  it('deleteAllForAccount removes every session of that account only, or all but one device', async () => {
    const { sessions } = setup();
    const a = await sessions.create({ role: 'DRIVER', accountId: 'dr1', deviceId: 'd1', now: NOW });
    const b = await sessions.create({ role: 'DRIVER', accountId: 'dr1', deviceId: 'd2', now: NOW });
    const other = await sessions.create({ role: 'DRIVER', accountId: 'dr2', deviceId: 'd1', now: NOW });
    await sessions.deleteAllForAccount('DRIVER', 'dr1', { exceptDeviceId: 'd2' });
    expect(await sessions.findByToken(a.accessToken, NOW)).toBeNull();
    expect(await sessions.findByToken(b.accessToken, NOW)).not.toBeNull();
    await sessions.deleteAllForAccount('DRIVER', 'dr1');
    expect(await sessions.findByToken(b.accessToken, NOW)).toBeNull();
    expect(await sessions.findByToken(other.accessToken, NOW)).not.toBeNull();
  });

  it('a rider and a driver with the same account id and device id do not touch each other', async () => {
    const { sessions } = setup();
    const rider = await sessions.create({ role: 'RIDER', accountId: 'same', deviceId: 'd1', now: NOW });
    const driver = await sessions.create({ role: 'DRIVER', accountId: 'same', deviceId: 'd1', now: NOW });
    await sessions.deleteAllForAccount('DRIVER', 'same');
    expect(await sessions.findByToken(rider.accessToken, NOW)).not.toBeNull();
    expect(await sessions.findByToken(driver.accessToken, NOW)).toBeNull();
  });
});
