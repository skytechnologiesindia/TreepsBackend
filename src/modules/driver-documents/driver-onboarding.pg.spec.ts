import type { FileStorage } from '../../common/storage/file-storage.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { openScratchDb, PG_TESTS_ENABLED, SCRATCH_ONBOARDING_DB_NAME, type ScratchDb } from '../rider-auth/testing/scratch-db.js';
import { DriverDocumentService } from './driver-documents.service.js';
import type { OnboardingDataDto } from './driver-onboarding.dto.js';
import { DriverOnboardingService, type UploadedPhotos } from './driver-onboarding.service.js';
import { PHOTO_PART_NAMES } from './onboarding-rules.js';

// Real Postgres, because only a real database proves the composite upsert, the enum and DATE columns,
// the text-array column, and the double-tap race. Skipped unless RUN_PG_TESTS=1; uses only the scratch
// database named below, never treeps_db.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const day = (years: number) => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
};

class FakeStorage implements FileStorage {
  files = new Map<string, Buffer>();
  async save(path: string, data: Buffer) {
    this.files.set(path, data);
  }
  async read(path: string) {
    return this.files.get(path) ?? null;
  }
  async delete(path: string) {
    this.files.delete(path);
  }
}

const REQUIREMENTS: Array<{ type: string; options: string[] }> = [
  { type: 'VEHICLE', options: ['CAR', 'BIKE', 'AUTO'] },
  { type: 'PERSONAL_INFO', options: [] },
  { type: 'PERSONAL_IDENTITY', options: ['AADHAAR', 'PAN_CARD'] },
  { type: 'DRIVING_LICENCE', options: [] },
  { type: 'VEHICLE_NUMBER', options: ['VEHICLE_RC', 'ROAD_TAX'] },
  { type: 'PERMIT', options: [] },
  { type: 'CAB_INSURANCE', options: [] },
  { type: 'FITNESS', options: [] },
];

const data = (): OnboardingDataDto =>
  ({
    steps: [
      { key: 'VEHICLE', option: 'CAR' },
      { key: 'PERSONAL_INFO', fullName: 'Rahul Kumar', dateOfBirth: day(-30), gender: 'MALE' },
      { key: 'PERSONAL_IDENTITY', option: 'PAN_CARD', number: 'ABCDE1234F' },
      { key: 'DRIVING_LICENCE', number: 'JH0120190012345', expiryDate: day(5) },
      { key: 'VEHICLE_NUMBER', option: 'ROAD_TAX', number: 'JH01AB1234' },
      { key: 'PERMIT', number: 'PRM-1', expiryDate: day(1) },
      { key: 'CAB_INSURANCE', number: 'POL-1', expiryDate: day(1) },
      { key: 'FITNESS', number: 'FIT-1', expiryDate: day(1) },
    ],
  }) as OnboardingDataDto;

const photos = (): UploadedPhotos => Object.fromEntries(PHOTO_PART_NAMES.map((name) => [name, [{ buffer: JPEG }]]));

