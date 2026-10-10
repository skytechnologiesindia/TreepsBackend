import { AppException } from '../../common/errors/app.exception.js';
import { SessionService } from '../../common/session/session.service.js';
import { sha256Hex } from '../../common/tokens.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { VerifyOtpDto } from '../otp/dto/verify-otp.dto.js';
import type { OtpProvider } from '../otp/provider/otp-provider.js';
import { InMemoryAuthDb } from '../rider-auth/testing/in-memory-auth-db.js';
import { VerifyOtpService } from '../rider-auth/verify-otp.service.js';
import { DriverVerifyOtpService } from './driver-verify-otp.service.js';

const PHONE = '+919477172214';
const T0 = new Date('2026-10-05T10:00:00.000Z').getTime();
const SECOND = 1000;
const MINUTE = 60 * SECOND;

function setup() {
  const now = T0;
  const db = new InMemoryAuthDb();
  const codes: Record<string, string> = {}; // provider session id -> its correct code
  let providerCalls = 0;
  const provider: OtpProvider = {
    async send() {
      return { providerSessionId: 'unused' };
    },
    async verify(sessionId, otp) {
      providerCalls += 1;
      return codes[sessionId] === otp;
    },
  };
  const sessions = new SessionService(db as unknown as PrismaService);
  const clock = () => new Date(now);
  return {
    db,
    driver: new DriverVerifyOtpService(db as unknown as PrismaService, provider, clock, sessions),
    sessions,
    rider: new VerifyOtpService(db as unknown as PrismaService, provider, clock, sessions),
    providerCalls: () => providerCalls,
    // A code sent a minute ago, valid for four more minutes, for the given purpose.
    session(purpose: 'DRIVER_AUTH' | 'RIDER_AUTH' = 'DRIVER_AUTH', overrides: Record<string, unknown> = {}, code = '123456') {
      const id = `fake-session-${db.tables.otpSession.length + 1}`;
      codes[id] = code;
      return db.addSession({ phoneNumber: PHONE, purpose, providerSessionId: id, createdAt: new Date(now - MINUTE), expiresAt: new Date(now + 4 * MINUTE), ...overrides });
    },
  };
}

const dto = (overrides: Partial<VerifyOtpDto> = {}, device: Partial<VerifyOtpDto['device']> = {}): VerifyOtpDto => ({
  phoneNumber: PHONE,
  otp: '123456',
  device: { deviceId: 'device-1', platform: 'ANDROID', appVersion: '1.4.2', ...device },
  ...overrides,
});

async function errorOf(promise: Promise<unknown>): Promise<AppException | undefined> {
  try {
    await promise;
  } catch (error) {
    return error as AppException;
  }
  return undefined;
}

describe('DriverVerifyOtpService: a new phone', () => {
  it('creates the driver (DOCUMENTS_PENDING, phone verified), the device and a hashed refresh token, and replies with tokens and no registration token', async () => {
    const ctx = setup();
    ctx.session();
    const result = await ctx.driver.verifyOtp(dto());

    expect(result.isNewDriver).toBe(true);
    expect(Object.keys(result).sort()).toEqual(['driver', 'isNewDriver', 'tokens']); // no registrationToken
    expect(Object.keys(result.driver).sort()).toEqual(['createdAt', 'id', 'phoneNumber', 'status']);
    expect(result.driver).toMatchObject({ phoneNumber: PHONE, status: 'DOCUMENTS_PENDING', createdAt: '2026-10-05T10:00:00.000Z' });
    expect(ctx.db.tables.driver).toHaveLength(1);
    expect(ctx.db.tables.driver[0]).toMatchObject({ isPhoneVerified: true, status: 'DOCUMENTS_PENDING' });
    expect(ctx.db.tables.driver[0].lastLoginAt.getTime()).toBe(T0);
    expect(ctx.db.tables.driverDevice).toHaveLength(1);
    expect(ctx.db.tables.driverDevice[0]).toMatchObject({ driverId: result.driver.id, deviceId: 'device-1', platform: 'ANDROID', appVersion: '1.4.2', fcmToken: null });
    expect(ctx.db.tables.driverRefreshToken).toHaveLength(1);
    const stored = ctx.db.tables.driverRefreshToken[0];
    expect(stored.tokenHash).toBe(sha256Hex(result.tokens.accessToken));
    expect(JSON.stringify(ctx.db.tables.driverRefreshToken)).not.toContain(result.tokens.accessToken);
    expect(stored.expiresAt.getTime()).toBe(T0 + 2_592_000 * SECOND);
    expect(Object.keys(result.tokens).sort()).toEqual(['accessToken', 'expiresInSeconds']);
    expect(result.tokens.expiresInSeconds).toBe(2_592_000);
    // the code is used and the session is finished; no rider rows were touched
    expect(ctx.db.tables.otpSession[0].verifiedAt.getTime()).toBe(T0);
    expect(ctx.db.tables.otpSession[0].consumedAt.getTime()).toBe(T0);
    expect(ctx.db.tables.otpSession[0].registrationTokenHash).toBeNull();
    expect(ctx.db.tables.rider).toHaveLength(0);
    expect(ctx.db.tables.refreshToken).toHaveLength(0);
  });
});

