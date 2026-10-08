import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { CLOCK } from '../../common/clock.js';
import { verifyHs256Jwt } from '../../common/jwt/hs256-jwt.js';
import { RateLimiter } from '../../common/rate-limit/rate-limiter.js';
import { setupApp } from '../../common/setup-app.js';
import { rawBaseUrl, versionedBaseUrl } from '../../common/testing/base-url.js';
import { newOpaqueToken, sha256Hex } from '../../common/tokens.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AccessTokenService } from '../../common/jwt/access-token.service.js';
import { FakeOtpProvider } from '../otp/provider/fake-otp.provider.js';
import { OTP_PROVIDER } from '../otp/provider/otp-provider.js';
import { SendOtpService } from '../otp/send-otp.service.js';
import { RegisterService } from './register.service.js';
import { RiderAuthController } from './rider-auth.controller.js';
import { InMemoryAuthDb } from './testing/in-memory-auth-db.js';
import { VerifyOtpService } from './verify-otp.service.js';

const PHONE = '+919477172214';
const FAKE_CODE = '123456';
const SECRET = 'placeholder-jwt-secret-0123456789abcdef';
const T0 = new Date('2026-10-05T10:00:00.000Z').getTime();
const SECOND = 1000;
const MINUTE = 60_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Real HTTP, real pipe, filter, interceptor and guards. The database and the clock are test
// stand-ins; the OTP provider is the real FakeOtpProvider, so the flow test runs send-otp, verify-otp
// and register exactly as the app does.
async function startApp() {
  let now = T0;
  const db = new InMemoryAuthDb();
  const moduleRef = await Test.createTestingModule({
    controllers: [RiderAuthController],
    providers: [
      SendOtpService,
      VerifyOtpService,
      RegisterService,
      { provide: AccessTokenService, useValue: new AccessTokenService(SECRET) },
      { provide: PrismaService, useValue: db },
      { provide: OTP_PROVIDER, useValue: new FakeOtpProvider(FAKE_CODE) },
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
    advance: (ms: number) => (now += ms),
    // A session verify-otp finished for an unknown phone: code used, registration token issued.
    session(overrides: Record<string, unknown> = {}) {
      const token = newOpaqueToken();
      const row = db.addSession({
        phoneNumber: PHONE,
        attempts: 1,
        createdAt: new Date(now - MINUTE),
        verifiedAt: new Date(now - 10 * SECOND),
        registrationTokenHash: sha256Hex(token),
        registrationExpiresAt: new Date(now - 10 * SECOND + 10 * MINUTE),
        ...overrides,
      });
      return { token, row };
    },
  };
}
type Ctx = Awaited<ReturnType<typeof startApp>>;

const device = { deviceId: 'device-1', platform: 'ANDROID', appVersion: '1.4.2' };
const body = (token: string, overrides: Record<string, unknown> = {}) => ({
  registrationToken: token,
  fullName: 'Asha Verma',
  device,
  ...overrides,
});

async function call(app: INestApplication, path: string, payload: unknown, base: 'versioned' | 'raw' = 'versioned') {
  const url = `${base === 'versioned' ? versionedBaseUrl(app) : rawBaseUrl(app)}/rider/auth/${path}`;
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  return { res, body: await res.json() };
}
const register = (app: INestApplication, payload: unknown, base: 'versioned' | 'raw' = 'versioned') => call(app, 'register', payload, base);

describe('POST /v1/rider/auth/register', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await startApp();
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  describe('success', () => {
    it('replies 201 in the standard envelope with the rider and tokens', async () => {
      const { token } = ctx.session();
      const { res, body: reply } = await register(ctx.app, body(token, { email: 'asha@example.com', registeredCity: ' Ranchi ' }));
      expect(res.status).toBe(201);
      expect(reply.success).toBe(true);
      expect(Object.keys(reply).sort()).toEqual(['data', 'requestId', 'success']);
      expect(reply.requestId).toMatch(UUID_V4);
      expect(reply.requestId).toBe(res.headers.get('x-request-id'));
      expect(Object.keys(reply.data).sort()).toEqual(['rider', 'tokens']);
      expect(reply.data.rider).toMatchObject({
        fullName: 'Asha Verma',
        phoneNumber: PHONE,
        email: 'asha@example.com',
        registeredCity: 'Ranchi',
        registeredState: null,
        status: 'ACTIVE',
        isPhoneVerified: true,
        isEmailVerified: false,
        isProfileComplete: false,
        createdAt: '2026-10-05T10:00:00.000Z',
      });
      expect(Object.keys(reply.data.tokens).sort()).toEqual(['accessToken', 'accessTokenExpiresInSeconds', 'refreshToken', 'refreshTokenExpiresInSeconds']);
      expect(reply.data.tokens.accessTokenExpiresInSeconds).toBe(900);
      expect(reply.data.tokens.refreshTokenExpiresInSeconds).toBe(2_592_000);
      expect(verifyHs256Jwt(reply.data.tokens.accessToken, SECRET, T0 / 1000)).toMatchObject({ iss: 'treeps', sub: reply.data.rider.id, role: 'RIDER', deviceId: 'device-1' });
      expect(ctx.db.tables.refreshToken[0].tokenHash).toBe(sha256Hex(reply.data.tokens.refreshToken));
    });

    it('is not served without the /v1 prefix (NOT_FOUND)', async () => {
      const { token } = ctx.session();
      const { res, body: reply } = await register(ctx.app, body(token), 'raw');
      expect(res.status).toBe(404);
      expect(reply.error.code).toBe('NOT_FOUND');
      expect(ctx.db.tables.rider).toHaveLength(0);
    });

    it.each(['Anita Kumari', "O'Brien", 'O’Brien', 'Dr. Singh', 'Mary-Jane', 'अनीता कुमारी'])('accepts the name %s', async (fullName) => {
      const { token } = ctx.session();
      const { res, body: reply } = await register(ctx.app, body(token, { fullName }));
      expect(res.status).toBe(201);
      expect(reply.data.rider.fullName).toBe(fullName);
    });

    it.each([
      ['omitted', {}, null],
      ['null', { registeredCity: null, registeredState: null }, null],
      ['whitespace only', { registeredCity: '   ', registeredState: '\t ' }, null],
    ])('city and state %s never block registration and are stored as null', async (_name, extra, stored) => {
      const { token } = ctx.session();
      const { res, body: reply } = await register(ctx.app, body(token, extra));
      expect(res.status).toBe(201);
      expect(reply.data.rider.registeredCity).toBe(stored);
      expect(reply.data.rider.registeredState).toBe(stored);
    });
  });

  describe('the registration token: 422 REGISTRATION_TOKEN_INVALID', () => {
    const expected = { code: 'REGISTRATION_TOKEN_INVALID', message: 'Your sign-up session has expired. Please verify your phone again.', field: 'registrationToken' };

    it('an unknown token', async () => {
      const { res, body: reply } = await register(ctx.app, body(newOpaqueToken()));
      expect(res.status).toBe(422);
      expect(reply.error).toEqual(expected);
    });

    it('an expired token', async () => {
      const { token } = ctx.session();
      ctx.advance(10 * MINUTE);
      const { res, body: reply } = await register(ctx.app, body(token));
      expect(res.status).toBe(422);
      expect(reply.error).toEqual(expected);
      expect(ctx.db.tables.rider).toHaveLength(0);
    });

    it('a session whose code was never verified', async () => {
      const { token } = ctx.session({ verifiedAt: null });
      const { res, body: reply } = await register(ctx.app, body(token));
      expect(res.status).toBe(422);
      expect(reply.error).toEqual(expected);
    });

    it('a token that was already used: the repeat creates nothing more', async () => {
      const { token } = ctx.session();
      expect((await register(ctx.app, body(token))).res.status).toBe(201);
      const again = await register(ctx.app, body(token, { fullName: 'Someone Else' }));
      expect(again.res.status).toBe(422);
      expect(again.body.error).toEqual(expected);
      expect(ctx.db.tables.rider).toHaveLength(1);
      expect(ctx.db.tables.device).toHaveLength(1);
      expect(ctx.db.tables.refreshToken).toHaveLength(1);
    });

    it('two simultaneous requests with one token: one 201 and one 422', async () => {
      const { token } = ctx.session();
      const [a, b] = await Promise.all([register(ctx.app, body(token)), register(ctx.app, body(token))]);
      expect([a.res.status, b.res.status].sort()).toEqual([201, 422]);
      expect(ctx.db.tables.rider).toHaveLength(1);
    });
  });

  describe('conflicts: 409', () => {
    it('EMAIL_IN_USE with field email, and the token still works with another email', async () => {
      ctx.db.addRider({ phoneNumber: '+919477172299', email: 'taken@example.com' });
      const { token } = ctx.session();
      const { res, body: reply } = await register(ctx.app, body(token, { email: 'taken@example.com' }));
      expect(res.status).toBe(409);
      expect(reply.error).toEqual({ code: 'EMAIL_IN_USE', message: 'This email is already in use.', field: 'email' });
      expect((await register(ctx.app, body(token, { email: 'free@example.com' }))).res.status).toBe(201);
    });

    it('CONFLICT when a rider already owns the verified phone', async () => {
      ctx.db.addRider({ phoneNumber: PHONE });
      const { token } = ctx.session();
      const { res, body: reply } = await register(ctx.app, body(token));
      expect(res.status).toBe(409);
      expect(reply.error.code).toBe('CONFLICT');
      expect(reply.error.field).toBeNull();
    });
  });

  describe('invalid input: 400 INVALID_INPUT, and the token is not burned', () => {
    const detailsOf = async (payload: unknown) => (await register(ctx.app, payload)).body.error.details;
    let token: string;
    beforeEach(() => {
      token = ctx.session().token;
    });

    it('missing fields are REQUIRED', async () => {
      expect(await detailsOf({})).toEqual([
        { field: 'device', reason: 'REQUIRED' },
        { field: 'fullName', reason: 'REQUIRED' },
        { field: 'registrationToken', reason: 'REQUIRED' },
      ]);
    });

    it('the registration token: wrong type, wrong length, wrong alphabet', async () => {
      expect(await detailsOf(body(token, { registrationToken: 5 }))).toEqual([{ field: 'registrationToken', reason: 'WRONG_TYPE' }]);
      expect(await detailsOf(body(token, { registrationToken: token.slice(1) }))).toEqual([{ field: 'registrationToken', reason: 'INVALID_FORMAT' }]);
      expect(await detailsOf(body(token, { registrationToken: token + 'a' }))).toEqual([{ field: 'registrationToken', reason: 'INVALID_FORMAT' }]);
      expect(await detailsOf(body(token, { registrationToken: token.slice(1) + '+' }))).toEqual([{ field: 'registrationToken', reason: 'INVALID_FORMAT' }]);
    });

    it('fullName', async () => {
      const name = async (fullName: unknown) => detailsOf(body(token, { fullName }));
      expect(await name('A')).toEqual([{ field: 'fullName', reason: 'TOO_SHORT' }]);
      expect(await name('A'.repeat(101))).toEqual([{ field: 'fullName', reason: 'TOO_LONG' }]);
      expect(await name('Anita1')).toEqual([{ field: 'fullName', reason: 'INVALID_FORMAT' }]);
      expect(await name(' Anita')).toEqual([{ field: 'fullName', reason: 'INVALID_FORMAT' }]);
      expect(await name('Anita ')).toEqual([{ field: 'fullName', reason: 'INVALID_FORMAT' }]);
      expect(await name('Anita  Kumari')).toEqual([{ field: 'fullName', reason: 'INVALID_FORMAT' }]);
      expect(await name('-Mary')).toEqual([{ field: 'fullName', reason: 'INVALID_FORMAT' }]);
      expect(await name('Mary--Jane')).toEqual([{ field: 'fullName', reason: 'INVALID_FORMAT' }]);
      expect(await name(7)).toEqual([{ field: 'fullName', reason: 'WRONG_TYPE' }]);
    });

    it('email', async () => {
      const email = async (value: unknown) => detailsOf(body(token, { email: value }));
      expect(await email('Anita@example.com')).toEqual([{ field: 'email', reason: 'INVALID_FORMAT' }]);
      expect(await email('anita @example.com')).toEqual([{ field: 'email', reason: 'INVALID_FORMAT' }]);
      expect(await email('anita@example')).toEqual([{ field: 'email', reason: 'INVALID_FORMAT' }]);
      expect(await email('a'.repeat(250) + '@b.co')).toEqual([{ field: 'email', reason: 'TOO_LONG' }]);
      expect(await email(null)).toEqual([{ field: 'email', reason: 'WRONG_TYPE' }]);
    });

    it('city and state: "" is TOO_SHORT, a number is WRONG_TYPE, over 100 is TOO_LONG', async () => {
      expect(await detailsOf(body(token, { registeredCity: '' }))).toEqual([{ field: 'registeredCity', reason: 'TOO_SHORT' }]);
      expect(await detailsOf(body(token, { registeredState: 5 }))).toEqual([{ field: 'registeredState', reason: 'WRONG_TYPE' }]);
      expect(await detailsOf(body(token, { registeredCity: 'a'.repeat(101) }))).toEqual([{ field: 'registeredCity', reason: 'TOO_LONG' }]);
    });

    it('device problems use dot-path field names', async () => {
      expect(await detailsOf(body(token, { device: undefined }))).toEqual([{ field: 'device', reason: 'REQUIRED' }]);
      expect(await detailsOf(body(token, { device: { ...device, platform: 'WINDOWS' } }))).toEqual([{ field: 'device.platform', reason: 'NOT_ALLOWED' }]);
      expect(await detailsOf(body(token, { device: { ...device, appVersion: '1.4' } }))).toEqual([{ field: 'device.appVersion', reason: 'INVALID_FORMAT' }]);
      expect(await detailsOf(body(token, { device: { platform: 'IOS', appVersion: '1.4.2' } }))).toEqual([{ field: 'device.deviceId', reason: 'REQUIRED' }]);
    });

    it('unknown fields are rejected, also inside device', async () => {
      const unknown = ['phoneNumber', 'otp', 'status', 'role', 'isPhoneVerified', 'isEmailVerified', 'id', 'referralCode', 'utmSource'];
      const sent = Object.fromEntries(unknown.map((name) => [name, 'x']));
      expect(await detailsOf(body(token, sent))).toEqual(unknown.sort().map((field) => ({ field, reason: 'UNKNOWN_FIELD' })));
      expect(await detailsOf(body(token, { device: { ...device, rooted: true } }))).toEqual([{ field: 'device.rooted', reason: 'UNKNOWN_FIELD' }]);
    });

    it('does nothing: the token is not consumed and no rider, device or refresh token is created', async () => {
      await register(ctx.app, body(token, { fullName: 'A' }));
      await register(ctx.app, {});
      expect(ctx.db.tables.otpSession[0].consumedAt).toBeNull();
      expect(ctx.db.tables.rider).toHaveLength(0);
      expect(ctx.db.tables.device).toHaveLength(0);
      expect(ctx.db.tables.refreshToken).toHaveLength(0);
      expect((await register(ctx.app, body(token))).res.status).toBe(201);
    });
  });

  describe('rate limit', () => {
    it('10 registers per IP per hour, the 11th is 429 RATE_LIMITED', async () => {
      for (let i = 0; i < 10; i++) {
        const { res, body: reply } = await register(ctx.app, body(newOpaqueToken()));
        expect(res.status).toBe(422);
        expect(reply.error.code).toBe('REGISTRATION_TOKEN_INVALID');
      }
      const { res, body: reply } = await register(ctx.app, body(newOpaqueToken()));
      expect(res.status).toBe(429);
      expect(reply.error).toEqual({ code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.', field: null });
    });
  });

  describe('end to end: send-otp, verify-otp, register, then log in again', () => {
    const verifyBody = (otp = FAKE_CODE) => ({ phoneNumber: PHONE, otp, device });

    // The registration-token flow is gone from verify-otp (decision 162): it now creates the rider and
    // returns tokens. This test is rewritten with the complete-profile step of register (next step).
    it.skip('a new phone registers, and the next verify-otp for the same phone returns tokens (isNewRider false)', async () => {
      // 1. send-otp
      const sent = await call(ctx.app, 'send-otp', { phoneNumber: PHONE });
      expect(sent.res.status).toBe(200);

      // 2. verify-otp: the phone has no rider, so the reply is a registration token
      const verified = await call(ctx.app, 'verify-otp', verifyBody());
      expect(verified.res.status).toBe(200);
      expect(verified.body.data.isNewRider).toBe(true);
      const registrationToken = verified.body.data.registrationToken;
      expect(registrationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(ctx.db.tables.rider).toHaveLength(0);

      // 3. register with that token
      ctx.advance(20 * SECOND);
      const registered = await register(ctx.app, body(registrationToken, { email: 'asha@example.com' }));
      expect(registered.res.status).toBe(201);
      const riderId = registered.body.data.rider.id;
      expect(registered.body.data.rider.phoneNumber).toBe(PHONE);
      expect(ctx.db.tables.otpSession[0].consumedAt).not.toBeNull();

      // the token cannot be used a second time
      expect((await register(ctx.app, body(registrationToken))).res.status).toBe(422);

      // 4. later: send-otp and verify-otp again for the same phone is a login, not a sign-up
      ctx.advance(60 * SECOND);
      expect((await call(ctx.app, 'send-otp', { phoneNumber: PHONE })).res.status).toBe(200);
      const login = await call(ctx.app, 'verify-otp', verifyBody());
      expect(login.res.status).toBe(200);
      expect(login.body.data.isNewRider).toBe(false);
      expect(login.body.data.rider.id).toBe(riderId);
      expect(login.body.data.tokens.refreshToken).not.toBe(registered.body.data.tokens.refreshToken);
      expect(login.body.data.tokens.accessToken.split('.')).toHaveLength(3);
      // one device, and exactly one unrevoked refresh token (the register one was revoked by the login)
      expect(ctx.db.tables.rider).toHaveLength(1);
      expect(ctx.db.tables.device).toHaveLength(1);
      expect(ctx.db.tables.refreshToken).toHaveLength(2);
      expect(ctx.db.tables.refreshToken.filter((r) => r.revokedAt === null)).toHaveLength(1);
    });
  });
});
