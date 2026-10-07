import { AccessTokenService } from '../../common/jwt/access-token.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { VerifyOtpDto } from '../otp/dto/verify-otp.dto.js';
import { FakeOtpProvider } from '../otp/provider/fake-otp.provider.js';
import { emptyDriverAuthTables, openScratchDb, PG_TESTS_ENABLED, SCRATCH_DRIVER_DB_NAME, type ScratchDb } from '../rider-auth/testing/scratch-db.js';
import { DriverVerifyOtpService } from './driver-verify-otp.service.js';

// Race test against REAL Postgres, because only a real database has row locks and real unique
// indexes. Skipped unless RUN_PG_TESTS=1; uses only the scratch database named below, never
// treeps_db. How to run: docs/api/driver-verify-otp.md, "Race tests".
const SECRET = 'placeholder-jwt-secret-0123456789abcdef';
const CODE = '123456';

describe.skipIf(!PG_TESTS_ENABLED)(`POST /v1/driver/auth/verify-otp races, real Postgres (${SCRATCH_DRIVER_DB_NAME})`, () => {
  let db: ScratchDb;
  let phoneCounter = 0;
  const nextPhone = () => `+91900001${String(++phoneCounter).padStart(4, '0')}`;

  beforeAll(async () => {
    db = await openScratchDb(SCRATCH_DRIVER_DB_NAME);
    await emptyDriverAuthTables(db);
  }, 120_000);
  afterAll(async () => {
    await emptyDriverAuthTables(db);
    await db.close();
  });
  beforeEach(async () => {
    await emptyDriverAuthTables(db);
  });

  // Holds every caller of $transaction until `callers` of them have arrived. The code check and the
  // driver lookup run before the transaction, so by then every request has already passed them: the
  // race is forced to happen inside the transaction, where the row lock and the unique index decide.
  function raceOf(callers: number) {
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const prisma = new Proxy(db.prisma, {
      get(target, property, receiver) {
        if (property !== '$transaction') return Reflect.get(target, property, receiver);
        return async (fn: (tx: any) => Promise<unknown>) => {
          if (++arrived >= callers) release();
          await gate;
          return target.$transaction((tx) => fn(tx));
        };
      },
    });
    return new DriverVerifyOtpService(prisma as unknown as PrismaService, new FakeOtpProvider(CODE), () => new Date(), new AccessTokenService(SECRET));
  }

  async function session(phoneNumber: string) {
    const now = Date.now();
    return db.prisma.otpSession.create({
      data: { phoneNumber, purpose: 'DRIVER_AUTH', providerSessionId: 'fake-session-1', expiresAt: new Date(now + 4 * 60_000), createdAt: new Date(now - 10_000) },
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
  const counts = async () => ({
    drivers: await db.prisma.driver.count(),
    devices: await db.prisma.driverDevice.count(),
    refreshTokens: await db.prisma.driverRefreshToken.count(),
  });

  it('two simultaneous verifies for a new phone create exactly one Driver (ten rounds, never two)', async () => {
    for (let round = 1; round <= 10; round++) {
      const phone = nextPhone();
      const created = await session(phone);
      const service = raceOf(2);
      const results = await Promise.all([outcome(service.verifyOtp(dto(phone))), outcome(service.verifyOtp(dto(phone)))]);
      expect(results.sort()).toEqual(['OK', 'OTP_INVALID']);
      expect(await db.prisma.driver.count({ where: { phoneNumber: phone } })).toBe(1);
      const row = await db.prisma.otpSession.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.verifiedAt).not.toBeNull();
      expect(row.consumedAt).not.toBeNull();
    }
    expect(await counts()).toEqual({ drivers: 10, devices: 10, refreshTokens: 10 });
    const driver = await db.prisma.driver.findFirstOrThrow();
    expect(driver).toMatchObject({ status: 'DOCUMENTS_PENDING', isPhoneVerified: true });
    expect(driver.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
