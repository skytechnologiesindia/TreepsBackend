import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { CLOCK } from '../../common/clock.js';
import { SessionService } from '../../common/session/session.service.js';
import { RateLimiter } from '../../common/rate-limit/rate-limiter.js';
import { sha256Hex } from '../../common/tokens.js';
import { setupApp } from '../../common/setup-app.js';
import { rawBaseUrl, versionedBaseUrl } from '../../common/testing/base-url.js';
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
const T0 = new Date('2026-10-05T10:00:00.000Z').getTime();
const MINUTE = 60_000;

// Real HTTP, real pipe, filter and interceptor, with both auth controllers on one app and one
// database, so the rider/driver isolation is checked through the real routes. The database and the
// clock are test stand-ins.
async function startApp() {
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
      { provide: CLOCK, useValue: () => new Date(T0) },
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
    session: (purpose: 'DRIVER_AUTH' | 'RIDER_AUTH' = 'DRIVER_AUTH') =>
      db.addSession({ phoneNumber: PHONE, purpose, providerSessionId: 'fake-session-1', createdAt: new Date(T0 - MINUTE), expiresAt: new Date(T0 + 4 * MINUTE) }),
  };
}
type Ctx = Awaited<ReturnType<typeof startApp>>;

const body = (overrides: Record<string, unknown> = {}) => ({
  phoneNumber: PHONE,
  otp: CODE,
  device: { deviceId: 'device-1', platform: 'ANDROID', appVersion: '1.4.2' },
  ...overrides,
});

async function post(app: INestApplication, path: string, payload: unknown, base: 'versioned' | 'raw' = 'versioned') {
  const url = `${base === 'versioned' ? versionedBaseUrl(app) : rawBaseUrl(app)}/${path}`;
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  return { res, body: await res.json() };
}
const driverVerify = (app: INestApplication, payload: unknown, base: 'versioned' | 'raw' = 'versioned') => post(app, 'driver/auth/verify-otp', payload, base);
const riderVerify = (app: INestApplication, payload: unknown) => post(app, 'rider/auth/verify-otp', payload);

