import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { CLOCK } from '../../common/clock.js';
import { RateLimiter } from '../../common/rate-limit/rate-limiter.js';
import { SessionService } from '../../common/session/session.service.js';
import { setupApp } from '../../common/setup-app.js';
import { versionedBaseUrl } from '../../common/testing/base-url.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { FakeOtpProvider } from '../otp/provider/fake-otp.provider.js';
import { OTP_PROVIDER } from '../otp/provider/otp-provider.js';
import { SendOtpService } from '../otp/send-otp.service.js';
import { RegisterService } from '../rider-auth/register.service.js';
import { RiderAuthController } from '../rider-auth/rider-auth.controller.js';
import { InMemoryAuthDb } from '../rider-auth/testing/in-memory-auth-db.js';
import { VerifyOtpService } from '../rider-auth/verify-otp.service.js';
import { DriverAuthController } from './driver-auth.controller.js';
import { DriverVerifyOtpService } from './driver-verify-otp.service.js';

const PHONE = '+919477172214';
const CODE = '123456';
const T0 = new Date('2026-10-09T10:00:00.000Z').getTime();
const SECOND = 1000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Real HTTP with both auth controllers on one app and one database, so the driver/rider difference
// (one active session vs one per device) is checked through the real routes.
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
      SessionService,
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

  async function call(path: string, payload?: unknown, token?: string) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: payload === undefined ? undefined : JSON.stringify(payload) });
    return { res, body: await res.json() };
  }
  const device = (deviceId: string) => ({ deviceId, platform: 'ANDROID', appVersion: '1.4.2' });
  async function login(role: 'driver' | 'rider', deviceId: string, phone = PHONE) {
    now += SECOND;
    db.addSession({ phoneNumber: phone, purpose: role === 'driver' ? 'DRIVER_AUTH' : 'RIDER_AUTH', providerSessionId: 'fake-session-1', createdAt: new Date(now), expiresAt: new Date(now + 240 * SECOND) });
    const { res, body } = await call(`/${role}/auth/verify-otp`, { phoneNumber: phone, otp: CODE, device: device(deviceId) });
    if (res.status !== 200) throw new Error(`setup: ${role} verify-otp gave ${res.status}`);
    return { token: body.data.tokens.accessToken as string, reply: body.data };
  }
  return { app, db, call, login, advance: (ms: number) => (now += ms) };
}
type Ctx = Awaited<ReturnType<typeof startApp>>;

