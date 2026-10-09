import { SessionService } from '../../common/session/session.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { VerifyOtpDto } from '../otp/dto/verify-otp.dto.js';
import { FakeOtpProvider } from '../otp/provider/fake-otp.provider.js';
import { emptyRiderAuthTables, openScratchDb, PG_TESTS_ENABLED, SCRATCH_RIDER_VERIFY_DB_NAME, type ScratchDb } from './testing/scratch-db.js';
import { VerifyOtpService } from './verify-otp.service.js';

// Race test against REAL Postgres, because only a real database has row locks and real unique
// indexes. Skipped unless RUN_PG_TESTS=1; uses only the scratch database named below, never
// treeps_db. How to run: docs/api/rider-verify-otp.md, "Race tests".
const CODE = '123456';

describe.skipIf(!PG_TESTS_ENABLED)(`POST /v1/rider/auth/verify-otp races, real Postgres (${SCRATCH_RIDER_VERIFY_DB_NAME})`, () => {
  let db: ScratchDb;
  let phoneCounter = 0;
  const nextPhone = () => `+91900002${String(++phoneCounter).padStart(4, '0')}`;

  beforeAll(async () => {
    db = await openScratchDb(SCRATCH_RIDER_VERIFY_DB_NAME);
    await emptyRiderAuthTables(db);
  }, 120_000);
  afterAll(async () => {
    await emptyRiderAuthTables(db);
    await db.close();
  });
  beforeEach(async () => {
    await emptyRiderAuthTables(db);
  });

  const serviceOver = (prisma: unknown) =>
    new VerifyOtpService(prisma as PrismaService, new FakeOtpProvider(CODE), () => new Date(), new SessionService(prisma as PrismaService));

  // Holds every caller of $transaction until `callers` of them have arrived. The code check and the
  // rider lookup run before the transaction, so by then every request has already passed them: the
  // race is forced to happen inside the transaction, where the row lock and the unique index decide.
  function raceOf(callers: number) {
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    return serviceOver(
      new Proxy(db.prisma, {
        get(target, property, receiver) {
          if (property !== '$transaction') return Reflect.get(target, property, receiver);
          return async (fn: (tx: any) => Promise<unknown>) => {
            if (++arrived >= callers) release();
            await gate;
            return target.$transaction((tx) => fn(tx));
          };
        },
      }),
    );
  }

  async function session(phoneNumber: string) {
    const now = Date.now();
    return db.prisma.otpSession.create({
      data: { phoneNumber, purpose: 'RIDER_AUTH', providerSessionId: 'fake-session-1', expiresAt: new Date(now + 4 * 60_000), createdAt: new Date(now - 10_000) },
    });
  }

  const dto = (phoneNumber: string): VerifyOtpDto => ({ phoneNumber, otp: CODE, device: { deviceId: 'device-1', platform: 'ANDROID', appVersion: '1.4.2' } });
  const outcome = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return 'OK';
    } catch (error: any) {
      return error.code ?? `OTHER:${error.message}`;
    }
  };

  it('two simultaneous verifies for a new phone create exactly one Rider (ten rounds, never two)', async () => {
    for (let round = 1; round <= 10; round++) {
      const phone = nextPhone();
      const created = await session(phone);
      const service = raceOf(2);
      const results = await Promise.all([outcome(service.verifyOtp(dto(phone))), outcome(service.verifyOtp(dto(phone)))]);
      expect(results.sort()).toEqual(['OK', 'OTP_INVALID']);
      expect(await db.prisma.rider.count({ where: { phoneNumber: phone } })).toBe(1);
      const row = await db.prisma.otpSession.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.verifiedAt).not.toBeNull();
      expect(row.consumedAt).not.toBeNull();
    }
    expect(await db.prisma.rider.count()).toBe(10);
    expect(await db.prisma.device.count()).toBe(10);
    expect(await db.prisma.refreshToken.count()).toBe(10);
    const rider = await db.prisma.rider.findFirstOrThrow();
    expect(rider).toMatchObject({ status: 'PROFILE_PENDING', fullName: null, email: null, isPhoneVerified: true, isProfileComplete: false });
    expect(rider.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('a phone that got a Rider between the lookup and the insert is CONFLICT, and the rolled-back code is still usable', async () => {
    const phone = nextPhone();
    const created = await session(phone);
    await db.prisma.rider.create({ data: { phoneNumber: phone, status: 'PROFILE_PENDING', isPhoneVerified: true } });
    // The rider lookup is made to answer "no rider", as it would have just before a parallel request created one.
    const blind = new Proxy(db.prisma, {
      get(target, property, receiver) {
        if (property !== 'rider') return Reflect.get(target, property, receiver);
        return new Proxy(target.rider, { get: (rider, name, rcv) => (name === 'findUnique' ? async () => null : Reflect.get(rider, name, rcv)) });
      },
    });
    expect(await outcome(serviceOver(blind).verifyOtp(dto(phone)))).toBe('CONFLICT');
    expect(await db.prisma.rider.count({ where: { phoneNumber: phone } })).toBe(1);
    expect(await db.prisma.device.count()).toBe(0);
    expect(await db.prisma.refreshToken.count()).toBe(0);
    const row = await db.prisma.otpSession.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.verifiedAt).toBeNull(); // rolled back with the transaction
    expect(row.consumedAt).toBeNull();
  });
});
