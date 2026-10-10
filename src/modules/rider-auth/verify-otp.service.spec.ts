import { AppException } from '../../common/errors/app.exception.js';
import { sha256Hex } from '../../common/tokens.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { SessionService } from '../../common/session/session.service.js';
import type { VerifyOtpDto } from '../otp/dto/verify-otp.dto.js';
import type { OtpProvider } from '../otp/provider/otp-provider.js';
import { InMemoryAuthDb } from './testing/in-memory-auth-db.js';
import { VerifyOtpService } from './verify-otp.service.js';

const PHONE = '+919477172214';
const T0 = new Date('2026-10-05T10:00:00.000Z').getTime();
const SECOND = 1000;
const MINUTE = 60 * SECOND;

function setup() {
  let now = T0;
  const db = new InMemoryAuthDb();
  const codes: Record<string, string> = {}; // provider session id -> its correct code
  const providerCalls: Array<[string, string]> = [];
  let providerFails = false;
  const provider: OtpProvider = {
    async send() {
      return { providerSessionId: 'unused' };
    },
    async verify(sessionId, otp) {
      providerCalls.push([sessionId, otp]);
      if (providerFails) throw new Error('SECRET-provider-down');
      return codes[sessionId] === otp;
    },
  };
  const service = new VerifyOtpService(db as unknown as PrismaService, provider, () => new Date(now), new SessionService(db as unknown as PrismaService));
  return {
    db,
    service,
    providerCalls,
    failProvider: () => (providerFails = true),
    advance: (ms: number) => (now += ms),
    now: () => now,
    // A session sent a minute ago, still valid for four more minutes.
    session(overrides: Record<string, unknown> = {}, code = '123456') {
      const id = (overrides.providerSessionId as string) ?? `fake-session-${db.tables.otpSession.length + 1}`;
      codes[id] = code;
      return db.addSession({
        phoneNumber: PHONE,
        providerSessionId: id,
        createdAt: new Date(now - MINUTE),
        expiresAt: new Date(now + 4 * MINUTE),
        ...overrides,
      });
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
const codeOf = async (promise: Promise<unknown>) => (await errorOf(promise))?.code ?? 'NO_ERROR';

describe('VerifyOtpService: login (an ACTIVE rider)', () => {
  it('returns the rider and tokens, and changes only what the doc says', async () => {
    const ctx = setup();
    const rider = ctx.db.addRider();
    const session = ctx.session();
    const result = await ctx.service.verifyOtp(dto());

    expect(result.isNewRider).toBe(false);
    if (result.isNewRider) throw new Error('unreachable');
    expect(result.rider).toEqual({
      id: rider.id,
      fullName: 'Asha Verma',
      phoneNumber: PHONE,
      email: null,
      registeredCity: 'Ranchi',
      registeredState: 'Jharkhand',
      registeredAddress: null,
      termsAcceptedAt: null,
      termsVersion: null,
      status: 'ACTIVE',
      isPhoneVerified: true,
      isEmailVerified: false,
      isProfileComplete: false,
      createdAt: '2026-01-02T03:04:05.678Z',
    });
    expect(Object.keys(result.tokens).sort()).toEqual(['accessToken', 'expiresInSeconds']);
    expect(result.tokens.expiresInSeconds).toBe(2_592_000);
    expect(result.tokens.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // session: code used and session finished
    expect(session.verifiedAt.getTime()).toBe(T0);
    expect(session.consumedAt.getTime()).toBe(T0);
    expect(session.attempts).toBe(1);
    // rider: lastLoginAt set
    expect(rider.lastLoginAt.getTime()).toBe(T0);
    // one device, one session that stores only the hash
    expect(ctx.db.tables.device).toHaveLength(1);
    expect(ctx.db.tables.device[0]).toMatchObject({ riderId: rider.id, deviceId: 'device-1', platform: 'ANDROID', appVersion: '1.4.2', fcmToken: null });
    expect(ctx.db.tables.refreshToken).toHaveLength(1);
    const stored = ctx.db.tables.refreshToken[0];
    expect(stored.tokenHash).toBe(sha256Hex(result.tokens.accessToken));
    expect(stored.tokenHash).not.toBe(result.tokens.accessToken);
    expect(JSON.stringify(ctx.db.tables.refreshToken)).not.toContain(result.tokens.accessToken);
    expect(stored.expiresAt.getTime()).toBe(T0 + 2_592_000 * SECOND);
    expect(stored.revokedAt).toBeNull();
  });

  it('the session token resolves to this rider and device through SessionService', async () => {
    const ctx = setup();
    const rider = ctx.db.addRider();
    ctx.session();
    const result = await ctx.service.verifyOtp(dto());
    const found = await new SessionService(ctx.db as unknown as PrismaService).findByToken(result.tokens.accessToken, new Date(T0));
    expect(found).toMatchObject({ role: 'RIDER', accountId: rider.id, deviceId: 'device-1' });
  });

  it('never returns the provider session id, attempts, token hashes, deletedAt or lastLoginAt', async () => {
    const ctx = setup();
    ctx.db.addRider();
    ctx.session({ providerSessionId: 'SECRET-SESSION' });
    const text = JSON.stringify(await ctx.service.verifyOtp(dto()));
    for (const forbidden of ['SECRET-SESSION', 'attempts', 'tokenHash', 'deletedAt', 'lastLoginAt', 'registrationTokenHash', 'verifiedAt']) {
      expect(text).not.toContain(forbidden);
    }
  });

  describe('devices', () => {
    async function login(ctx: ReturnType<typeof setup>, device: Partial<VerifyOtpDto['device']> = {}) {
      ctx.session();
      ctx.advance(1000);
      const result = await ctx.service.verifyOtp(dto({}, device));
      if (result.isNewRider) throw new Error('unreachable');
      return result;
    }

    it('a second login from the same device revokes the first token and leaves exactly one unrevoked', async () => {
      const ctx = setup();
      ctx.db.addRider();
      const first = await login(ctx);
      const second = await login(ctx);
      const rows = ctx.db.tables.refreshToken;
      // the same device keeps one session: the first token is gone, the second works
      expect(rows).toHaveLength(1);
      expect(rows[0].tokenHash).toBe(sha256Hex(second.tokens.accessToken));
      expect(rows[0].tokenHash).not.toBe(sha256Hex(first.tokens.accessToken));
      expect(ctx.db.tables.device).toHaveLength(1);
    });

    it('a login from a new device leaves both devices\' tokens valid', async () => {
      const ctx = setup();
      ctx.db.addRider();
      await login(ctx, { deviceId: 'device-1' });
      await login(ctx, { deviceId: 'device-2', platform: 'IOS' });
      expect(ctx.db.tables.device).toHaveLength(2);
      expect(ctx.db.tables.refreshToken.filter((r) => r.revokedAt === null)).toHaveLength(2);
    });

    it('updates the device on a repeat login and keeps fcmToken unless a new one is sent', async () => {
      const ctx = setup();
      ctx.db.addRider();
      await login(ctx, { fcmToken: 'token-one' });
      await login(ctx, { appVersion: '1.5.0' });
      expect(ctx.db.tables.device[0]).toMatchObject({ appVersion: '1.5.0', fcmToken: 'token-one' });
      await login(ctx, { fcmToken: 'token-two' });
      expect(ctx.db.tables.device[0].fcmToken).toBe('token-two');
      expect(ctx.db.tables.device[0].lastSeenAt.getTime()).toBe(ctx.now());
    });

    it('refreshes platform on the same row, and a null fcmToken does not wipe the stored one', async () => {
      const ctx = setup();
      ctx.db.addRider();
      await login(ctx, { fcmToken: 'token-one' });
      await login(ctx, { platform: 'IOS', fcmToken: null });
      expect(ctx.db.tables.device).toHaveLength(1);
      expect(ctx.db.tables.device[0]).toMatchObject({ platform: 'IOS', fcmToken: 'token-one' });
    });

    it('lastLoginAt moves forward on every successful login', async () => {
      const ctx = setup();
      const rider = ctx.db.addRider();
      await login(ctx);
      expect(rider.lastLoginAt.getTime()).toBe(ctx.now());
      ctx.advance(2 * MINUTE);
      await login(ctx);
      expect(rider.lastLoginAt.getTime()).toBe(ctx.now());
    });
  });

  it('if the transaction fails, no device, token, consumedAt or lastLoginAt remains (the code stays used)', async () => {
    const ctx = setup();
    const rider = ctx.db.addRider();
    const session = ctx.session();
    ctx.db.failOn = 'refreshToken.create';
    await expect(ctx.service.verifyOtp(dto())).rejects.toThrow('injected database failure');
    expect(ctx.db.tables.device).toHaveLength(0);
    expect(ctx.db.tables.refreshToken).toHaveLength(0);
    expect(rider.lastLoginAt).toBeNull();
    expect(session.consumedAt).toBeNull();
    expect(session.verifiedAt).not.toBeNull(); // documented: the rider asks for a new code
  });
});

describe('VerifyOtpService: a phone with no rider', () => {
  it('creates a PROFILE_PENDING rider, device and hashed refresh token, and replies like a login', async () => {
    const ctx = setup();
    const session = ctx.session();
    const result = await ctx.service.verifyOtp(dto());

    expect(result.isNewRider).toBe(true);
    expect(Object.keys(result).sort()).toEqual(['isNewRider', 'rider', 'tokens']); // same keys as a login; no registrationToken
    expect(result.rider).toMatchObject({
      fullName: null,
      phoneNumber: PHONE,
      email: null,
      registeredCity: null,
      registeredState: null,
      status: 'PROFILE_PENDING',
      isPhoneVerified: true,
      isEmailVerified: false,
      isProfileComplete: false,
      createdAt: new Date(T0).toISOString(),
    });
    expect(Object.keys(result.tokens).sort()).toEqual(['accessToken', 'expiresInSeconds']);
    expect(result.tokens.expiresInSeconds).toBe(2_592_000);
    expect(result.tokens.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    expect(ctx.db.tables.rider).toHaveLength(1);
    expect(ctx.db.tables.rider[0]).toMatchObject({ phoneNumber: PHONE, fullName: null, email: null, status: 'PROFILE_PENDING', isPhoneVerified: true, isProfileComplete: false });
    expect(ctx.db.tables.rider[0].lastLoginAt.getTime()).toBe(T0);
    expect(ctx.db.tables.device).toHaveLength(1);
    expect(ctx.db.tables.device[0]).toMatchObject({ riderId: result.rider.id, deviceId: 'device-1', platform: 'ANDROID', appVersion: '1.4.2', fcmToken: null });
    expect(ctx.db.tables.refreshToken).toHaveLength(1);
    const stored = ctx.db.tables.refreshToken[0];
    expect(stored.tokenHash).toBe(sha256Hex(result.tokens.accessToken));
    expect(JSON.stringify(ctx.db.tables.refreshToken)).not.toContain(result.tokens.accessToken);
    expect(stored.expiresAt.getTime()).toBe(T0 + 2_592_000 * SECOND);
    // the code is used and the session finished; no registration token is stored
    expect(session.verifiedAt.getTime()).toBe(T0);
    expect(session.consumedAt.getTime()).toBe(T0);
    expect(session.registrationTokenHash).toBeNull();
    expect(session.registrationExpiresAt).toBeNull();
  });

  it('the new rider session token resolves to a RIDER session', async () => {
    const ctx = setup();
    ctx.session();
    const result = await ctx.service.verifyOtp(dto());
    const found = await new SessionService(ctx.db as unknown as PrismaService).findByToken(result.tokens.accessToken, new Date(T0));
    expect(found).toMatchObject({ role: 'RIDER', accountId: result.rider.id, deviceId: 'device-1' });
  });

  it('stores fcmToken when the app sends one', async () => {
    const ctx = setup();
    ctx.session();
    await ctx.service.verifyOtp(dto({}, { fcmToken: 'token-one' }));
    expect(ctx.db.tables.device[0].fcmToken).toBe('token-one');
  });

  it('never returns the provider session id, attempts, token hashes, deletedAt or lastLoginAt', async () => {
    const ctx = setup();
    ctx.session({ providerSessionId: 'SECRET-SESSION' });
    const text = JSON.stringify(await ctx.service.verifyOtp(dto()));
    for (const forbidden of ['SECRET-SESSION', 'attempts', 'tokenHash', 'deletedAt', 'lastLoginAt', 'registrationToken', 'verifiedAt']) {
      expect(text).not.toContain(forbidden);
    }
  });

  // A failure at each step of the transaction leaves nothing, and the same code works on the next try.
  it.each([
    ['marking the code used', 'otpSession.updateMany'],
    ['creating the rider', 'rider.create'],
    ['creating the device', 'device.create'],
    ['creating the refresh token', 'refreshToken.create'],
  ])('a failure while %s leaves nothing behind and the code is still usable', async (_step, operation) => {
    const ctx = setup();
    ctx.session();
    const session = () => ctx.db.tables.otpSession[0]; // a rollback swaps the rows, so read it afresh
    // The shared checker also calls otpSession.updateMany (it reserves the attempt), so for that
    // step fail only the write that marks the code used.
    ctx.db.failWhen = (name, args) => (operation === 'otpSession.updateMany' ? name === operation && args.data?.verifiedAt !== undefined : name === operation);
    await expect(ctx.service.verifyOtp(dto())).rejects.toThrow('injected database failure');
    expect(ctx.db.tables.rider).toHaveLength(0);
    expect(ctx.db.tables.device).toHaveLength(0);
    expect(ctx.db.tables.refreshToken).toHaveLength(0);
    expect(session().verifiedAt).toBeNull();
    expect(session().consumedAt).toBeNull();

    ctx.db.failWhen = null;
    const retry = await ctx.service.verifyOtp(dto());
    expect(retry.isNewRider).toBe(true);
    expect(ctx.db.tables.rider).toHaveLength(1);
    expect(session().verifiedAt.getTime()).toBe(T0);
  });

  it('a unique violation on the phone (another session created the rider first) is CONFLICT and the code is not used', async () => {
    const ctx = setup();
    ctx.session();
    // The lookup said "no rider", then a parallel request created one before this transaction ran.
    const original = ctx.db.rider.findUnique;
    ctx.db.rider.findUnique = async (args: any) => {
      const found = await original(args);
      ctx.db.addRider({ phoneNumber: PHONE, status: 'PROFILE_PENDING', fullName: null });
      return found;
    };
    const error = await errorOf(ctx.service.verifyOtp(dto()));
    expect(error?.code).toBe('CONFLICT');
    expect(error?.getStatus()).toBe(409);
    expect(ctx.db.tables.device).toHaveLength(0);
    expect(ctx.db.tables.refreshToken).toHaveLength(0);
    expect(ctx.db.tables.otpSession[0].verifiedAt).toBeNull();
  });

  it('a repeat verify with the same code is OTP_INVALID and creates no second rider', async () => {
    const ctx = setup();
    ctx.session();
    await ctx.service.verifyOtp(dto());
    expect(await codeOf(ctx.service.verifyOtp(dto()))).toBe('OTP_INVALID');
    expect(ctx.db.tables.rider).toHaveLength(1);
  });
});

describe('VerifyOtpService: a returning PROFILE_PENDING rider', () => {
  it('logs in like any rider: isNewRider false, same rider, new tokens, no second rider', async () => {
    const ctx = setup();
    ctx.session();
    const first = await ctx.service.verifyOtp(dto());
    ctx.advance(1000);
    ctx.session();
    const second = await ctx.service.verifyOtp(dto());
    expect(second.isNewRider).toBe(false);
    expect(second.rider.id).toBe(first.rider.id);
    expect(second.rider.status).toBe('PROFILE_PENDING');
    expect(second.tokens.accessToken).not.toBe(first.tokens.accessToken);
    expect(ctx.db.tables.rider).toHaveLength(1);
  });
});

describe('VerifyOtpService: a rider who is not ACTIVE', () => {
  it.each(['SUSPENDED', 'BLOCKED', 'DELETED'])('%s gets ACCOUNT_BANNED, no tokens, and the session is finished', async (status) => {
    const ctx = setup();
    const rider = ctx.db.addRider({ status });
    const session = ctx.session();
    const error = await errorOf(ctx.service.verifyOtp(dto()));
    expect(error?.code).toBe('ACCOUNT_BANNED');
    expect(error?.getStatus()).toBe(403);
    expect(ctx.db.tables.device).toHaveLength(0);
    expect(ctx.db.tables.refreshToken).toHaveLength(0);
    expect(rider.lastLoginAt).toBeNull();
    expect(session.verifiedAt).not.toBeNull();
    expect(session.consumedAt.getTime()).toBe(T0);
  });
});

describe('VerifyOtpService: the code', () => {
  it('a wrong code is OTP_INVALID (422, field otp) and the attempt stays used', async () => {
    const ctx = setup();
    ctx.db.addRider();
    const session = ctx.session();
    const error = await errorOf(ctx.service.verifyOtp(dto({ otp: '000000' })));
    expect(error?.code).toBe('OTP_INVALID');
    expect(error?.getStatus()).toBe(422);
    expect(error?.field).toBe('otp');
    expect(session.attempts).toBe(1);
    expect(session.verifiedAt).toBeNull();
    expect(ctx.db.tables.refreshToken).toHaveLength(0);
  });

  it('after 5 wrong codes the 6th call is OTP_ATTEMPTS_EXCEEDED (429) and the provider is not called', async () => {
    const ctx = setup();
    const session = ctx.session();
    for (let i = 0; i < 5; i++) expect(await codeOf(ctx.service.verifyOtp(dto({ otp: '000000' })))).toBe('OTP_INVALID');
    expect(session.attempts).toBe(5);
    expect(ctx.providerCalls).toHaveLength(5);
    const error = await errorOf(ctx.service.verifyOtp(dto({ otp: '123456' }))); // even the right code
    expect(error?.code).toBe('OTP_ATTEMPTS_EXCEEDED');
    expect(error?.getStatus()).toBe(429);
    expect(ctx.providerCalls).toHaveLength(5);
  });

  it('an expired session is OTP_EXPIRED (422) and does not use an attempt or call the provider', async () => {
    const ctx = setup();
    const session = ctx.session();
    ctx.advance(4 * MINUTE); // expiresAt is exactly now: expired
    const error = await errorOf(ctx.service.verifyOtp(dto()));
    expect(error?.code).toBe('OTP_EXPIRED');
    expect(session.attempts).toBe(0);
    expect(ctx.providerCalls).toHaveLength(0);
  });

  it('one second before expiry still works', async () => {
    const ctx = setup();
    ctx.session();
    ctx.advance(4 * MINUTE - SECOND);
    expect((await ctx.service.verifyOtp(dto())).isNewRider).toBe(true);
  });

  it('no session at all is OTP_INVALID', async () => {
    const ctx = setup();
    expect(await codeOf(ctx.service.verifyOtp(dto()))).toBe('OTP_INVALID');
    expect(ctx.providerCalls).toHaveLength(0);
  });

  it('a session for another phone is not used', async () => {
    const ctx = setup();
    ctx.session({ phoneNumber: '+919477172215' });
    expect(await codeOf(ctx.service.verifyOtp(dto()))).toBe('OTP_INVALID');
  });

  it('a used session is OTP_INVALID', async () => {
    const ctx = setup();
    ctx.session({ verifiedAt: new Date(T0 - SECOND) });
    expect(await codeOf(ctx.service.verifyOtp(dto()))).toBe('OTP_INVALID');
    expect(ctx.providerCalls).toHaveLength(0);
  });

  it('only the newest session counts: the code of an older session is refused', async () => {
    const ctx = setup();
    ctx.session({ createdAt: new Date(T0 - 2 * MINUTE), providerSessionId: 'old' }, '111111');
    ctx.session({ createdAt: new Date(T0 - MINUTE), providerSessionId: 'new' }, '222222');
    expect(await codeOf(ctx.service.verifyOtp(dto({ otp: '111111' })))).toBe('OTP_INVALID');
    expect(ctx.providerCalls).toEqual([['new', '111111']]);
    expect((await ctx.service.verifyOtp(dto({ otp: '222222' }))).isNewRider).toBe(true);
  });

  it('repeating a successful verify gets OTP_INVALID and issues nothing more', async () => {
    const ctx = setup();
    ctx.db.addRider();
    ctx.session();
    await ctx.service.verifyOtp(dto());
    expect(await codeOf(ctx.service.verifyOtp(dto()))).toBe('OTP_INVALID');
    expect(ctx.db.tables.refreshToken).toHaveLength(1);
  });
});

describe('VerifyOtpService: provider failure', () => {
  it('is OTP_PROVIDER_ERROR (503), the attempt is given back, nothing is issued, one call, no leaked text', async () => {
    const ctx = setup();
    ctx.db.addRider();
    const session = ctx.session();
    ctx.failProvider();
    const error = await errorOf(ctx.service.verifyOtp(dto()));
    expect(error?.code).toBe('OTP_PROVIDER_ERROR');
    expect(error?.getStatus()).toBe(503);
    expect(JSON.stringify(error?.getResponse())).not.toContain('SECRET');
    expect(session.attempts).toBe(0);
    expect(session.verifiedAt).toBeNull();
    expect(ctx.providerCalls).toHaveLength(1);
    expect(ctx.db.tables.refreshToken).toHaveLength(0);
  });

  it('repeated provider failures never lock the session', async () => {
    const ctx = setup();
    const session = ctx.session();
    ctx.failProvider();
    for (let i = 0; i < 8; i++) expect(await codeOf(ctx.service.verifyOtp(dto()))).toBe('OTP_PROVIDER_ERROR');
    expect(session.attempts).toBe(0);
  });
});

describe('VerifyOtpService: races', () => {
  it('two simultaneous verifies with the right code: exactly one succeeds', async () => {
    const ctx = setup();
    ctx.db.addRider();
    ctx.session();
    const results = await Promise.allSettled([ctx.service.verifyOtp(dto()), ctx.service.verifyOtp(dto())]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as AppException).code).toBe('OTP_INVALID');
    expect(ctx.db.tables.refreshToken).toHaveLength(1);
  });

  it('20 parallel wrong guesses never use more than 5 attempts or call the provider more than 5 times', async () => {
    const ctx = setup();
    const session = ctx.session();
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => ctx.service.verifyOtp(dto({ otp: '000000' }))));
    expect(session.attempts).toBe(5);
    expect(ctx.providerCalls.length).toBeLessThanOrEqual(5);
    const codes = results.map((r) => ((r as PromiseRejectedResult).reason as AppException).code);
    expect(codes.filter((c) => c === 'OTP_INVALID')).toHaveLength(5);
    expect(codes.filter((c) => c === 'OTP_ATTEMPTS_EXCEEDED')).toHaveLength(15);
  });
});

describe('VerifyOtpService: 10 verify attempts per phone per hour', () => {
  it('is RATE_LIMITED once the sessions of the last hour hold 10 attempts, with no provider call', async () => {
    const ctx = setup();
    ctx.session({ attempts: 5, createdAt: new Date(T0 - 30 * MINUTE), expiresAt: new Date(T0 - 25 * MINUTE) });
    ctx.session({ attempts: 5, createdAt: new Date(T0 - 20 * MINUTE), expiresAt: new Date(T0 - 15 * MINUTE) });
    ctx.session({ attempts: 0 });
    const error = await errorOf(ctx.service.verifyOtp(dto()));
    expect(error?.code).toBe('RATE_LIMITED');
    expect(error?.getStatus()).toBe(429);
    expect(ctx.providerCalls).toHaveLength(0);
    expect(ctx.db.calls['otpSession.updateMany']).toBeUndefined();
  });

  it('allows the 10th attempt (9 used so far)', async () => {
    const ctx = setup();
    ctx.session({ attempts: 5, createdAt: new Date(T0 - 30 * MINUTE), expiresAt: new Date(T0 - 25 * MINUTE) });
    ctx.session({ attempts: 4 });
    expect((await ctx.service.verifyOtp(dto())).isNewRider).toBe(true);
  });

  it('ignores attempts from sessions older than an hour', async () => {
    const ctx = setup();
    ctx.session({ attempts: 5, createdAt: new Date(T0 - 2 * 60 * MINUTE), expiresAt: new Date(T0 - 115 * MINUTE) });
    ctx.session({ attempts: 5, createdAt: new Date(T0 - 90 * MINUTE), expiresAt: new Date(T0 - 85 * MINUTE) });
    ctx.session();
    expect((await ctx.service.verifyOtp(dto())).isNewRider).toBe(true);
  });

  it('does not count another phone', async () => {
    const ctx = setup();
    ctx.session({ phoneNumber: '+919477172215', attempts: 5 });
    ctx.session({ phoneNumber: '+919477172215', attempts: 5 });
    ctx.session();
    expect((await ctx.service.verifyOtp(dto())).isNewRider).toBe(true);
  });
});

describe('VerifyOtpService: only RIDER_AUTH sessions are used', () => {
  it('a driver session for the same phone is ignored: with no rider session the answer is OTP_INVALID and the provider is not called', async () => {
    const ctx = setup();
    ctx.db.addRider();
    ctx.session({ purpose: 'DRIVER_AUTH' });
    expect(await codeOf(ctx.service.verifyOtp(dto()))).toBe('OTP_INVALID');
    expect(ctx.providerCalls).toHaveLength(0);
    expect(ctx.db.tables.refreshToken).toHaveLength(0);
  });

  it('a NEWER driver session does not hide the rider session: the rider code still works', async () => {
    const ctx = setup();
    ctx.db.addRider();
    ctx.session({ createdAt: new Date(T0 - 2 * MINUTE), providerSessionId: 'rider-session' }, '111111');
    ctx.session({ createdAt: new Date(T0 - MINUTE), providerSessionId: 'driver-session', purpose: 'DRIVER_AUTH' }, '222222');
    // the driver's code does not work on the rider route, the rider's code does
    expect(await codeOf(ctx.service.verifyOtp(dto({ otp: '222222' })))).toBe('OTP_INVALID');
    const result = await ctx.service.verifyOtp(dto({ otp: '111111' }));
    expect(result.isNewRider).toBe(false);
    expect(ctx.providerCalls).toEqual([['rider-session', '222222'], ['rider-session', '111111']]);
  });

  it('driver attempts do not count toward the rider 10-per-hour limit', async () => {
    const ctx = setup();
    ctx.session({ purpose: 'DRIVER_AUTH', attempts: 5, createdAt: new Date(T0 - 30 * MINUTE), expiresAt: new Date(T0 - 25 * MINUTE) });
    ctx.session({ purpose: 'DRIVER_AUTH', attempts: 5, createdAt: new Date(T0 - 20 * MINUTE), expiresAt: new Date(T0 - 15 * MINUTE) });
    ctx.session();
    expect((await ctx.service.verifyOtp(dto())).isNewRider).toBe(true);
  });
});
