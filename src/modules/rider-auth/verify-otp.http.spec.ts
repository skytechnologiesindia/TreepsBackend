import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { CLOCK } from '../../common/clock.js';
import { verifyHs256Jwt } from '../../common/jwt/hs256-jwt.js';
import { RateLimiter } from '../../common/rate-limit/rate-limiter.js';
import { setupApp } from '../../common/setup-app.js';
import { rawBaseUrl, versionedBaseUrl } from '../../common/testing/base-url.js';
import { sha256Hex } from '../../common/tokens.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AccessTokenService } from '../../common/jwt/access-token.service.js';
import { OTP_PROVIDER, type OtpProvider } from '../otp/provider/otp-provider.js';
import { RiderAuthController } from './rider-auth.controller.js';
import { SendOtpService } from '../otp/send-otp.service.js';
import { InMemoryAuthDb } from './testing/in-memory-auth-db.js';
import { VerifyOtpService } from './verify-otp.service.js';
import { RegisterService } from './register.service.js';

const PHONE = '+919477172214';
const SECRET = 'placeholder-jwt-secret-0123456789abcdef';
const T0 = new Date('2026-10-05T10:00:00.000Z').getTime();
const MINUTE = 60_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Real HTTP, real pipe, filter, interceptor and guards. The database, the provider and the clock
// are test stand-ins, so nothing sleeps and no database is needed.
async function startApp() {
  let now = T0;
  const db = new InMemoryAuthDb();
  const codes: Record<string, string> = {};
  let providerFails = false;
  let providerCalls = 0;
  const provider: OtpProvider = {
    async send() {
      return { providerSessionId: 'unused' };
    },
    async verify(sessionId, otp) {
      providerCalls += 1;
      if (providerFails) throw new Error('SECRET-provider-down');
      return codes[sessionId] === otp;
    },
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [RiderAuthController],
    providers: [
      SendOtpService,
      VerifyOtpService,
      RegisterService,
      { provide: AccessTokenService, useValue: new AccessTokenService(SECRET) },
      { provide: PrismaService, useValue: db },
      { provide: OTP_PROVIDER, useValue: provider },
      { provide: CLOCK, useValue: () => new Date(now) },
      { provide: ConfigService, useValue: { get: () => 0 } },
      { provide: RateLimiter, useFactory: () => new RateLimiter() },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  setupApp(app);
  await app.listen(0, '127.0.0.1');
  return {
    app,
    db,
    providerCalls: () => providerCalls,
    failProvider: () => (providerFails = true),
    advance: (ms: number) => (now += ms),
    session(overrides: Record<string, unknown> = {}, code = '123456') {
      const id = `fake-session-${db.tables.otpSession.length + 1}`;
      codes[id] = code;
      return db.addSession({ phoneNumber: PHONE, providerSessionId: id, createdAt: new Date(now - MINUTE), expiresAt: new Date(now + 4 * MINUTE), ...overrides });
    },
  };
}
type Ctx = Awaited<ReturnType<typeof startApp>>;

const body = (overrides: Record<string, unknown> = {}) => ({
  phoneNumber: PHONE,
  otp: '123456',
  device: { deviceId: 'device-1', platform: 'ANDROID', appVersion: '1.4.2' },
  ...overrides,
});

async function post(app: INestApplication, payload: unknown, base: 'versioned' | 'raw' = 'versioned') {
  const url = `${base === 'versioned' ? versionedBaseUrl(app) : rawBaseUrl(app)}/rider/auth/verify-otp`;
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  return { res, body: await res.json() };
}

describe('POST /v1/rider/auth/verify-otp', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await startApp();
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  describe('login (an ACTIVE rider)', () => {
    it('replies 200 in the standard envelope with the rider and tokens', async () => {
      const rider = ctx.db.addRider();
      ctx.session();
      const { res, body: reply } = await post(ctx.app, body());
      expect(res.status).toBe(200);
      expect(reply.success).toBe(true);
      expect(Object.keys(reply).sort()).toEqual(['data', 'requestId', 'success']);
      expect(reply.requestId).toMatch(UUID_V4);
      expect(reply.requestId).toBe(res.headers.get('x-request-id'));
      expect(Object.keys(reply.data).sort()).toEqual(['isNewRider', 'rider', 'tokens']);
      expect(reply.data.isNewRider).toBe(false);
      expect(reply.data.rider).toMatchObject({ id: rider.id, fullName: 'Asha Verma', phoneNumber: PHONE, status: 'ACTIVE', isPhoneVerified: true });
      expect(Object.keys(reply.data.tokens).sort()).toEqual(['accessToken', 'accessTokenExpiresInSeconds', 'refreshToken', 'refreshTokenExpiresInSeconds']);
      expect(reply.data.tokens.accessTokenExpiresInSeconds).toBe(900);
      expect(reply.data.tokens.refreshTokenExpiresInSeconds).toBe(2_592_000);
      expect(verifyHs256Jwt(reply.data.tokens.accessToken, SECRET, T0 / 1000)).toMatchObject({ iss: 'treeps', sub: rider.id, role: 'RIDER', deviceId: 'device-1' });
      expect(ctx.db.tables.refreshToken[0].tokenHash).toBe(sha256Hex(reply.data.tokens.refreshToken));
    });

    it('is not served without the /v1 prefix (NOT_FOUND)', async () => {
      const { res, body: reply } = await post(ctx.app, body(), 'raw');
      expect(res.status).toBe(404);
      expect(reply.error.code).toBe('NOT_FOUND');
    });

    it('a repeat of the same request is OTP_INVALID (single use) and issues nothing more', async () => {
      ctx.db.addRider();
      ctx.session();
      expect((await post(ctx.app, body())).res.status).toBe(200);
      const again = await post(ctx.app, body());
      expect(again.res.status).toBe(422);
      expect(again.body.error.code).toBe('OTP_INVALID');
      expect(ctx.db.tables.refreshToken).toHaveLength(1);
    });

    it('two simultaneous requests with the right code: one 200 and one 422', async () => {
      ctx.db.addRider();
      ctx.session();
      const [a, b] = await Promise.all([post(ctx.app, body()), post(ctx.app, body())]);
      expect([a.res.status, b.res.status].sort()).toEqual([200, 422]);
      expect(ctx.db.tables.refreshToken).toHaveLength(1);
    });
  });

  describe('a phone with no rider', () => {
    it('replies 200 with isNewRider true and a registration token, and creates no rider', async () => {
      const session = ctx.session();
      const { res, body: reply } = await post(ctx.app, body());
      expect(res.status).toBe(200);
      expect(Object.keys(reply.data).sort()).toEqual(['isNewRider', 'registrationToken', 'registrationTokenExpiresInSeconds']);
      expect(reply.data.isNewRider).toBe(true);
      expect(reply.data.registrationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(reply.data.registrationTokenExpiresInSeconds).toBe(600);
      expect(session.registrationTokenHash).toBe(sha256Hex(reply.data.registrationToken));
      expect(ctx.db.tables.rider).toHaveLength(0);
      expect(JSON.stringify(reply)).not.toContain('fake-session');
    });
  });

  describe('a rider who is not ACTIVE', () => {
    it.each(['SUSPENDED', 'BLOCKED', 'DELETED'])('%s: 403 ACCOUNT_BANNED, no tokens', async (status) => {
      ctx.db.addRider({ status });
      ctx.session();
      const { res, body: reply } = await post(ctx.app, body());
      expect(res.status).toBe(403);
      expect(reply.success).toBe(false);
      expect(reply.error).toEqual({ code: 'ACCOUNT_BANNED', message: "This account can't book rides.", field: null });
      expect(ctx.db.tables.refreshToken).toHaveLength(0);
      expect(ctx.db.tables.device).toHaveLength(0);
    });
  });

  describe('OTP errors', () => {
    it('a wrong code: 422 OTP_INVALID with field otp', async () => {
      ctx.session();
      const { res, body: reply } = await post(ctx.app, body({ otp: '000000' }));
      expect(res.status).toBe(422);
      expect(reply.error).toEqual({ code: 'OTP_INVALID', message: 'That code is not right. Please check and try again.', field: 'otp' });
    });

    it('no session: 422 OTP_INVALID', async () => {
      expect((await post(ctx.app, body())).body.error.code).toBe('OTP_INVALID');
    });

    it('an expired session: 422 OTP_EXPIRED', async () => {
      ctx.session();
      ctx.advance(5 * MINUTE);
      const { res, body: reply } = await post(ctx.app, body());
      expect(res.status).toBe(422);
      expect(reply.error).toEqual({ code: 'OTP_EXPIRED', message: 'That code has expired. Please ask for a new one.', field: 'otp' });
    });

    it('after 5 wrong codes: 429 OTP_ATTEMPTS_EXCEEDED', async () => {
      ctx.session();
      for (let i = 0; i < 5; i++) expect((await post(ctx.app, body({ otp: '000000' }))).body.error.code).toBe('OTP_INVALID');
      const { res, body: reply } = await post(ctx.app, body());
      expect(res.status).toBe(429);
      expect(reply.error).toEqual({ code: 'OTP_ATTEMPTS_EXCEEDED', message: 'Too many wrong codes. Please ask for a new code.', field: 'otp' });
      expect(ctx.providerCalls()).toBe(5);
    });

    it('a provider failure: 503 OTP_PROVIDER_ERROR, the attempt is given back, no leaked text', async () => {
      const session = ctx.session();
      ctx.failProvider();
      const { res, body: reply } = await post(ctx.app, body());
      expect(res.status).toBe(503);
      expect(reply.error).toEqual({ code: 'OTP_PROVIDER_ERROR', message: "We couldn't reach the code service. Please try again.", field: null });
      expect(JSON.stringify(reply)).not.toContain('SECRET');
      expect(session.attempts).toBe(0);
    });
  });

  describe('rate limit', () => {
    it('10 attempts per phone per hour: 429 RATE_LIMITED, and the provider is not called', async () => {
      ctx.session({ attempts: 5, createdAt: new Date(T0 - 30 * MINUTE), expiresAt: new Date(T0 - 25 * MINUTE) });
      ctx.session({ attempts: 5, createdAt: new Date(T0 - 20 * MINUTE), expiresAt: new Date(T0 - 15 * MINUTE) });
      ctx.session();
      const { res, body: reply } = await post(ctx.app, body());
      expect(res.status).toBe(429);
      expect(reply.error).toEqual({ code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.', field: null });
      expect(ctx.providerCalls()).toBe(0);
    });

    it('has no per-IP limit: 25 requests from one IP for different phones are all answered normally', async () => {
      for (let i = 0; i < 25; i++) {
        const { res, body: reply } = await post(ctx.app, body({ phoneNumber: `+9194771722${String(i).padStart(2, '0')}` }));
        expect(res.status).toBe(422);
        expect(reply.error.code).toBe('OTP_INVALID');
      }
    });
  });

  describe('invalid input: 400 INVALID_INPUT, nothing happens', () => {
    const detailsOf = async (payload: unknown) => (await post(ctx.app, payload)).body.error.details;

    it('missing fields are REQUIRED', async () => {
      expect(await detailsOf({})).toEqual([
        { field: 'device', reason: 'REQUIRED' },
        { field: 'otp', reason: 'REQUIRED' },
        { field: 'phoneNumber', reason: 'REQUIRED' },
      ]);
    });

    it('a bad phone and a bad otp', async () => {
      expect(await detailsOf(body({ phoneNumber: '9477172214' }))).toEqual([{ field: 'phoneNumber', reason: 'INVALID_FORMAT' }]);
      expect(await detailsOf(body({ otp: 123456 }))).toEqual([{ field: 'otp', reason: 'WRONG_TYPE' }]);
      expect(await detailsOf(body({ otp: '12345' }))).toEqual([{ field: 'otp', reason: 'INVALID_FORMAT' }]);
      expect(await detailsOf(body({ otp: '12345a' }))).toEqual([{ field: 'otp', reason: 'INVALID_FORMAT' }]);
    });

    it('device problems use dot-path field names', async () => {
      const device = { deviceId: 'device-1', platform: 'ANDROID', appVersion: '1.4.2' };
      expect(await detailsOf(body({ device: { ...device, platform: 'WINDOWS' } }))).toEqual([{ field: 'device.platform', reason: 'NOT_ALLOWED' }]);
      expect(await detailsOf(body({ device: { ...device, deviceId: 'bad id' } }))).toEqual([{ field: 'device.deviceId', reason: 'INVALID_FORMAT' }]);
      expect(await detailsOf(body({ device: { ...device, appVersion: '1.4' } }))).toEqual([{ field: 'device.appVersion', reason: 'INVALID_FORMAT' }]);
      expect(await detailsOf(body({ device: { ...device, fcmToken: '' } }))).toEqual([{ field: 'device.fcmToken', reason: 'REQUIRED' }]);
      expect(await detailsOf(body({ device: { ...device, fcmToken: 'x'.repeat(513) } }))).toEqual([{ field: 'device.fcmToken', reason: 'TOO_LONG' }]);
      expect(await detailsOf(body({ device: { platform: 'IOS', appVersion: '1.4.2' } }))).toEqual([{ field: 'device.deviceId', reason: 'REQUIRED' }]);
      expect(await detailsOf(body({ device: 'phone' }))).toEqual([{ field: 'device', reason: 'WRONG_TYPE' }]);
    });

    it('unknown fields are rejected, also inside device', async () => {
      expect(await detailsOf(body({ status: 'ACTIVE', role: 'ADMIN', purpose: 'RIDER_AUTH' }))).toEqual([
        { field: 'purpose', reason: 'UNKNOWN_FIELD' },
        { field: 'role', reason: 'UNKNOWN_FIELD' },
        { field: 'status', reason: 'UNKNOWN_FIELD' },
      ]);
      const device = { deviceId: 'device-1', platform: 'ANDROID', appVersion: '1.4.2', rooted: true };
      expect(await detailsOf(body({ device }))).toEqual([{ field: 'device.rooted', reason: 'UNKNOWN_FIELD' }]);
    });

    it('does nothing: no provider call, no database change', async () => {
      const session = ctx.session();
      await post(ctx.app, body({ otp: 'abcdef' }));
      await post(ctx.app, {});
      expect(ctx.providerCalls()).toBe(0);
      expect(session.attempts).toBe(0);
      expect(ctx.db.tables.device).toHaveLength(0);
    });
  });
});
