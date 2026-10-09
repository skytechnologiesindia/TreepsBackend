import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { CLOCK } from '../../common/clock.js';
import { RateLimiter } from '../../common/rate-limit/rate-limiter.js';
import { setupApp } from '../../common/setup-app.js';
import { rawBaseUrl, versionedBaseUrl } from '../../common/testing/base-url.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SessionService } from '../../common/session/session.service.js';
import { newOpaqueToken } from '../../common/tokens.js';
import { FakeOtpProvider } from '../otp/provider/fake-otp.provider.js';
import { OTP_PROVIDER } from '../otp/provider/otp-provider.js';
import { SendOtpService } from '../otp/send-otp.service.js';
import { RegisterService } from './register.service.js';
import { RiderAuthController } from './rider-auth.controller.js';
import { InMemoryAuthDb } from './testing/in-memory-auth-db.js';
import { VerifyOtpService } from './verify-otp.service.js';

const PHONE = '+919477172214';
const FAKE_CODE = '123456';
const T0 = new Date('2026-10-05T10:00:00.000Z').getTime();
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const device = { deviceId: 'device-1', platform: 'ANDROID', appVersion: '1.4.2' };

// Real HTTP, real pipe, filter, interceptors and guards (the session guard included). The database and
// the clock are test stand-ins; the OTP provider is the real FakeOtpProvider.
async function startApp() {
  let now = T0;
  const db = new InMemoryAuthDb();
  const sessions = new SessionService(db as unknown as PrismaService);
  const moduleRef = await Test.createTestingModule({
    controllers: [RiderAuthController],
    providers: [
      SendOtpService,
      VerifyOtpService,
      RegisterService,
      SessionService,
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
    // A rider that verify-otp created (no name, no email, PROFILE_PENDING) and a RIDER access token.
    // A rider that verify-otp created: no name, no email, PROFILE_PENDING, plus a real session token.
    async pendingRider(overrides: Record<string, unknown> = {}) {
      const rider = db.addRider({ phoneNumber: PHONE, fullName: null, registeredCity: null, registeredState: null, status: 'PROFILE_PENDING', ...overrides });
      const token = (await sessions.create({ role: 'RIDER', accountId: rider.id as string, deviceId: 'device-1', now: new Date(now) })).accessToken;
      return { rider, token };
    },
    riderToken: async (accountId: string) => (await sessions.create({ role: 'RIDER', accountId, deviceId: 'device-1', now: new Date(now) })).accessToken,
    driverToken: async () => (await sessions.create({ role: 'DRIVER', accountId: 'driver-1', deviceId: 'device-1', now: new Date(now) })).accessToken,
  };
}
type Ctx = Awaited<ReturnType<typeof startApp>>;

async function call(app: INestApplication, path: string, payload: unknown, auth?: string, base: 'versioned' | 'raw' = 'versioned') {
  const url = `${base === 'versioned' ? versionedBaseUrl(app) : rawBaseUrl(app)}/rider/auth/${path}`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth !== undefined) headers.authorization = auth;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  return { res, body: await res.json() };
}
// `token` is the bare access token; it is sent as "Bearer <token>".
const register = (app: INestApplication, payload: unknown, token?: string, base: 'versioned' | 'raw' = 'versioned') =>
  call(app, 'register', payload, token === undefined ? undefined : `Bearer ${token}`, base);
const body = (overrides: Record<string, unknown> = {}) => ({ fullName: 'Asha Verma', ...overrides });

describe('POST /v1/rider/auth/register (complete profile)', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await startApp();
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  describe('success', () => {
    it('a valid token completes the profile: 200, standard envelope, ACTIVE, isProfileComplete true, no tokens', async () => {
      const { rider, token } = await ctx.pendingRider();
      const { res, body: reply } = await register(ctx.app, body({ email: 'asha@example.com', registeredCity: ' Ranchi ' }), token);
      expect(res.status).toBe(200);
      expect(reply.success).toBe(true);
      expect(Object.keys(reply).sort()).toEqual(['data', 'requestId', 'success']);
      expect(reply.requestId).toMatch(UUID_V4);
      expect(reply.requestId).toBe(res.headers.get('x-request-id'));
      expect(Object.keys(reply.data)).toEqual(['rider']);
      expect(reply.data.rider).toMatchObject({
        id: rider.id,
        fullName: 'Asha Verma',
        phoneNumber: PHONE,
        email: 'asha@example.com',
        registeredCity: 'Ranchi',
        registeredState: null,
        status: 'ACTIVE',
        isPhoneVerified: true,
        isEmailVerified: false,
        isProfileComplete: true,
      });
      expect(ctx.db.tables.rider).toHaveLength(1);
      expect(ctx.db.tables.rider[0]).toMatchObject({ status: 'ACTIVE', isProfileComplete: true, fullName: 'Asha Verma' });
    });

    it('has the same rider keys as verify-otp', async () => {
      const { token } = await ctx.pendingRider();
      const completed = (await register(ctx.app, body(), token)).body.data.rider;
      await call(ctx.app, 'send-otp', { phoneNumber: '+919477172299' });
      const verified = await call(ctx.app, 'verify-otp', { phoneNumber: '+919477172299', otp: FAKE_CODE, device });
      expect(Object.keys(completed).sort()).toEqual(Object.keys(verified.body.data.rider).sort());
    });

    it('is not served without the /v1 prefix (NOT_FOUND)', async () => {
      const { token } = await ctx.pendingRider();
      const { res, body: reply } = await register(ctx.app, body(), token, 'raw');
      expect(res.status).toBe(404);
      expect(reply.error.code).toBe('NOT_FOUND');
    });

    it.each(['Anita Kumari', "O'Brien", 'Dr. Singh', 'Mary-Jane', 'अनीता कुमारी'])('accepts the name %s', async (fullName) => {
      const { token } = await ctx.pendingRider();
      const { res, body: reply } = await register(ctx.app, body({ fullName }), token);
      expect(res.status).toBe(200);
      expect(reply.data.rider.fullName).toBe(fullName);
    });

    it.each([
      ['omitted', {}],
      ['null', { registeredCity: null, registeredState: null }],
      ['whitespace only', { registeredCity: '   ', registeredState: '\t ' }],
    ])('city and state %s on a new profile are stored as null', async (_name, extra) => {
      const { token } = await ctx.pendingRider();
      const { res, body: reply } = await register(ctx.app, body(extra), token);
      expect(res.status).toBe(200);
      expect(reply.data.rider.registeredCity).toBeNull();
      expect(reply.data.rider.registeredState).toBeNull();
    });
  });

  describe('called twice', () => {
    it('saves the new values again and returns the current rider, no error', async () => {
      const { rider, token } = await ctx.pendingRider();
      const first = await register(ctx.app, body({ email: 'asha@example.com' }), token);
      expect(first.res.status).toBe(200);
      const second = await register(ctx.app, body({ fullName: 'Asha Kumari', email: 'asha@example.com', registeredCity: 'Ranchi' }), token);
      expect(second.res.status).toBe(200);
      expect(second.body.data.rider).toMatchObject({ id: rider.id, fullName: 'Asha Kumari', email: 'asha@example.com', registeredCity: 'Ranchi', status: 'ACTIVE', isProfileComplete: true });
      expect(ctx.db.tables.rider).toHaveLength(1);
      expect(ctx.db.tables.rider[0].fullName).toBe('Asha Kumari');
    });

    it('the rider can change to a different email', async () => {
      const { token } = await ctx.pendingRider();
      await register(ctx.app, body({ email: 'a@example.com' }), token);
      const { body: reply } = await register(ctx.app, body({ email: 'b@example.com' }), token);
      expect(reply.data.rider.email).toBe('b@example.com');
    });

    it('a changed email resets isEmailVerified to false', async () => {
      const { token } = await ctx.pendingRider({ email: 'a@example.com', isEmailVerified: true });
      const { body: reply } = await register(ctx.app, body({ email: 'b@example.com' }), token);
      expect(reply.data.rider).toMatchObject({ email: 'b@example.com', isEmailVerified: false });
      expect(ctx.db.tables.rider[0].isEmailVerified).toBe(false);
    });

    it('city and state: sent means saved, omitted keeps the stored value', async () => {
      const { token } = await ctx.pendingRider({ registeredCity: 'Ranchi', registeredState: 'Jharkhand' });
      const kept = await register(ctx.app, body(), token);
      expect(kept.body.data.rider).toMatchObject({ registeredCity: 'Ranchi', registeredState: 'Jharkhand' });
      const changed = await register(ctx.app, body({ registeredCity: ' Dhanbad ' }), token);
      expect(changed.body.data.rider).toMatchObject({ registeredCity: 'Dhanbad', registeredState: 'Jharkhand' });
    });

    it('null or blank city and state do not clear the stored values (clearing is not supported)', async () => {
      const { token } = await ctx.pendingRider({ registeredCity: 'Ranchi', registeredState: 'Jharkhand' });
      const { res, body: reply } = await register(ctx.app, body({ registeredCity: null, registeredState: '   ' }), token);
      expect(res.status).toBe(200);
      expect(reply.data.rider).toMatchObject({ registeredCity: 'Ranchi', registeredState: 'Jharkhand' });
    });

    it('the same email sent again keeps isEmailVerified', async () => {
      const { token } = await ctx.pendingRider({ email: 'a@example.com', isEmailVerified: true });
      const { body: reply } = await register(ctx.app, body({ fullName: 'Asha Kumari', email: 'a@example.com' }), token);
      expect(reply.data.rider).toMatchObject({ fullName: 'Asha Kumari', email: 'a@example.com', isEmailVerified: true });
    });

    it('an omitted email stays as it was (not wiped), and isEmailVerified is untouched', async () => {
      const { token } = await ctx.pendingRider({ email: 'a@example.com', isEmailVerified: true });
      const { res, body: reply } = await register(ctx.app, body({ fullName: 'Asha Kumari' }), token);
      expect(res.status).toBe(200);
      expect(reply.data.rider).toMatchObject({ fullName: 'Asha Kumari', email: 'a@example.com', isEmailVerified: true });
    });

    it('an email taken by another rider on the second call is EMAIL_IN_USE and the old email stays', async () => {
      ctx.db.addRider({ phoneNumber: '+919477172299', email: 'taken@example.com' });
      const { token } = await ctx.pendingRider({ email: 'a@example.com' });
      const { res, body: reply } = await register(ctx.app, body({ email: 'taken@example.com' }), token);
      expect(res.status).toBe(409);
      expect(reply.error.code).toBe('EMAIL_IN_USE');
      expect(ctx.db.tables.rider.find((r) => r.phoneNumber === PHONE)!.email).toBe('a@example.com');
    });
  });

  describe('a unique-index violation after the pre-check (a parallel call took the email)', () => {
    it('is EMAIL_IN_USE 409 with field email, never a 500', async () => {
      const { token } = await ctx.pendingRider();
      // The pre-check finds nobody; the write then hits the unique index, as in a real race.
      const real = ctx.db.rider.findUnique;
      ctx.db.rider.findUnique = (async (args: { where: Record<string, unknown> }) => ('email' in args.where ? null : real(args))) as typeof real;
      ctx.db.addRider({ phoneNumber: '+919477172299', email: 'raced@example.com' });
      const { res, body: reply } = await register(ctx.app, body({ email: 'raced@example.com' }), token);
      expect(res.status).toBe(409);
      expect(reply.error).toEqual({ code: 'EMAIL_IN_USE', message: 'This email is already in use.', field: 'email' });
      expect(ctx.db.tables.rider.find((r) => r.phoneNumber === PHONE)!.status).toBe('PROFILE_PENDING');
    });
  });

  describe('the access token: 401 UNAUTHORIZED', () => {
    const expected = { code: 'UNAUTHORIZED', message: 'Please log in again.', field: null };

    it('no Authorization header', async () => {
      await ctx.pendingRider();
      const { res, body: reply } = await register(ctx.app, body());
      expect(res.status).toBe(401);
      expect(reply.success).toBe(false);
      expect(reply.error).toEqual(expected);
      expect(reply.requestId).toMatch(UUID_V4);
    });

    it.each([
      ['an empty bearer', 'Bearer '],
      ['a non-Bearer scheme', 'Basic abc'],
      ['not a token', 'Bearer not-a-token'],
      ['two parts only', 'Bearer aaa.bbb'],
      ['garbage parts', 'Bearer a.b.c'],
    ])('malformed token: %s', async (_name, header) => {
      await ctx.pendingRider();
      const { res, body: reply } = await call(ctx.app, 'register', body(), header);
      expect(res.status).toBe(401);
      expect(reply.error).toEqual(expected);
    });

    it('expired session (30 days pass without use)', async () => {
      const { token } = await ctx.pendingRider();
      ctx.advance(30 * 24 * 60 * 60_000 + 1000);
      const { res, body: reply } = await register(ctx.app, body(), token);
      expect(res.status).toBe(401);
      expect(reply.error).toEqual(expected);
      expect(ctx.db.tables.rider[0].status).toBe('PROFILE_PENDING');
    });

    it('an unknown but well-formed token', async () => {
      await ctx.pendingRider();
      const { res, body: reply } = await register(ctx.app, body(), newOpaqueToken());
      expect(res.status).toBe(401);
      expect(reply.error).toEqual(expected);
    });

    it('a session for a rider that no longer exists is 401 and its sessions are deleted', async () => {
      const token = await ctx.riderToken('rider-gone');
      expect((await register(ctx.app, body(), token)).res.status).toBe(401);
      expect(ctx.db.tables.refreshToken).toHaveLength(0);
    });

    it('a token for a rider that no longer exists', async () => {
      const { res, body: reply } = await register(ctx.app, body(), await ctx.riderToken('rider-gone'));
      expect(res.status).toBe(401);
      expect(reply.error).toEqual(expected);
    });

    it('is checked before the body: a bad body without a token is 401, not 400', async () => {
      expect((await register(ctx.app, {})).res.status).toBe(401);
    });
  });

  describe('the wrong domain: 403 FORBIDDEN', () => {
    it('a DRIVER token on a rider route', async () => {
      await ctx.pendingRider();
      const { res, body: reply } = await register(ctx.app, body(), await ctx.driverToken());
      expect(res.status).toBe(403);
      expect(reply.error).toEqual({ code: 'FORBIDDEN', message: "You don't have access to this.", field: null });
      expect(ctx.db.tables.rider[0].status).toBe('PROFILE_PENDING');
    });
  });

  describe('account state', () => {
    it.each(['SUSPENDED', 'BLOCKED', 'DELETED'])('a %s rider is ACCOUNT_BANNED (403) and nothing changes', async (status) => {
      const { token } = await ctx.pendingRider({ status });
      const { res, body: reply } = await register(ctx.app, body(), token);
      expect(res.status).toBe(403);
      expect(reply.error).toEqual({ code: 'ACCOUNT_BANNED', message: "This account can't book rides.", field: null });
      expect(ctx.db.tables.rider[0]).toMatchObject({ status, fullName: null, isProfileComplete: false });
      expect(ctx.db.tables.refreshToken).toHaveLength(0); // the guard deleted the sessions
      expect((await register(ctx.app, body(), token)).res.status).toBe(401); // and the token is dead now
    });
  });

  describe('logout', () => {
    const logout = async (token?: string) => {
      const headers: Record<string, string> = {};
      if (token !== undefined) headers.authorization = `Bearer ${token}`;
      const res = await fetch(`${versionedBaseUrl(ctx.app)}/rider/auth/logout`, { method: 'POST', headers });
      return { res, body: await res.json() };
    };

    it('200 { loggedOut: true }, and the token is dead after', async () => {
      const { token } = await ctx.pendingRider();
      const out = await logout(token);
      expect(out.res.status).toBe(200);
      expect(out.body).toMatchObject({ success: true, data: { loggedOut: true } });
      expect(ctx.db.tables.refreshToken).toHaveLength(0);
      expect((await register(ctx.app, body(), token)).res.status).toBe(401);
      expect((await logout(token)).res.status).toBe(401); // already unknown: 401 like any guarded route
    });

    it('no token is 401 and a DRIVER token is 403', async () => {
      expect((await logout()).res.status).toBe(401);
      expect((await logout(await ctx.driverToken())).res.status).toBe(403);
    });

    it('ends only this device: the same rider on another device keeps their session', async () => {
      const { rider, token } = await ctx.pendingRider();
      const other = (await new SessionService(ctx.db as unknown as PrismaService).create({ role: 'RIDER', accountId: rider.id as string, deviceId: 'device-2', now: new Date(T0) })).accessToken;
      await logout(token);
      expect((await register(ctx.app, body(), other)).res.status).toBe(200);
    });
  });

  describe('conflicts: 409', () => {
    it('EMAIL_IN_USE with field email when another rider has it', async () => {
      ctx.db.addRider({ phoneNumber: '+919477172299', email: 'taken@example.com' });
      const { token } = await ctx.pendingRider();
      const { res, body: reply } = await register(ctx.app, body({ email: 'taken@example.com' }), token);
      expect(res.status).toBe(409);
      expect(reply.error).toEqual({ code: 'EMAIL_IN_USE', message: 'This email is already in use.', field: 'email' });
      expect(ctx.db.tables.rider.find((r) => r.phoneNumber === PHONE)!.status).toBe('PROFILE_PENDING');
    });
  });

  describe('invalid input: 400 INVALID_INPUT, and nothing is written', () => {
    let token: string;
    beforeEach(async () => {
      token = (await ctx.pendingRider()).token;
    });
    const detailsOf = async (payload: unknown) => {
      const { res, body: reply } = await register(ctx.app, payload, token);
      expect(res.status).toBe(400);
      expect(reply.error.code).toBe('INVALID_INPUT');
      return reply.error.details;
    };

    it('missing fullName is REQUIRED', async () => {
      expect(await detailsOf({})).toEqual([{ field: 'fullName', reason: 'REQUIRED' }]);
    });

    it('fullName', async () => {
      const name = (fullName: unknown) => detailsOf(body({ fullName }));
      expect(await name('A')).toEqual([{ field: 'fullName', reason: 'TOO_SHORT' }]);
      expect(await name('A'.repeat(101))).toEqual([{ field: 'fullName', reason: 'TOO_LONG' }]);
      expect(await name('Anita1')).toEqual([{ field: 'fullName', reason: 'INVALID_FORMAT' }]);
      expect(await name(' Anita')).toEqual([{ field: 'fullName', reason: 'INVALID_FORMAT' }]);
      expect(await name('Anita  Kumari')).toEqual([{ field: 'fullName', reason: 'INVALID_FORMAT' }]);
      expect(await name('Mary--Jane')).toEqual([{ field: 'fullName', reason: 'INVALID_FORMAT' }]);
      expect(await name(7)).toEqual([{ field: 'fullName', reason: 'WRONG_TYPE' }]);
    });

    it('email', async () => {
      const email = (value: unknown) => detailsOf(body({ email: value }));
      expect(await email('Anita@example.com')).toEqual([{ field: 'email', reason: 'INVALID_FORMAT' }]);
      expect(await email('anita @example.com')).toEqual([{ field: 'email', reason: 'INVALID_FORMAT' }]);
      expect(await email('anita@example')).toEqual([{ field: 'email', reason: 'INVALID_FORMAT' }]);
      expect(await email('a'.repeat(250) + '@b.co')).toEqual([{ field: 'email', reason: 'TOO_LONG' }]);
      expect(await email(null)).toEqual([{ field: 'email', reason: 'WRONG_TYPE' }]);
    });

    it('city and state', async () => {
      expect(await detailsOf(body({ registeredCity: '' }))).toEqual([{ field: 'registeredCity', reason: 'TOO_SHORT' }]);
      expect(await detailsOf(body({ registeredState: 5 }))).toEqual([{ field: 'registeredState', reason: 'WRONG_TYPE' }]);
      expect(await detailsOf(body({ registeredCity: 'a'.repeat(101) }))).toEqual([{ field: 'registeredCity', reason: 'TOO_LONG' }]);
    });

    it('unknown fields, including the old registrationToken and device, are rejected', async () => {
      const unknown = ['registrationToken', 'device', 'phoneNumber', 'otp', 'status', 'role', 'isProfileComplete', 'isPhoneVerified', 'id'];
      const sent = Object.fromEntries(unknown.map((name) => [name, 'x']));
      expect(await detailsOf(body(sent))).toEqual([...unknown].sort().map((field) => ({ field, reason: 'UNKNOWN_FIELD' })));
    });

    it('writes nothing', async () => {
      await register(ctx.app, body({ fullName: 'A' }), token);
      expect(ctx.db.tables.rider[0]).toMatchObject({ status: 'PROFILE_PENDING', fullName: null, isProfileComplete: false });
    });
  });

  describe('rate limit', () => {
    it('10 registers per IP per hour, the 11th is 429 RATE_LIMITED', async () => {
      const { token } = await ctx.pendingRider();
      for (let i = 0; i < 10; i++) expect((await register(ctx.app, body(), token)).res.status).toBe(200);
      const { res, body: reply } = await register(ctx.app, body(), token);
      expect(res.status).toBe(429);
      expect(reply.error).toEqual({ code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.', field: null });
    });

    it('a refused token does not use up the limit (the session guard runs first)', async () => {
      for (let i = 0; i < 12; i++) expect((await register(ctx.app, body())).res.status).toBe(401);
      const { token } = await ctx.pendingRider();
      expect((await register(ctx.app, body(), token)).res.status).toBe(200);
    });
  });

  describe('end to end: send-otp, verify-otp, then complete the profile', () => {
    it('a new phone gets an account and tokens from verify-otp, then register completes it', async () => {
      expect((await call(ctx.app, 'send-otp', { phoneNumber: PHONE })).res.status).toBe(200);
      const verified = await call(ctx.app, 'verify-otp', { phoneNumber: PHONE, otp: FAKE_CODE, device });
      expect(verified.res.status).toBe(200);
      expect(verified.body.data.isNewRider).toBe(true);
      expect(verified.body.data.rider).toMatchObject({ status: 'PROFILE_PENDING', isProfileComplete: false, fullName: null });

      const done = await register(ctx.app, body({ email: 'asha@example.com' }), verified.body.data.tokens.accessToken);
      expect(done.res.status).toBe(200);
      expect(done.body.data.rider).toMatchObject({ id: verified.body.data.rider.id, status: 'ACTIVE', isProfileComplete: true, email: 'asha@example.com' });
      expect(ctx.db.tables.rider).toHaveLength(1);
    });
  });
});
