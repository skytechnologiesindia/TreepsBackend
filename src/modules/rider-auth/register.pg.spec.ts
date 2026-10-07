import { newOpaqueToken, sha256Hex } from '../../common/tokens.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { AccessTokenService } from '../../common/jwt/access-token.service.js';
import type { RegisterDto } from './dto/register.dto.js';
import { RegisterService } from './register.service.js';
import { emptyRiderAuthTables, openScratchDb, PG_TESTS_ENABLED, SCRATCH_DB_NAME, type ScratchDb } from './testing/scratch-db.js';

// Race tests against REAL Postgres, because only a real database has row locks and real unique
// indexes. They are skipped unless RUN_PG_TESTS=1 and use only the scratch database named in
// testing/scratch-db.ts, never treeps_db. How to run: docs/api/rider-register.md, "Race tests".
const SECRET = 'placeholder-jwt-secret-0123456789abcdef';
const device = { deviceId: 'device-1', platform: 'ANDROID', appVersion: '1.4.2' } as const;

describe.skipIf(!PG_TESTS_ENABLED)(`POST /v1/rider/auth/register races, real Postgres (${SCRATCH_DB_NAME})`, () => {
  let db: ScratchDb;
  let phoneCounter = 0;
  const nextPhone = () => `+91900000${String(++phoneCounter).padStart(4, '0')}`;

  beforeAll(async () => {
    db = await openScratchDb();
    await emptyRiderAuthTables(db);
  }, 120_000);
  afterAll(async () => {
    await emptyRiderAuthTables(db);
    await db.close();
  });
  beforeEach(async () => {
    await emptyRiderAuthTables(db);
  });

  // A session verify-otp finished for an unknown phone, with its registration token.
  async function session(phoneNumber: string) {
    const token = newOpaqueToken();
    const now = Date.now();
    const row = await db.prisma.otpSession.create({
      data: {
        phoneNumber,
        purpose: 'RIDER_AUTH',
        providerSessionId: 'fake-session-1',
        attempts: 1,
        expiresAt: new Date(now + 4 * 60_000),
        verifiedAt: new Date(now - 10_000),
        registrationTokenHash: sha256Hex(token),
        registrationExpiresAt: new Date(now + 10 * 60_000),
      },
    });
    return { token, id: row.id };
  }

  // Holds every caller of $transaction until `callers` of them have arrived. The pre-checks run
  // before the transaction, so by then every request has already passed them: the race is forced
  // to happen inside the transaction, where the locks and unique indexes decide.
  function raceOf(callers: number, failOnRefreshToken = false) {
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const prisma = new Proxy(db.prisma, {
      get(target, property, receiver) {
        if (property !== '$transaction') return Reflect.get(target, property, receiver);
        return async (fn: (tx: any) => Promise<unknown>) => {
          if (++arrived >= callers) release();
          await gate;
          return target.$transaction(async (tx) =>
            fn(
              failOnRefreshToken
                ? new Proxy(tx, {
                    get(t, p, r) {
                      if (p === 'refreshToken') return { create: async () => { throw new Error('injected failure'); } };
                      return Reflect.get(t, p, r);
                    },
                  })
                : tx,
            ),
          );
        };
      },
    });
    return new RegisterService(prisma as unknown as PrismaService, () => new Date(), new AccessTokenService(SECRET));
  }

  const dto = (token: string, overrides: Partial<RegisterDto> = {}): RegisterDto => ({ registrationToken: token, fullName: 'Asha Verma', device: { ...device }, ...overrides });
  const outcome = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return 'OK';
    } catch (error: any) {
      return error.code ?? `OTHER:${error.message}`;
    }
  };
  const counts = async () => ({
    riders: await db.prisma.rider.count(),
    devices: await db.prisma.device.count(),
    refreshTokens: await db.prisma.refreshToken.count(),
  });

  it('two simultaneous registrations with one token: exactly one succeeds, the other is REGISTRATION_TOKEN_INVALID', async () => {
    const { token, id } = await session(nextPhone());
    const service = raceOf(2);
    const results = await Promise.all([outcome(service.register(dto(token))), outcome(service.register(dto(token)))]);
    expect(results.sort()).toEqual(['OK', 'REGISTRATION_TOKEN_INVALID']);
    expect(await counts()).toEqual({ riders: 1, devices: 1, refreshTokens: 1 });
    expect((await db.prisma.otpSession.findUniqueOrThrow({ where: { id } })).consumedAt).not.toBeNull();
  });

  it('eight simultaneous registrations with one token: still exactly one rider', async () => {
    const { token } = await session(nextPhone());
    const service = raceOf(8);
    const results = await Promise.all(Array.from({ length: 8 }, () => outcome(service.register(dto(token)))));
    expect(results.filter((r) => r === 'OK')).toHaveLength(1);
    expect(results.filter((r) => r === 'REGISTRATION_TOKEN_INVALID')).toHaveLength(7);
    expect(await counts()).toEqual({ riders: 1, devices: 1, refreshTokens: 1 });
  });

  it('twenty rounds of two racing registrations never create two riders', async () => {
    for (let round = 0; round < 20; round++) {
      const { token } = await session(nextPhone());
      const service = raceOf(2);
      const results = await Promise.all([outcome(service.register(dto(token))), outcome(service.register(dto(token)))]);
      expect(results.sort()).toEqual(['OK', 'REGISTRATION_TOKEN_INVALID']);
    }
    expect(await counts()).toEqual({ riders: 20, devices: 20, refreshTokens: 20 });
  });

  it('two tokens for one phone: the unique phone lets exactly one win, the other is CONFLICT and its token is not consumed', async () => {
    const phone = nextPhone();
    const a = await session(phone);
    const b = await session(phone);
    const service = raceOf(2);
    const results = await Promise.all([outcome(service.register(dto(a.token))), outcome(service.register(dto(b.token)))]);
    expect(results.sort()).toEqual(['CONFLICT', 'OK']);
    expect(await counts()).toEqual({ riders: 1, devices: 1, refreshTokens: 1 });
    const consumed = await db.prisma.otpSession.findMany({ where: { consumedAt: { not: null } } });
    expect(consumed).toHaveLength(1); // the loser's consumedAt was rolled back with its transaction
  });

  it('two tokens for one email: exactly one wins, the other is EMAIL_IN_USE and can register again with another email', async () => {
    const a = await session(nextPhone());
    const b = await session(nextPhone());
    const service = raceOf(2);
    const results = await Promise.all([
      outcome(service.register(dto(a.token, { email: 'race@example.com' }))),
      outcome(service.register(dto(b.token, { email: 'race@example.com' }))),
    ]);
    expect(results.sort()).toEqual(['EMAIL_IN_USE', 'OK']);
    expect(await counts()).toEqual({ riders: 1, devices: 1, refreshTokens: 1 });

    const loser = (await db.prisma.otpSession.findMany({ where: { consumedAt: null } }))[0];
    expect(loser).toBeDefined();
    const loserToken = loser.id === a.id ? a.token : b.token;
    const retry = await new RegisterService(db.prisma as unknown as PrismaService, () => new Date(), new AccessTokenService(SECRET)).register(
      dto(loserToken, { email: 'other@example.com' }),
    );
    expect(retry.rider.email).toBe('other@example.com');
    expect(await counts()).toEqual({ riders: 2, devices: 2, refreshTokens: 2 });
  });

  it('a failure after the rider, device and consumedAt were written rolls everything back, and the token still works', async () => {
    const { token, id } = await session(nextPhone());
    const failing = raceOf(1, true);
    expect(await outcome(failing.register(dto(token)))).toBe('OTHER:injected failure');
    expect(await counts()).toEqual({ riders: 0, devices: 0, refreshTokens: 0 });
    expect((await db.prisma.otpSession.findUniqueOrThrow({ where: { id } })).consumedAt).toBeNull();

    const result = await raceOf(1).register(dto(token));
    expect(result.rider.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(await counts()).toEqual({ riders: 1, devices: 1, refreshTokens: 1 });
  });

  it('stores the rider exactly as documented, in a real row', async () => {
    const phone = nextPhone();
    const { token } = await session(phone);
    const result = await raceOf(1).register(dto(token, { email: 'asha@example.com', registeredCity: '  Ranchi ', registeredState: null }));
    const row = await db.prisma.rider.findUniqueOrThrow({ where: { id: result.rider.id } });
    expect(row).toMatchObject({ phoneNumber: phone, fullName: 'Asha Verma', email: 'asha@example.com', registeredCity: 'Ranchi', registeredState: null, status: 'ACTIVE', isPhoneVerified: true, isEmailVerified: false, isProfileComplete: false });
    expect(row.lastLoginAt).not.toBeNull();
    const stored = await db.prisma.refreshToken.findFirstOrThrow();
    expect(stored.tokenHash).toBe(sha256Hex(result.tokens.refreshToken));
    expect(stored.tokenHash).not.toBe(result.tokens.refreshToken);
  });
});
