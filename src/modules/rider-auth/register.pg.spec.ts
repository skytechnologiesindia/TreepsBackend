import type { PrismaService } from '../../prisma/prisma.service.js';
import type { RegisterDto } from './dto/register.dto.js';
import { RegisterService } from './register.service.js';
import { emptyRiderAuthTables, openScratchDb, PG_TESTS_ENABLED, SCRATCH_DB_NAME, type ScratchDb } from './testing/scratch-db.js';

// Race tests against REAL Postgres, because only a real database has real unique indexes. They are
// skipped unless RUN_PG_TESTS=1 and use only the scratch database named in testing/scratch-db.ts,
// never treeps_db. How to run: docs/api/rider-register.md, "Race tests".
describe.skipIf(!PG_TESTS_ENABLED)(`POST /v1/rider/auth/register email race, real Postgres (${SCRATCH_DB_NAME})`, () => {
  let db: ScratchDb;
  let phoneCounter = 0;
  const nextPhone = () => `+91900001${String(++phoneCounter).padStart(4, '0')}`;

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

  const pendingRider = (overrides: Record<string, unknown> = {}) =>
    db.prisma.rider.create({ data: { phoneNumber: nextPhone(), status: 'PROFILE_PENDING', isPhoneVerified: true, ...overrides } });

  // Holds every caller of rider.updateMany until `callers` of them have arrived. The reads and the
  // email pre-check run before it, so every request has passed them: the race is forced to happen at
  // the write, where the unique index decides.
  function raceOf(callers: number) {
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const rider = new Proxy(db.prisma.rider, {
      get(target, property, receiver) {
        if (property !== 'updateMany') return Reflect.get(target, property, receiver);
        return async (args: Parameters<typeof target.updateMany>[0]) => {
          if (++arrived >= callers) release();
          await gate;
          return target.updateMany(args);
        };
      },
    });
    const prisma = new Proxy(db.prisma, {
      get: (target, property, receiver) => (property === 'rider' ? rider : Reflect.get(target, property, receiver)),
    });
    return new RegisterService(prisma as unknown as PrismaService, () => new Date(), { get: () => 'test-terms-v1' } as never);
  }

  const dto = (overrides: Partial<RegisterDto> = {}): RegisterDto => ({ fullName: 'Asha Verma', gender: 'FEMALE', ...overrides });
  const outcome = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return 'OK';
    } catch (error: any) {
      return error.code ?? `OTHER:${error.message}`;
    }
  };

  it('two riders completing with one email: exactly one wins, the other is EMAIL_IN_USE (not a 500) and stays PROFILE_PENDING', async () => {
    const a = await pendingRider();
    const b = await pendingRider();
    const service = raceOf(2);
    const results = await Promise.all([
      outcome(service.completeProfile(a.id, dto({ email: 'same@example.com' }))),
      outcome(service.completeProfile(b.id, dto({ email: 'same@example.com' }))),
    ]);
    expect(results.sort()).toEqual(['EMAIL_IN_USE', 'OK']);
    const rows = await db.prisma.rider.findMany({ where: { email: 'same@example.com' } });
    expect(rows).toHaveLength(1);
    const loser = await db.prisma.rider.findFirstOrThrow({ where: { email: null } });
    expect(loser).toMatchObject({ status: 'PROFILE_PENDING', isProfileComplete: false, fullName: null });
  });

  it('eight riders racing for one email: exactly one wins', async () => {
    const riders = await Promise.all(Array.from({ length: 8 }, () => pendingRider()));
    const service = raceOf(8);
    const results = await Promise.all(riders.map((r) => outcome(service.completeProfile(r.id, dto({ email: 'one@example.com' })))));
    expect(results.filter((r) => r === 'OK')).toHaveLength(1);
    expect(results.filter((r) => r === 'EMAIL_IN_USE')).toHaveLength(7);
    expect(await db.prisma.rider.count({ where: { email: 'one@example.com' } })).toBe(1);
  });

  it('the same rider calling twice at once with the same email: both succeed', async () => {
    const a = await pendingRider();
    const service = raceOf(2);
    const results = await Promise.all([outcome(service.completeProfile(a.id, dto({ email: 'me@example.com' }))), outcome(service.completeProfile(a.id, dto({ email: 'me@example.com' })))]);
    expect(results).toEqual(['OK', 'OK']);
    expect(await db.prisma.rider.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ email: 'me@example.com', status: 'ACTIVE', isProfileComplete: true });
  });

  it('a changed email resets isEmailVerified; an omitted email stays', async () => {
    const a = await pendingRider({ email: 'old@example.com', isEmailVerified: true });
    const service = raceOf(1);
    await service.completeProfile(a.id, dto());
    expect(await db.prisma.rider.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ email: 'old@example.com', isEmailVerified: true });
    await service.completeProfile(a.id, dto({ email: 'new@example.com' }));
    expect(await db.prisma.rider.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ email: 'new@example.com', isEmailVerified: false });
  });

  it('the database unique on email is case-sensitive (why the API only accepts lowercase)', async () => {
    await pendingRider({ email: 'case@example.com' });
    await expect(pendingRider({ email: 'Case@example.com' })).resolves.toBeDefined();
  });
});
