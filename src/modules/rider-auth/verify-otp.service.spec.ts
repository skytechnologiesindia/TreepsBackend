import { AppException } from '../../common/errors/app.exception.js';
import { verifyHs256Jwt } from '../../common/jwt/hs256-jwt.js';
import { sha256Hex } from '../../common/tokens.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { AccessTokenService } from '../../common/jwt/access-token.service.js';
import type { VerifyOtpDto } from '../otp/dto/verify-otp.dto.js';
import type { OtpProvider } from '../otp/provider/otp-provider.js';
import { InMemoryAuthDb } from './testing/in-memory-auth-db.js';
import { VerifyOtpService } from './verify-otp.service.js';

const PHONE = '+919477172214';
const SECRET = 'placeholder-jwt-secret-0123456789abcdef';
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
  const service = new VerifyOtpService(db as unknown as PrismaService, provider, () => new Date(now), new AccessTokenService(SECRET));
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
      status: 'ACTIVE',
      isPhoneVerified: true,
      isEmailVerified: false,
      isProfileComplete: false,
      createdAt: '2026-01-02T03:04:05.678Z',
    });
    expect(result.tokens.accessTokenExpiresInSeconds).toBe(900);
    expect(result.tokens.refreshTokenExpiresInSeconds).toBe(2_592_000);
    expect(result.tokens.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // session: code used and session finished
    expect(session.verifiedAt.getTime()).toBe(T0);
    expect(session.consumedAt.getTime()).toBe(T0);
    expect(session.attempts).toBe(1);
    // rider: lastLoginAt set
    expect(rider.lastLoginAt.getTime()).toBe(T0);
    // one device, one refresh token that stores only the hash
    expect(ctx.db.tables.device).toHaveLength(1);
    expect(ctx.db.tables.device[0]).toMatchObject({ riderId: rider.id, deviceId: 'device-1', platform: 'ANDROID', appVersion: '1.4.2', fcmToken: null });
    expect(ctx.db.tables.refreshToken).toHaveLength(1);
    const stored = ctx.db.tables.refreshToken[0];
    expect(stored.tokenHash).toBe(sha256Hex(result.tokens.refreshToken));
    expect(stored.tokenHash).not.toBe(result.tokens.refreshToken);
    expect(JSON.stringify(ctx.db.tables.refreshToken)).not.toContain(result.tokens.refreshToken);
    expect(stored.expiresAt.getTime()).toBe(T0 + 2_592_000 * SECOND);
    expect(stored.revokedAt).toBeNull();
  });

  it('issues an HS256 access token with the documented claims and a 15 minute life', async () => {
    const ctx = setup();
    const rider = ctx.db.addRider();
    ctx.session();
    const result = await ctx.service.verifyOtp(dto());
    if (result.isNewRider) throw new Error('unreachable');
    const claims = verifyHs256Jwt(result.tokens.accessToken, SECRET, T0 / 1000);
    expect(claims).toEqual({ iss: 'treeps', sub: rider.id, role: 'RIDER', deviceId: 'device-1', iat: T0 / 1000, exp: T0 / 1000 + 900 });
    expect(() => verifyHs256Jwt(result.tokens.accessToken, SECRET, T0 / 1000 + 900)).toThrow(/expired/);
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
      expect(rows).toHaveLength(2);
      expect(rows.filter((r) => r.revokedAt === null)).toHaveLength(1);
      expect(rows.find((r) => r.tokenHash === sha256Hex(first.tokens.refreshToken))!.revokedAt).not.toBeNull();
      expect(rows.find((r) => r.tokenHash === sha256Hex(second.tokens.refreshToken))!.revokedAt).toBeNull();
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
  it('replies isNewRider with a one-time registration token and stores only its hash', async () => {
    const ctx = setup();
    const session = ctx.session();
    const result = await ctx.service.verifyOtp(dto());
    expect(result.isNewRider).toBe(true);
    if (!result.isNewRider) throw new Error('unreachable');
    expect(result.registrationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.registrationTokenExpiresInSeconds).toBe(600);
    expect(session.registrationTokenHash).toBe(sha256Hex(result.registrationToken));
    expect(session.registrationTokenHash).not.toBe(result.registrationToken);
    expect(session.registrationExpiresAt.getTime()).toBe(T0 + 10 * MINUTE);
    expect(session.verifiedAt.getTime()).toBe(T0);
    expect(session.consumedAt).toBeNull();
    expect(ctx.db.tables.rider).toHaveLength(0);
    expect(ctx.db.tables.device).toHaveLength(0);
    expect(ctx.db.tables.refreshToken).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('if saving the token fails, the code is NOT burned: it is still usable on the next try', async () => {
    const ctx = setup();
    const session = ctx.session();
    // Fail whichever write stores the registration token hash. Marking the code used must not
    // happen in a separate earlier write, or this failure would burn the code.
    ctx.db.failWhen = (_operation, args) => args.data?.registrationTokenHash !== undefined;
    await expect(ctx.service.verifyOtp(dto())).rejects.toThrow('injected database failure');
    expect(session.verifiedAt).toBeNull();
    expect(session.registrationTokenHash).toBeNull();
    expect(session.registrationExpiresAt).toBeNull();

    ctx.db.failWhen = null;
    const retry = await ctx.service.verifyOtp(dto());
    expect(retry.isNewRider).toBe(true);
    if (!retry.isNewRider) throw new Error('unreachable');
    expect(session.verifiedAt.getTime()).toBe(T0);
    expect(session.registrationTokenHash).toBe(sha256Hex(retry.registrationToken));
  });

  it('each call gets a different token', async () => {
    const ctx = setup();
    ctx.session();
    ctx.session({ phoneNumber: '+919477172215' });
    const a = await ctx.service.verifyOtp(dto());
    const b = await ctx.service.verifyOtp(dto({ phoneNumber: '+919477172215' }));
    if (!a.isNewRider || !b.isNewRider) throw new Error('unreachable');
    expect(a.registrationToken).not.toBe(b.registrationToken);
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