describe('DriverVerifyOtpService: an existing driver', () => {
  it('logs in: tokens, lastLoginAt set, no second driver', async () => {
    const ctx = setup();
    const existing = ctx.db.addDriver();
    ctx.session();
    const result = await ctx.driver.verifyOtp(dto());
    expect(result.isNewDriver).toBe(false);
    expect(result.driver).toEqual({ id: existing.id, phoneNumber: PHONE, status: 'APPROVED', createdAt: '2026-01-02T03:04:05.678Z' });
    expect(ctx.db.tables.driver).toHaveLength(1);
    expect(existing.lastLoginAt.getTime()).toBe(T0);
    expect(ctx.db.tables.driverDevice).toHaveLength(1);
    expect(ctx.db.tables.driverRefreshToken).toHaveLength(1);
    expect(ctx.db.tables.otpSession[0].consumedAt.getTime()).toBe(T0);
  });

  it.each(['SUSPENDED', 'BLOCKED', 'DELETED'])('%s gets ACCOUNT_BANNED (403), no tokens, and the session is finished', async (status) => {
    const ctx = setup();
    const existing = ctx.db.addDriver({ status });
    ctx.session();
    const error = await errorOf(ctx.driver.verifyOtp(dto()));
    expect(error?.code).toBe('ACCOUNT_BANNED');
    expect(error?.getStatus()).toBe(403);
    expect(ctx.db.tables.driverDevice).toHaveLength(0);
    expect(ctx.db.tables.driverRefreshToken).toHaveLength(0);
    expect(existing.lastLoginAt).toBeNull();
    expect(ctx.db.tables.otpSession[0].verifiedAt).not.toBeNull();
    expect(ctx.db.tables.otpSession[0].consumedAt.getTime()).toBe(T0);
  });
});

describe('DriverVerifyOtpService: the code', () => {
  it('a wrong code is OTP_INVALID (422, field otp), the attempt stays used, and no driver is created', async () => {
    const ctx = setup();
    const session = ctx.session();
    const error = await errorOf(ctx.driver.verifyOtp(dto({ otp: '000000' })));
    expect(error?.code).toBe('OTP_INVALID');
    expect(error?.getStatus()).toBe(422);
    expect(error?.field).toBe('otp');
    expect(session.attempts).toBe(1);
    expect(ctx.db.tables.driver).toHaveLength(0);
  });

  it('an expired code is OTP_EXPIRED and does not call the provider', async () => {
    const ctx = setup();
    ctx.session('DRIVER_AUTH', { expiresAt: new Date(T0 - 1) });
    expect((await errorOf(ctx.driver.verifyOtp(dto())))?.code).toBe('OTP_EXPIRED');
    expect(ctx.providerCalls()).toBe(0);
    expect(ctx.db.tables.driver).toHaveLength(0);
  });

  it('a used code is OTP_INVALID: the same code twice creates one driver and one token', async () => {
    const ctx = setup();
    ctx.session();
    await ctx.driver.verifyOtp(dto());
    expect((await errorOf(ctx.driver.verifyOtp(dto())))?.code).toBe('OTP_INVALID');
    expect(ctx.db.tables.driver).toHaveLength(1);
    expect(ctx.db.tables.driverRefreshToken).toHaveLength(1);
  });
});

describe('rider and driver codes are not interchangeable', () => {
  it('a RIDER_AUTH session does NOT work on the driver route: OTP_INVALID, no provider call, no driver', async () => {
    const ctx = setup();
    const riderSession = ctx.session('RIDER_AUTH');
    expect((await errorOf(ctx.driver.verifyOtp(dto())))?.code).toBe('OTP_INVALID');
    expect(ctx.providerCalls()).toBe(0);
    expect(ctx.db.tables.driver).toHaveLength(0);
    expect(riderSession.attempts).toBe(0);
    expect(riderSession.verifiedAt).toBeNull();
  });

  it('a DRIVER_AUTH session does NOT work on the rider route: OTP_INVALID, no provider call, no registration token', async () => {
    const ctx = setup();
    const driverSession = ctx.session('DRIVER_AUTH');
    expect((await errorOf(ctx.rider.verifyOtp(dto())))?.code).toBe('OTP_INVALID');
    expect(ctx.providerCalls()).toBe(0);
    expect(driverSession.attempts).toBe(0);
    expect(driverSession.verifiedAt).toBeNull();
    expect(driverSession.registrationTokenHash).toBeNull();
  });
});