describe('POST /v1/driver/auth/verify-otp', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await startApp();
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  it('a new phone: 200 in the standard envelope with isNewDriver true, the driver and tokens (no registration token)', async () => {
    ctx.session();
    const { res, body: reply } = await driverVerify(ctx.app, body());
    expect(res.status).toBe(200);
    expect(reply.success).toBe(true);
    expect(Object.keys(reply).sort()).toEqual(['data', 'requestId', 'success']);
    expect(reply.requestId).toBe(res.headers.get('x-request-id'));
    expect(Object.keys(reply.data).sort()).toEqual(['driver', 'isNewDriver', 'tokens']);
    expect(reply.data.isNewDriver).toBe(true);
    expect(reply.data.driver).toEqual({ id: ctx.db.tables.driver[0].id, phoneNumber: PHONE, status: 'DOCUMENTS_PENDING', createdAt: '2026-10-05T10:00:00.000Z', createdAtIst: '05-10-2026 15:30:00' });
    expect(Object.keys(reply.data.tokens).sort()).toEqual(['accessToken', 'expiresInSeconds']);
    expect(reply.data.tokens.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(reply.data.tokens.expiresInSeconds).toBe(2_592_000);
    expect(ctx.db.tables.driverRefreshToken[0].tokenHash).toBe(sha256Hex(reply.data.tokens.accessToken));
  });

  it('an existing driver: 200 with isNewDriver false', async () => {
    const existing = ctx.db.addDriver();
    ctx.session();
    const { res, body: reply } = await driverVerify(ctx.app, body());
    expect(res.status).toBe(200);
    expect(reply.data.isNewDriver).toBe(false);
    expect(reply.data.driver.id).toBe(existing.id);
    expect(ctx.db.tables.driver).toHaveLength(1);
  });

  it.each(['SUSPENDED', 'BLOCKED', 'DELETED'])('%s: 403 ACCOUNT_BANNED with no tokens', async (status) => {
    ctx.db.addDriver({ status });
    ctx.session();
    const { res, body: reply } = await driverVerify(ctx.app, body());
    expect(res.status).toBe(403);
    expect(reply.error).toEqual({ code: 'ACCOUNT_BANNED', message: "This account can't book rides.", field: null });
    expect(ctx.db.tables.driverRefreshToken).toHaveLength(0);
  });

  it('is not served without the /v1 prefix (NOT_FOUND)', async () => {
    ctx.session();
    const { res, body: reply } = await driverVerify(ctx.app, body(), 'raw');
    expect(res.status).toBe(404);
    expect(reply.error.code).toBe('NOT_FOUND');
    expect(ctx.db.tables.driver).toHaveLength(0);
  });

  it('invalid input is 400 INVALID_INPUT with the same field names as the rider route, and nothing happens', async () => {
    const session = ctx.session();
    const detailsOf = async (payload: unknown) => (await driverVerify(ctx.app, payload)).body.error.details;
    expect(await detailsOf({})).toEqual([
      { field: 'device', reason: 'REQUIRED' },
      { field: 'otp', reason: 'REQUIRED' },
      { field: 'phoneNumber', reason: 'REQUIRED' },
    ]);
    expect(await detailsOf(body({ phoneNumber: '9477172214' }))).toEqual([{ field: 'phoneNumber', reason: 'INVALID_FORMAT' }]);
    expect(await detailsOf(body({ otp: 123456 }))).toEqual([{ field: 'otp', reason: 'WRONG_TYPE' }]);
    expect(await detailsOf(body({ device: { deviceId: 'device-1', platform: 'WINDOWS', appVersion: '1.4.2' } }))).toEqual([{ field: 'device.platform', reason: 'NOT_ALLOWED' }]);
    expect(await detailsOf(body({ status: 'APPROVED', role: 'RIDER', purpose: 'RIDER_AUTH' }))).toEqual([
      { field: 'purpose', reason: 'UNKNOWN_FIELD' },
      { field: 'role', reason: 'UNKNOWN_FIELD' },
      { field: 'status', reason: 'UNKNOWN_FIELD' },
    ]);
    expect(session.attempts).toBe(0);
    expect(ctx.db.tables.driver).toHaveLength(0);
  });

  it('wrong, expired and used codes are 422 with the rider route\'s codes', async () => {
    ctx.session();
    const wrong = await driverVerify(ctx.app, body({ otp: '000000' }));
    expect(wrong.res.status).toBe(422);
    expect(wrong.body.error).toMatchObject({ code: 'OTP_INVALID', field: 'otp' });
    expect((await driverVerify(ctx.app, body())).res.status).toBe(200);
    expect((await driverVerify(ctx.app, body())).body.error.code).toBe('OTP_INVALID'); // used
    const other = await startApp();
    other.db.addSession({ phoneNumber: PHONE, purpose: 'DRIVER_AUTH', providerSessionId: 'fake-session-1', createdAt: new Date(T0 - 6 * MINUTE), expiresAt: new Date(T0 - MINUTE) });
    expect((await driverVerify(other.app, body())).body.error.code).toBe('OTP_EXPIRED');
    await other.app.close();
  });

  describe('rider and driver codes are not interchangeable (through the real routes)', () => {
    it('a RIDER_AUTH session is refused on the driver route and creates no driver', async () => {
      const session = ctx.session('RIDER_AUTH');
      const { res, body: reply } = await driverVerify(ctx.app, body());
      expect(res.status).toBe(422);
      expect(reply.error.code).toBe('OTP_INVALID');
      expect(ctx.db.tables.driver).toHaveLength(0);
      expect(session.attempts).toBe(0);
      expect(session.verifiedAt).toBeNull();
    });

    it('a DRIVER_AUTH session is refused on the rider route and issues no registration token', async () => {
      const session = ctx.session('DRIVER_AUTH');
      const { res, body: reply } = await riderVerify(ctx.app, body());
      expect(res.status).toBe(422);
      expect(reply.error.code).toBe('OTP_INVALID');
      expect(session.attempts).toBe(0);
      expect(session.registrationTokenHash).toBeNull();
      expect(ctx.db.tables.rider).toHaveLength(0);
    });
  });
});
