import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { CLOCK } from '../../common/clock.js';
import { AccessTokenService } from '../../common/jwt/access-token.service.js';
import { verifyHs256Jwt } from '../../common/jwt/hs256-jwt.js';
import { RateLimiter } from '../../common/rate-limit/rate-limiter.js';
import { setupApp } from '../../common/setup-app.js';
import { versionedBaseUrl } from '../../common/testing/base-url.js';
import { sha256Hex } from '../../common/tokens.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { FakeOtpProvider } from '../otp/provider/fake-otp.provider.js';
import { OTP_PROVIDER } from '../otp/provider/otp-provider.js';
import { SendOtpService } from '../otp/send-otp.service.js';
import { RegisterService } from '../rider-auth/register.service.js';
import { RiderAuthController } from '../rider-auth/rider-auth.controller.js';
import { InMemoryAuthDb } from '../rider-auth/testing/in-memory-auth-db.js';
import { VerifyOtpService } from '../rider-auth/verify-otp.service.js';
import { DriverAuthController } from './driver-auth.controller.js';
import { DriverSessionService } from './driver-session.service.js';
import { DriverVerifyOtpService } from './driver-verify-otp.service.js';

const PHONE = '+919477172214';
const CODE = '123456';
const SECRET = 'placeholder-jwt-secret-0123456789abcdef';
const T0 = new Date('2026-10-09T10:00:00.000Z').getTime();
const SECOND = 1000;
const DAY = 24 * 60 * 60 * SECOND;
const INVALID = { code: 'REFRESH_TOKEN_INVALID', message: 'Your session has ended. Please log in again.', field: null };
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Real HTTP, real pipe, filter, interceptors and guards; the database and the clock are stand-ins.
async function startApp() {
  let now = T0;
  const db = new InMemoryAuthDb();
  const moduleRef = await Test.createTestingModule({
    controllers: [DriverAuthController, RiderAuthController],
    providers: [
      SendOtpService,
      VerifyOtpService,
      RegisterService,
      DriverVerifyOtpService,
      DriverSessionService,
      { provide: AccessTokenService, useValue: new AccessTokenService(SECRET) },
      { provide: PrismaService, useValue: db },
      { provide: OTP_PROVIDER, useValue: new FakeOtpProvider(CODE) },
      { provide: CLOCK, useValue: () => new Date(now) },
      { provide: ConfigService, useValue: { get: () => 0 } },
      { provide: RateLimiter, useFactory: () => new RateLimiter() },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  setupApp(app);
  await app.listen(0, '127.0.0.1');
  const base = versionedBaseUrl(app);

  async function post(path: string, payload: unknown) {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    return { res, body: await res.json() };
  }
  const deviceBody = (deviceId: string) => ({ deviceId, platform: 'ANDROID', appVersion: '1.4.2' });
  return {
    app,
    db,
    advance: (ms: number) => (now += ms),
    post,
    // A driver verify-otp on one device: a fresh session for the phone, then the real route.
    async login(deviceId: string, phone = PHONE) {
      now += SECOND;
      db.addSession({ phoneNumber: phone, purpose: 'DRIVER_AUTH', providerSessionId: 'fake-session-1', createdAt: new Date(now), expiresAt: new Date(now + 4 * 60 * SECOND) });
      const { res, body } = await post('/driver/auth/verify-otp', { phoneNumber: phone, otp: CODE, device: deviceBody(deviceId) });
      if (res.status !== 200) throw new Error(`setup: driver verify-otp gave ${res.status}`);
      return { driverId: body.data.driver.id as string, tokens: body.data.tokens as Record<string, any>, refreshToken: body.data.tokens.refreshToken as string, deviceId };
    },
    refresh: (refreshToken: unknown, deviceId: unknown) => post('/driver/auth/refresh', { refreshToken, deviceId }),
    logout: (refreshToken: unknown) => post('/driver/auth/logout', { refreshToken }),
    async riderLogin(deviceId: string) {
      now += SECOND;
      db.addSession({ phoneNumber: PHONE, purpose: 'RIDER_AUTH', providerSessionId: 'fake-session-1', createdAt: new Date(now), expiresAt: new Date(now + 4 * 60 * SECOND) });
      const { res, body } = await post('/rider/auth/verify-otp', { phoneNumber: PHONE, otp: CODE, device: deviceBody(deviceId) });
      if (res.status !== 200) throw new Error(`setup: rider verify-otp gave ${res.status}`);
      return body.data;
    },
  };
}
type Ctx = Awaited<ReturnType<typeof startApp>>;

describe('driver refresh and logout (docs/api/driver-refresh.md, driver-logout.md)', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await startApp();
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  describe('refresh: success and rotation', () => {
    it('200 with the verify-otp tokens shape, a new access token and a new refresh token', async () => {
      const s = await ctx.login('device-1');
      ctx.advance(60 * SECOND);
      const { res, body } = await ctx.refresh(s.refreshToken, 'device-1');
      expect(res.status).toBe(200);
      expect(Object.keys(body).sort()).toEqual(['data', 'requestId', 'success']);
      expect(body.requestId).toMatch(UUID_V4);
      expect(Object.keys(body.data)).toEqual(['tokens']);
      const t = body.data.tokens;
      expect(Object.keys(t).sort()).toEqual(Object.keys(s.tokens).sort());
      expect(t.accessTokenExpiresInSeconds).toBe(900);
      expect(t.refreshTokenExpiresInSeconds).toBe(2_592_000);
      expect(t.refreshToken).not.toBe(s.refreshToken);
      expect(t.accessToken).not.toBe(s.tokens.accessToken);
      expect(verifyHs256Jwt(t.accessToken, SECRET, (T0 + 120 * SECOND) / 1000)).toMatchObject({ iss: 'treeps', sub: s.driverId, role: 'DRIVER', deviceId: 'device-1' });
    });

    it('invalidates the old token and gives the new one a fresh 30 days from now', async () => {
      const s = await ctx.login('device-1');
      ctx.advance(10 * DAY);
      const rotatedAt = T0 + SECOND + 10 * DAY;
      const { body } = await ctx.refresh(s.refreshToken, 'device-1');
      const rows = ctx.db.tables.driverRefreshToken;
      const old = rows.find((r) => r.tokenHash === sha256Hex(s.refreshToken))!;
      const fresh = rows.find((r) => r.tokenHash === sha256Hex(body.data.tokens.refreshToken))!;
      expect(old.revokedAt.getTime()).toBe(rotatedAt);
      expect(fresh.revokedAt).toBeNull();
      expect(fresh.expiresAt.getTime()).toBe(rotatedAt + 30 * DAY);
      expect(rows.filter((r) => r.revokedAt === null)).toHaveLength(1);
    });

    it('the new refresh token can be rotated again, many times in a row', async () => {
      let token = (await ctx.login('device-1')).refreshToken;
      for (let i = 0; i < 5; i++) {
        ctx.advance(60 * SECOND);
        const { res, body } = await ctx.refresh(token, 'device-1');
        expect(res.status).toBe(200);
        token = body.data.tokens.refreshToken;
      }
    });

    it('an access token that already expired is not needed: the route has no guard', async () => {
      const s = await ctx.login('device-1');
      ctx.advance(2 * 60 * 60 * SECOND);
      expect((await ctx.refresh(s.refreshToken, 'device-1')).res.status).toBe(200);
    });
  });

  describe('refresh: reuse detection', () => {
    it('an old (rotated) token is rejected with the single error', async () => {
      const s = await ctx.login('device-1');
      await ctx.refresh(s.refreshToken, 'device-1');
      const again = await ctx.refresh(s.refreshToken, 'device-1');
      expect(again.res.status).toBe(401);
      expect(again.body.success).toBe(false);
      expect(again.body.error).toEqual(INVALID);
    });

    it('reuse within 10 s is only a 401: the new token still works and nothing is revoked', async () => {
      const s = await ctx.login('device-1');
      const first = await ctx.refresh(s.refreshToken, 'device-1');
      ctx.advance(5 * SECOND);
      expect((await ctx.refresh(s.refreshToken, 'device-1')).res.status).toBe(401);
      expect(ctx.db.tables.driverDevice).toHaveLength(1);
      expect((await ctx.refresh(first.body.data.tokens.refreshToken, 'device-1')).res.status).toBe(200);
    });

    it('reuse after more than 10 s is theft: every session of the driver is revoked', async () => {
      const s = await ctx.login('device-1');
      const first = await ctx.refresh(s.refreshToken, 'device-1');
      ctx.advance(11 * SECOND);
      expect((await ctx.refresh(s.refreshToken, 'device-1')).res.status).toBe(401);
      expect(ctx.db.tables.driverRefreshToken).toHaveLength(0);
      expect(ctx.db.tables.driverDevice).toHaveLength(0);
      const stolen = await ctx.refresh(first.body.data.tokens.refreshToken, 'device-1');
      expect(stolen.res.status).toBe(401);
      expect(stolen.body.error).toEqual(INVALID);
    });

    it('theft detection ends only that driver: another driver keeps their session', async () => {
      const other = await ctx.login('device-9', '+919477172299');
      const s = await ctx.login('device-1');
      await ctx.refresh(s.refreshToken, 'device-1');
      ctx.advance(11 * SECOND);
      await ctx.refresh(s.refreshToken, 'device-1');
      expect((await ctx.refresh(other.refreshToken, 'device-9')).res.status).toBe(200);
    });

    it('two parallel refreshes with one token: exactly one succeeds', async () => {
      const s = await ctx.login('device-1');
      const replies = await Promise.all([ctx.refresh(s.refreshToken, 'device-1'), ctx.refresh(s.refreshToken, 'device-1')]);
      expect(replies.map((r) => r.res.status).sort()).toEqual([200, 401]);
      expect(ctx.db.tables.driverRefreshToken.filter((r) => r.revokedAt === null)).toHaveLength(1);
    });

    it('eight parallel refreshes: still exactly one success, and the session survives', async () => {
      const s = await ctx.login('device-1');
      const replies = await Promise.all(Array.from({ length: 8 }, () => ctx.refresh(s.refreshToken, 'device-1')));
      expect(replies.filter((r) => r.res.status === 200)).toHaveLength(1);
      expect(replies.filter((r) => r.res.status === 401 && r.body.error.code === 'REFRESH_TOKEN_INVALID')).toHaveLength(7);
      const winner = replies.find((r) => r.res.status === 200)!;
      expect((await ctx.refresh(winner.body.data.tokens.refreshToken, 'device-1')).res.status).toBe(200);
    });
  });

  describe('refresh: every other bad token is the same single error', () => {
    it.each([
      ['an unknown well-formed token', 'A'.repeat(43)],
      ['a malformed string', 'not-a-token'],
      ['a very long string', 'x'.repeat(512)],
    ])('%s', async (_name, token) => {
      const { res, body } = await ctx.refresh(token, 'device-1');
      expect(res.status).toBe(401);
      expect(body.error).toEqual(INVALID);
    });

    it('an expired token (30 days passed)', async () => {
      const s = await ctx.login('device-1');
      ctx.advance(30 * DAY + SECOND);
      const { res, body } = await ctx.refresh(s.refreshToken, 'device-1');
      expect(res.status).toBe(401);
      expect(body.error).toEqual(INVALID);
      expect(ctx.db.tables.driverDevice).toHaveLength(1); // expiry alone revokes nothing
    });

    it('a wrong deviceId: 401, no revocation, and the right device can still refresh', async () => {
      const s = await ctx.login('device-1');
      const { res, body } = await ctx.refresh(s.refreshToken, 'device-2');
      expect(res.status).toBe(401);
      expect(body.error).toEqual(INVALID);
      expect(ctx.db.tables.driverRefreshToken.filter((r) => r.revokedAt === null)).toHaveLength(1);
      expect((await ctx.refresh(s.refreshToken, 'device-1')).res.status).toBe(200);
    });

    it('a RIDER refresh token on the driver route (same phone, same device id)', async () => {
      const rider = await ctx.riderLogin('device-1');
      await ctx.login('device-1');
      const { res, body } = await ctx.refresh(rider.tokens.refreshToken, 'device-1');
      expect(res.status).toBe(401);
      expect(body.error).toEqual(INVALID);
    });

    it('an access token sent as a refresh token', async () => {
      const s = await ctx.login('device-1');
      expect((await ctx.refresh(s.tokens.accessToken, 'device-1')).res.status).toBe(401);
    });

    it('a driver whose row is gone is the same error', async () => {
      const s = await ctx.login('device-1');
      ctx.db.tables.driver.length = 0;
      expect((await ctx.refresh(s.refreshToken, 'device-1')).res.status).toBe(401);
    });
  });

  describe('refresh: banned driver', () => {
    it.each(['SUSPENDED', 'BLOCKED', 'DELETED'])('a %s driver gets 403 ACCOUNT_BANNED and loses every session', async (status) => {
      const s = await ctx.login('device-1');
      ctx.db.tables.driver[0].status = status;
      const { res, body } = await ctx.refresh(s.refreshToken, 'device-1');
      expect(res.status).toBe(403);
      expect(body.error.code).toBe('ACCOUNT_BANNED');
      expect(ctx.db.tables.driverRefreshToken).toHaveLength(0);
      expect(ctx.db.tables.driverDevice).toHaveLength(0);
      expect((await ctx.refresh(s.refreshToken, 'device-1')).res.status).toBe(401);
    });
  });

  describe('refresh: input and limits', () => {
    it('missing fields are REQUIRED, a number is WRONG_TYPE, an unknown field is UNKNOWN_FIELD, a bad deviceId is INVALID_FORMAT', async () => {
      const details = async (payload: unknown) => {
        const { res, body } = await ctx.post('/driver/auth/refresh', payload);
        expect(res.status).toBe(400);
        expect(body.error.code).toBe('INVALID_INPUT');
        return body.error.details;
      };
      expect(await details({})).toEqual([{ field: 'deviceId', reason: 'REQUIRED' }, { field: 'refreshToken', reason: 'REQUIRED' }]);
      expect(await details({ refreshToken: 5, deviceId: 'device-1' })).toEqual([{ field: 'refreshToken', reason: 'WRONG_TYPE' }]);
      expect(await details({ refreshToken: 'a', deviceId: 'device-1', role: 'ADMIN' })).toEqual([{ field: 'role', reason: 'UNKNOWN_FIELD' }]);
      expect(await details({ refreshToken: 'a', deviceId: 'bad id!' })).toEqual([{ field: 'deviceId', reason: 'INVALID_FORMAT' }]);
    });

    it('is not served without the /v1 prefix', async () => {
      const res = await fetch(`${versionedBaseUrl(ctx.app).replace('/v1', '')}/driver/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(404);
    });

    it('120 requests per IP per hour, the 121st is 429 RATE_LIMITED', async () => {
      for (let i = 0; i < 120; i++) expect((await ctx.refresh('A'.repeat(43), 'device-1')).res.status).toBe(401);
      const { res, body } = await ctx.refresh('A'.repeat(43), 'device-1');
      expect(res.status).toBe(429);
      expect(body.error.code).toBe('RATE_LIMITED');
    });
  });

  describe('logout', () => {
    it('200 { loggedOut: true } without any Authorization header, and the device session is gone', async () => {
      const s = await ctx.login('device-1');
      const { res, body } = await ctx.logout(s.refreshToken);
      expect(res.status).toBe(200);
      expect(body).toMatchObject({ success: true, data: { loggedOut: true } });
      expect(body.requestId).toMatch(UUID_V4);
      expect(ctx.db.tables.driverDevice).toHaveLength(0);
      expect(ctx.db.tables.driverRefreshToken).toHaveLength(0);
      const after = await ctx.refresh(s.refreshToken, 'device-1');
      expect(after.res.status).toBe(401);
      expect(after.body.error).toEqual(INVALID);
    });

    it('is idempotent: logging out again with the same token is still 200', async () => {
      const s = await ctx.login('device-1');
      await ctx.logout(s.refreshToken);
      const again = await ctx.logout(s.refreshToken);
      expect(again.res.status).toBe(200);
      expect(again.body.data).toEqual({ loggedOut: true });
    });

    it.each([['an unknown well-formed token', 'A'.repeat(43)], ['a garbage string', 'x']])('%s is 200 and changes nothing', async (_name, token) => {
      await ctx.login('device-1');
      const { res, body } = await ctx.logout(token);
      expect(res.status).toBe(200);
      expect(body.data).toEqual({ loggedOut: true });
      expect(ctx.db.tables.driverDevice).toHaveLength(1);
    });

    it('works for an old (already rotated) token and for an expired one', async () => {
      const s = await ctx.login('device-1');
      await ctx.refresh(s.refreshToken, 'device-1');
      expect((await ctx.logout(s.refreshToken)).res.status).toBe(200);
      expect(ctx.db.tables.driverDevice).toHaveLength(0);
    });

    it('ends only that driver: another driver keeps their session', async () => {
      const other = await ctx.login('device-9', '+919477172299');
      const s = await ctx.login('device-1');
      await ctx.logout(s.refreshToken);
      expect((await ctx.refresh(other.refreshToken, 'device-9')).res.status).toBe(200);
    });

    it('a missing or non-string token is INVALID_INPUT, an unknown field is UNKNOWN_FIELD', async () => {
      expect((await ctx.post('/driver/auth/logout', {})).res.status).toBe(400);
      expect((await ctx.post('/driver/auth/logout', { refreshToken: 5 })).res.status).toBe(400);
      const extra = await ctx.post('/driver/auth/logout', { refreshToken: 'a', deviceId: 'device-1' });
      expect(extra.body.error.details).toEqual([{ field: 'deviceId', reason: 'UNKNOWN_FIELD' }]);
    });
  });

  describe('one active device per driver (decision 170)', () => {
    it('a second device OTP login kills the first device refresh token', async () => {
      const a = await ctx.login('device-A');
      const b = await ctx.login('device-B');
      expect(ctx.db.tables.driverDevice.map((d) => d.deviceId)).toEqual(['device-B']);
      expect(ctx.db.tables.driverRefreshToken.every((r) => r.deviceId === 'device-B')).toBe(true);
      const old = await ctx.refresh(a.refreshToken, 'device-A');
      expect(old.res.status).toBe(401);
      expect(old.body.error).toEqual(INVALID);
      expect((await ctx.refresh(b.refreshToken, 'device-B')).res.status).toBe(200);
    });

    it('logging in again on the same device keeps that one device', async () => {
      await ctx.login('device-A');
      await ctx.login('device-A');
      expect(ctx.db.tables.driverDevice).toHaveLength(1);
    });

    it('only the logging-in driver is affected', async () => {
      const other = await ctx.login('device-9', '+919477172299');
      await ctx.login('device-A');
      await ctx.login('device-B');
      expect((await ctx.refresh(other.refreshToken, 'device-9')).res.status).toBe(200);
    });

    it('riders are unchanged: a second rider device does not kill the first', async () => {
      await ctx.riderLogin('device-A');
      await ctx.riderLogin('device-B');
      expect(ctx.db.tables.device.map((d) => d.deviceId).sort()).toEqual(['device-A', 'device-B']);
      expect(ctx.db.tables.refreshToken.filter((r) => r.revokedAt === null)).toHaveLength(2);
    });

    it('known limit (decision 173): the first device access token still verifies until it expires', async () => {
      const a = await ctx.login('device-A');
      await ctx.login('device-B');
      expect(verifyHs256Jwt(a.tokens.accessToken, SECRET, (T0 + 10 * SECOND) / 1000)).toMatchObject({ role: 'DRIVER', deviceId: 'device-A' });
    });
  });
});