describe('DriverVerifyOtpService: a failure part-way leaves nothing half-created', () => {
  // The in-memory transaction rolls every table back when the callback throws, like Postgres. After a
  // rollback the table arrays are new objects, so read them through ctx.db, not through old row references.
  it.each(['otpSession.updateMany', 'driver.create', 'driverDevice.upsert', 'driverRefreshToken.create'])(
    'a database failure at %s: no driver, device, token or used code remains, and the code still works',
    async (failing) => {
      const ctx = setup();
      ctx.session();
      // otpSession.updateMany is also the attempt reservation, so fail only the write that marks the code used.
      if (failing === 'otpSession.updateMany') {
        ctx.db.failWhen = (operation, args) => operation === failing && args.data?.consumedAt !== undefined;
      } else {
        ctx.db.failOn = failing;
      }
      await expect(ctx.driver.verifyOtp(dto())).rejects.toThrow('injected database failure');
      expect(ctx.db.tables.driver).toHaveLength(0);
      expect(ctx.db.tables.driverDevice).toHaveLength(0);
      expect(ctx.db.tables.driverRefreshToken).toHaveLength(0);
      expect(ctx.db.tables.otpSession[0].verifiedAt).toBeNull();
      expect(ctx.db.tables.otpSession[0].consumedAt).toBeNull();

      ctx.db.failOn = null;
      ctx.db.failWhen = null;
      const retry = await ctx.driver.verifyOtp(dto());
      expect(retry.isNewDriver).toBe(true);
      expect(ctx.db.tables.driver).toHaveLength(1);
    },
  );

  it('a unique violation on the phone (another session created the driver first) is CONFLICT and the code stays usable', async () => {
    const ctx = setup();
    ctx.session();
    let done = false;
    ctx.db.failWhen = (operation) => {
      if (operation === 'driver.create' && !done) {
        done = true;
        ctx.db.addDriver({ phoneNumber: PHONE }); // the other registration wins just before our insert
      }
      return false;
    };
    const error = await errorOf(ctx.driver.verifyOtp(dto()));
    expect(error?.code).toBe('CONFLICT');
    expect(error?.getStatus()).toBe(409);
    expect(ctx.db.tables.otpSession[0].verifiedAt).toBeNull();
  });
});

describe('the session role', () => {
  it('is DRIVER for a driver and RIDER for a rider, so the two are never interchangeable', async () => {
    const ctx = setup();
    ctx.session('DRIVER_AUTH');
    const driverResult = await ctx.driver.verifyOtp(dto());
    const driverSession = await ctx.sessions.findByToken(driverResult.tokens.accessToken, new Date(T0));
    expect(driverSession).toMatchObject({ role: 'DRIVER', accountId: driverResult.driver.id, deviceId: 'device-1' });

    const other = setup();
    const rider = other.db.addRider();
    other.session('RIDER_AUTH');
    const riderResult = await other.rider.verifyOtp(dto());
    const riderSession = await other.sessions.findByToken(riderResult.tokens.accessToken, new Date(T0));
    expect(riderSession).toMatchObject({ role: 'RIDER', accountId: rider.id });
    expect(riderSession!.role).not.toBe(driverSession!.role);
  });
});