describe.skipIf(!PG_TESTS_ENABLED)(`driver onboarding submit, real Postgres (${SCRATCH_ONBOARDING_DB_NAME})`, () => {
  let db: ScratchDb;
  let storage: FakeStorage;
  let service: DriverOnboardingService;
  let phoneCounter = 0;

  const newDriver = async () =>
    (
      await db.prisma.driver.create({
        data: { phoneNumber: `+91900002${String(++phoneCounter).padStart(4, '0')}`, status: 'DOCUMENTS_PENDING', isPhoneVerified: true },
      })
    ).id;

  async function empty() {
    await db.prisma.driverDocument.deleteMany();
    await db.prisma.driver.deleteMany();
    await db.prisma.documentRequirement.deleteMany();
  }

  beforeAll(async () => {
    db = await openScratchDb(SCRATCH_ONBOARDING_DB_NAME);
    await empty();
  }, 120_000);
  afterAll(async () => {
    await empty();
    await db.close();
  });
  beforeEach(async () => {
    await empty();
    await db.prisma.documentRequirement.createMany({ data: REQUIREMENTS });
    storage = new FakeStorage();
    service = new DriverOnboardingService(db.prisma as unknown as PrismaService, storage, () => new Date());
  });

  it('saves a full application and moves the driver to UNDER_REVIEW', async () => {
    const driverId = await newDriver();
    expect(await service.submit(driverId, data(), photos())).toEqual({ status: 'UNDER_REVIEW' });

    const driver = await db.prisma.driver.findUniqueOrThrow({ where: { id: driverId } });
    expect(driver).toMatchObject({ status: 'UNDER_REVIEW', fullName: 'Rahul Kumar', gender: 'MALE' });
    expect(driver.dateOfBirth?.toISOString().slice(0, 10)).toBe(day(-30));
    expect(driver.submittedAt).toBeInstanceOf(Date);
    expect(driver.profilePhotoPath).toMatch(/^drivers\/.+\/personal_info-photo-/);

    const documents = await db.prisma.driverDocument.findMany({ where: { driverId }, orderBy: { key: 'asc' } });
    expect(documents.map((row) => row.key)).toEqual(
      ['CAB_INSURANCE', 'DRIVING_LICENCE', 'FITNESS', 'PERMIT', 'PERSONAL_IDENTITY', 'VEHICLE', 'VEHICLE_NUMBER'],
    );
    const licence = documents.find((row) => row.key === 'DRIVING_LICENCE')!;
    expect(licence).toMatchObject({ number: 'JH0120190012345', status: 'PENDING' });
    expect(licence.expiryDate?.toISOString().slice(0, 10)).toBe(day(5));
    expect(documents.find((row) => row.key === 'VEHICLE_NUMBER')).toMatchObject({ option: 'ROAD_TAX' });
    expect(storage.files.size).toBe(PHOTO_PART_NAMES.length);
  });

  it('a second submit is CONFLICT and writes nothing more', async () => {
    const driverId = await newDriver();
    await service.submit(driverId, data(), photos());
    const stored = storage.files.size;
    await expect(service.submit(driverId, data(), photos())).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(storage.files.size).toBe(stored);
    expect(await db.prisma.driverDocument.count({ where: { driverId } })).toBe(7);
  });

  it('two submits at the same moment: one wins, the other is CONFLICT and keeps no photos', async () => {
    const driverId = await newDriver();
    const results = await Promise.allSettled([
      service.submit(driverId, data(), photos()),
      service.submit(driverId, data(), photos()),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toMatchObject({ code: 'CONFLICT' });
    expect(storage.files.size).toBe(PHOTO_PART_NAMES.length); // only the winner's photos are left
    expect(await db.prisma.driverDocument.count({ where: { driverId } })).toBe(7);
  });

  it('keeps nothing when a required step is missing', async () => {
    const driverId = await newDriver();
    const partial = data();
    partial.steps = partial.steps.filter((step) => step.key !== 'PERMIT');
    const files = photos();
    delete files.PERMIT_FRONT;
    delete files.PERMIT_BACK;
    await expect(service.submit(driverId, partial, files)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(storage.files.size).toBe(0);
    expect(await db.prisma.driverDocument.count({ where: { driverId } })).toBe(0);
    expect((await db.prisma.driver.findUniqueOrThrow({ where: { id: driverId } })).status).toBe('DOCUMENTS_PENDING');
  });

  it('the requirements list reads both text-array columns', async () => {
    await db.prisma.documentRequirement.updateMany({ where: { type: 'VEHICLE' }, data: { options: ['CAR'], comingSoonOptions: ['BIKE', 'AUTO'] } });
    await db.prisma.documentRequirement.updateMany({ where: { type: 'FITNESS' }, data: { enabled: false } });
    const { steps } = await new DriverDocumentService(db.prisma as unknown as PrismaService).getRequirements();
    expect(steps[0]).toEqual({
      key: 'VEHICLE',
      required: true,
      options: [
        { value: 'CAR', status: 'AVAILABLE' },
        { value: 'BIKE', status: 'COMING_SOON' },
        { value: 'AUTO', status: 'COMING_SOON' },
      ],
    });
    expect(steps[1]).toEqual({ key: 'PERSONAL_INFO', required: true });
    expect(steps.map((step) => step.key)).not.toContain('FITNESS');
  });
});