describe('driver and rider sessions over HTTP (docs/api/driver-logout.md, rider-logout.md)', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await startApp();
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  describe('verify-otp reply shape', () => {
    it('driver: tokens is exactly { accessToken, expiresInSeconds }, with IST twins elsewhere', async () => {
      const { reply } = await ctx.login('driver', 'phone-1');
      expect(Object.keys(reply.tokens).sort()).toEqual(['accessToken', 'expiresInSeconds']);
      expect(reply.tokens.expiresInSeconds).toBe(2_592_000);
      expect(reply.tokens.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(reply.driver.createdAtIst).toMatch(/^\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2}$/);
    });
  });

  describe('driver: one active session (decision 174)', () => {
    it('a login on a second phone kills the first phone session immediately', async () => {
      const first = await ctx.login('driver', 'phone-1');
      const second = await ctx.login('driver', 'phone-2');
      expect(ctx.db.tables.driverRefreshToken).toHaveLength(1);
      expect(ctx.db.tables.driverDevice.map((d) => d.deviceId)).toEqual(['phone-2']);
      const dead = await ctx.call('/driver/auth/logout', undefined, first.token);
      expect(dead.res.status).toBe(401);
      expect(dead.body.error.code).toBe('UNAUTHORIZED');
      expect((await ctx.call('/driver/auth/logout', undefined, second.token)).res.status).toBe(200);
    });

    it('logging in again on the same phone replaces its session', async () => {
      const first = await ctx.login('driver', 'phone-1');
      const second = await ctx.login('driver', 'phone-1');
      expect((await ctx.call('/driver/auth/logout', undefined, first.token)).res.status).toBe(401);
      expect((await ctx.call('/driver/auth/logout', undefined, second.token)).res.status).toBe(200);
    });

    it('another driver is not affected', async () => {
      const other = await ctx.login('driver', 'phone-9', '+919477172299');
      await ctx.login('driver', 'phone-1');
      await ctx.login('driver', 'phone-2');
      expect((await ctx.call('/driver/auth/logout', undefined, other.token)).res.status).toBe(200);
    });
  });

  describe('rider: a session per device (single-device is TO DECIDE, decision 177)', () => {
    it('a second device does NOT kill the first', async () => {
      const first = await ctx.login('rider', 'phone-1');
      const second = await ctx.login('rider', 'phone-2');
      expect(ctx.db.tables.refreshToken).toHaveLength(2);
      expect((await ctx.call('/rider/auth/register', { fullName: 'Asha Verma', gender: 'FEMALE' }, first.token)).res.status).toBe(200);
      expect((await ctx.call('/rider/auth/register', { fullName: 'Asha Verma', gender: 'FEMALE' }, second.token)).res.status).toBe(200);
    });

    it('the same device replaces its own session', async () => {
      const first = await ctx.login('rider', 'phone-1');
      const second = await ctx.login('rider', 'phone-1');
      expect((await ctx.call('/rider/auth/register', { fullName: 'Asha Verma', gender: 'FEMALE' }, first.token)).res.status).toBe(401);
      expect((await ctx.call('/rider/auth/register', { fullName: 'Asha Verma', gender: 'FEMALE' }, second.token)).res.status).toBe(200);
    });

    it('register works with the session token from verify-otp', async () => {
      const { token, reply } = await ctx.login('rider', 'phone-1');
      expect(reply.rider.status).toBe('PROFILE_PENDING');
      const done = await ctx.call('/rider/auth/register', { fullName: 'Asha Verma', gender: 'FEMALE', email: 'asha@example.com' }, token);
      expect(done.res.status).toBe(200);
      expect(done.body.data.rider).toMatchObject({ status: 'ACTIVE', isProfileComplete: true });
    });
  });

  describe('logout', () => {
    it.each(['driver', 'rider'] as const)('%s: 200 { loggedOut: true } in the envelope, and the token is dead after', async (role) => {
      const { token } = await ctx.login(role, 'phone-1');
      const out = await ctx.call(`/${role}/auth/logout`, undefined, token);
      expect(out.res.status).toBe(200);
      expect(Object.keys(out.body).sort()).toEqual(['data', 'requestId', 'success']);
      expect(out.body.data).toEqual({ loggedOut: true });
      expect(out.body.requestId).toMatch(UUID_V4);
      expect((role === 'driver' ? ctx.db.tables.driverRefreshToken : ctx.db.tables.refreshToken)).toHaveLength(0);
      // The device row goes with the session, so its push token does not outlive the logout.
      expect((role === 'driver' ? ctx.db.tables.driverDevice : ctx.db.tables.device)).toHaveLength(0);
      const again = await ctx.call(`/${role}/auth/logout`, undefined, token);
      expect(again.res.status).toBe(401);
      expect(again.body.error.code).toBe('UNAUTHORIZED');
    });

    it.each(['driver', 'rider'] as const)('%s: no token is 401, an unknown token is 401', async (role) => {
      expect((await ctx.call(`/${role}/auth/logout`)).res.status).toBe(401);
      expect((await ctx.call(`/${role}/auth/logout`, undefined, 'A'.repeat(43))).res.status).toBe(401);
    });

    it('a rider token on the driver logout and a driver token on the rider logout are 403', async () => {
      const rider = await ctx.login('rider', 'phone-1');
      const driver = await ctx.login('driver', 'phone-1');
      const a = await ctx.call('/driver/auth/logout', undefined, rider.token);
      const b = await ctx.call('/rider/auth/logout', undefined, driver.token);
      expect([a.res.status, b.res.status]).toEqual([403, 403]);
      expect(a.body.error.code).toBe('FORBIDDEN');
    });

    it('an unknown field in the body is not read (logout takes no body)', async () => {
      const { token } = await ctx.login('driver', 'phone-1');
      expect((await ctx.call('/driver/auth/logout', { anything: 1 }, token)).res.status).toBe(200);
    });

    it('a banned driver gets 403 ACCOUNT_BANNED from logout and the session is gone', async () => {
      const { token } = await ctx.login('driver', 'phone-1');
      ctx.db.tables.driver[0].status = 'SUSPENDED';
      const out = await ctx.call('/driver/auth/logout', undefined, token);
      expect(out.res.status).toBe(403);
      expect(out.body.error.code).toBe('ACCOUNT_BANNED');
      expect(ctx.db.tables.driverRefreshToken).toHaveLength(0);
    });
  });
});