describe('one active session per driver (decision 174)', () => {
  let n = 0;
  const newer = () => ({ createdAt: new Date(T0 - 50 * SECOND + ++n * SECOND) });
  it('a login on a second device deletes the first device session and device row at once', async () => {
    const ctx = setup();
    ctx.session('DRIVER_AUTH', newer());
    const first = await ctx.driver.verifyOtp(dto({}, { deviceId: 'phone-1' }));
    ctx.session('DRIVER_AUTH', newer());
    const second = await ctx.driver.verifyOtp(dto({}, { deviceId: 'phone-2' }));
    expect(second.isNewDriver).toBe(false);
    expect(await ctx.sessions.findByToken(first.tokens.accessToken, new Date(T0))).toBeNull();
    expect(await ctx.sessions.findByToken(second.tokens.accessToken, new Date(T0))).not.toBeNull();
    expect(ctx.db.tables.driverRefreshToken).toHaveLength(1);
    expect(ctx.db.tables.driverDevice.map((d) => d.deviceId)).toEqual(['phone-2']);
  });

  it('logging in again on the same device replaces its session', async () => {
    const ctx = setup();
    ctx.session('DRIVER_AUTH', newer());
    const first = await ctx.driver.verifyOtp(dto());
    ctx.session('DRIVER_AUTH', newer());
    const second = await ctx.driver.verifyOtp(dto());
    expect(await ctx.sessions.findByToken(first.tokens.accessToken, new Date(T0))).toBeNull();
    expect(await ctx.sessions.findByToken(second.tokens.accessToken, new Date(T0))).not.toBeNull();
    expect(ctx.db.tables.driverDevice).toHaveLength(1);
  });

  it('another driver keeps their session', async () => {
    const ctx = setup();
    ctx.db.addDriver({ phoneNumber: '+919477172299' });
    ctx.session('DRIVER_AUTH', { phoneNumber: '+919477172299', ...newer() });
    const other = await ctx.driver.verifyOtp(dto({ phoneNumber: '+919477172299' }, { deviceId: 'other-phone' }));
    ctx.session('DRIVER_AUTH', newer());
    await ctx.driver.verifyOtp(dto({}, { deviceId: 'phone-1' }));
    ctx.session('DRIVER_AUTH', newer());
    await ctx.driver.verifyOtp(dto({}, { deviceId: 'phone-2' }));
    expect(await ctx.sessions.findByToken(other.tokens.accessToken, new Date(T0))).not.toBeNull();
  });

  it('riders are unchanged: a second rider device keeps the first session', async () => {
    const ctx = setup();
    ctx.db.addRider();
    ctx.session('RIDER_AUTH', newer());
    const first = await ctx.rider.verifyOtp(dto({}, { deviceId: 'phone-1' }));
    ctx.session('RIDER_AUTH', newer());
    const second = await ctx.rider.verifyOtp(dto({}, { deviceId: 'phone-2' }));
    expect(await ctx.sessions.findByToken(first.tokens.accessToken, new Date(T0))).not.toBeNull();
    expect(await ctx.sessions.findByToken(second.tokens.accessToken, new Date(T0))).not.toBeNull();
    expect(ctx.db.tables.refreshToken).toHaveLength(2);
  });
});

describe('DriverVerifyOtpService: device row (platform, appVersion, fcmToken)', () => {
  const login = async (ctx: ReturnType<typeof setup>, device: Partial<VerifyOtpDto['device']> = {}) => {
    ctx.session('DRIVER_AUTH', { createdAt: new Date(T0 - 30 * SECOND + ctx.db.tables.otpSession.length) });
    return ctx.driver.verifyOtp(dto({}, device));
  };

  it('a first login stores platform, appVersion and fcmToken on the driver device row', async () => {
    const ctx = setup();
    await login(ctx, { platform: 'IOS', appVersion: '2.0.0-beta.1', fcmToken: 'tok-1' });
    expect(ctx.db.tables.driverDevice).toHaveLength(1);
    expect(ctx.db.tables.driverDevice[0]).toMatchObject({ deviceId: 'device-1', platform: 'IOS', appVersion: '2.0.0-beta.1', fcmToken: 'tok-1' });
  });

  it('each later login refreshes the same row; a missing or null fcmToken never wipes the stored one; a new one replaces it', async () => {
    const ctx = setup();
    await login(ctx, { fcmToken: 'tok-1' });
    await login(ctx, { platform: 'IOS', appVersion: '1.5.0' });
    expect(ctx.db.tables.driverDevice).toHaveLength(1);
    expect(ctx.db.tables.driverDevice[0]).toMatchObject({ platform: 'IOS', appVersion: '1.5.0', fcmToken: 'tok-1' });
    await login(ctx, { fcmToken: null });
    expect(ctx.db.tables.driverDevice[0].fcmToken).toBe('tok-1');
    await login(ctx, { fcmToken: 'tok-2' });
    expect(ctx.db.tables.driverDevice).toHaveLength(1);
    expect(ctx.db.tables.driverDevice[0].fcmToken).toBe('tok-2');
  });

  it('a new driver without an fcmToken has null', async () => {
    const ctx = setup();
    await login(ctx);
    expect(ctx.db.tables.driverDevice[0].fcmToken).toBeNull();
  });

  it('the reply has no device field and never the fcmToken', async () => {
    const ctx = setup();
    const result = await login(ctx, { fcmToken: 'SECRET-TOKEN-123' });
    const text = JSON.stringify(result.driver);
    for (const forbidden of ['SECRET-TOKEN-123', 'fcmToken', 'appVersion', 'platform']) expect(text).not.toContain(forbidden);
  });

  it('lastLoginAt is set on every successful login', async () => {
    const ctx = setup();
    await login(ctx);
    expect(ctx.db.tables.driver[0].lastLoginAt.getTime()).toBe(T0);
  });
});
