import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { CLOCK } from '../../common/clock.js';
import { RateLimiter } from '../../common/rate-limit/rate-limiter.js';
import { SessionService } from '../../common/session/session.service.js';
import { setupApp } from '../../common/setup-app.js';
import { FILE_STORAGE, type FileStorage } from '../../common/storage/file-storage.js';
import { versionedBaseUrl } from '../../common/testing/base-url.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { InMemoryAuthDb } from '../rider-auth/testing/in-memory-auth-db.js';
import { DriverDocumentsController } from './driver-documents.controller.js';
import { DriverDocumentService } from './driver-documents.service.js';
import { DriverOnboardingController } from './driver-onboarding.controller.js';
import { DriverOnboardingService } from './driver-onboarding.service.js';
import { PHOTO_PART_NAMES } from './onboarding-rules.js';

type Row = Record<string, any>;

// The shared in-memory database, plus the two tables this feature uses.
class OnboardingDb extends InMemoryAuthDb {
  constructor() {
    super();
    this.tables.documentRequirement = [];
    this.tables.driverDocument = [];
  }
  documentRequirement = {
    findMany: async ({ where }: { where: Row }) =>
      this.tables.documentRequirement.filter((row) => row.enabled === where.enabled),
  };
  driverDocument = {
    findMany: async ({ where }: { where: Row }) =>
      this.tables.driverDocument.filter((row) => row.driverId === where.driverId),
    upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
      const { driverId, key } = where.driverId_key;
      const found = this.tables.driverDocument.find((row) => row.driverId === driverId && row.key === key);
      if (found) return Object.assign(found, update);
      const row = { id: `doc-${this.tables.driverDocument.length + 1}`, ...create };
      this.tables.driverDocument.push(row);
      return row;
    },
  };
  addRequirement(type: string, options: string[] = [], overrides: Row = {}): void {
    this.tables.documentRequirement.push({ type, enabled: true, required: true, options, comingSoonOptions: [], ...overrides });
  }
}

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

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

const day = (years: number) => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
};

const STEP_OPTIONS: Record<string, string[]> = {
  VEHICLE: ['CAR', 'BIKE', 'AUTO'],
  PERSONAL_INFO: [],
  PERSONAL_IDENTITY: ['AADHAAR', 'PAN_CARD'],
  DRIVING_LICENCE: [],
  VEHICLE_NUMBER: ['VEHICLE_RC', 'ROAD_TAX'],
  PERMIT: [],
  CAB_INSURANCE: [],
  FITNESS: [],
};

function fullSteps(): Row[] {
  return [
    { key: 'VEHICLE', option: 'CAR' },
    { key: 'PERSONAL_INFO', fullName: 'Rahul Kumar', dateOfBirth: day(-30), gender: 'MALE' },
    { key: 'PERSONAL_IDENTITY', option: 'AADHAAR', number: '123412341234' },
    { key: 'DRIVING_LICENCE', number: 'JH0120190012345', expiryDate: day(5) },
    { key: 'VEHICLE_NUMBER', option: 'VEHICLE_RC', number: 'JH01AB1234' },
    { key: 'PERMIT', number: 'PRM-2026-8841', expiryDate: day(1) },
    { key: 'CAB_INSURANCE', number: 'POL-55120077', expiryDate: day(1) },
    { key: 'FITNESS', number: 'FIT-90321', expiryDate: day(1) },
  ];
}

function allPhotos(): Record<string, Buffer> {
  return Object.fromEntries(PHOTO_PART_NAMES.map((name, i) => [name, i % 2 === 0 ? JPEG : PNG]));
}

function buildForm(data: unknown, photos: Record<string, Buffer | undefined> = allPhotos()): FormData {
  const form = new FormData();
  form.append('data', typeof data === 'string' ? data : JSON.stringify(data));
  for (const [name, bytes] of Object.entries(photos)) {
    if (bytes) form.append(name, new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }), `${name}.jpg`);
  }
  return form;
}

describe('POST /v1/driver/onboarding and GET /v1/driver/documents/requirements', () => {
  let app: INestApplication;
  let db: OnboardingDb;
  let storage: FakeStorage;
  let sessions: SessionService;
  let driverId: string;
  let riderId: string;

  const driverToken = async () =>
    (await sessions.create({ role: 'DRIVER', accountId: driverId, deviceId: 'device-1', now: new Date() })).accessToken;
  const riderToken = async () =>
    (await sessions.create({ role: 'RIDER', accountId: riderId, deviceId: 'device-1', now: new Date() })).accessToken;

  beforeEach(async () => {
    db = new OnboardingDb();
    storage = new FakeStorage();
    for (const [type, options] of Object.entries(STEP_OPTIONS)) db.addRequirement(type, options);
    driverId = db.addDriver({ status: 'DOCUMENTS_PENDING', fullName: null, profilePhotoPath: null }).id as string;
    riderId = db.addRider({ status: 'ACTIVE' }).id as string;
    const moduleRef = await Test.createTestingModule({
      controllers: [DriverOnboardingController, DriverDocumentsController],
      providers: [
        DriverOnboardingService,
        DriverDocumentService,
        SessionService,
        { provide: PrismaService, useValue: db },
        { provide: CLOCK, useValue: () => new Date() },
        { provide: FILE_STORAGE, useValue: storage },
        { provide: ConfigService, useValue: { get: () => 0 } },
        { provide: RateLimiter, useFactory: () => new RateLimiter() },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.listen(0, '127.0.0.1');
    sessions = new SessionService(db as unknown as PrismaService);
  });
  afterEach(async () => {
    await app.close();
  });

  const submit = async (form: FormData, token?: string) => {
    const res = await fetch(`${versionedBaseUrl(app)}/driver/onboarding`, {
      method: 'POST',
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      body: form,
    });
    return { res, body: await res.json() };
  };
  const driverRow = () => db.tables.driver.find((row) => row.id === driverId) as Row;
  const detailsOf = (body: Row) => Object.fromEntries((body.error.details ?? []).map((d: Row) => [d.field, d.reason]));

  describe('a valid application', () => {
    it('saves everything and moves the driver to UNDER_REVIEW', async () => {
      const { res, body } = await submit(buildForm({ steps: fullSteps() }), await driverToken());
      expect(res.status).toBe(200);
      expect(body).toMatchObject({ success: true, data: { status: 'UNDER_REVIEW' } });

      const driver = driverRow();
      expect(driver).toMatchObject({ status: 'UNDER_REVIEW', fullName: 'Rahul Kumar', gender: 'MALE' });
      expect(driver.dateOfBirth).toBeInstanceOf(Date);
      expect(driver.submittedAt).toBeInstanceOf(Date);
      expect(driver.profilePhotoPath).toMatch(new RegExp(`^drivers/${driverId}/personal_info-photo-.+\\.(jpg|png)$`));

      const documents = db.tables.driverDocument;
      expect(documents.map((row) => row.key).sort()).toEqual(
        ['CAB_INSURANCE', 'DRIVING_LICENCE', 'FITNESS', 'PERMIT', 'PERSONAL_IDENTITY', 'VEHICLE', 'VEHICLE_NUMBER'],
      );
      const licence = documents.find((row) => row.key === 'DRIVING_LICENCE') as Row;
      expect(licence).toMatchObject({ number: 'JH0120190012345', status: 'PENDING' });
      expect(licence.expiryDate).toBeInstanceOf(Date);
      expect(licence.frontPath).toMatch(/driving_licence-front-/);
      expect(licence.backPath).toMatch(/driving_licence-back-/);
      expect(documents.find((row) => row.key === 'VEHICLE')).toMatchObject({ option: 'CAR', frontPath: null, backPath: null });
      expect(documents.find((row) => row.key === 'PERSONAL_IDENTITY')).toMatchObject({ option: 'AADHAAR', number: '123412341234' });

      // 10 photo parts, each stored once, each at the path the row points to.
      expect(storage.files.size).toBe(PHOTO_PART_NAMES.length);
      expect(storage.files.has(licence.frontPath)).toBe(true);
      expect(storage.files.has(licence.backPath)).toBe(true);
    });

    it('never sends a number or a path back to the app', async () => {
      const { body } = await submit(buildForm({ steps: fullSteps() }), await driverToken());
      const text = JSON.stringify(body);
      expect(text).not.toContain('123412341234');
      expect(text).not.toContain('drivers/');
    });

    it('stores PNG and JPG by what the bytes are, not by the file name', async () => {
      await submit(buildForm({ steps: fullSteps() }), await driverToken());
      const paths = [...storage.files.keys()];
      expect(paths.some((path) => path.endsWith('.png'))).toBe(true);
      expect(paths.some((path) => path.endsWith('.jpg'))).toBe(true);
    });
  });

  describe('who can call it', () => {
    it('401 without a token, and nothing is stored', async () => {
      const { res, body } = await submit(buildForm({ steps: fullSteps() }));
      expect(res.status).toBe(401);
      expect(body.error.code).toBe('UNAUTHORIZED');
      expect(storage.files.size).toBe(0);
    });

    it('403 with a rider token', async () => {
      const { res, body } = await submit(buildForm({ steps: fullSteps() }), await riderToken());
      expect(res.status).toBe(403);
      expect(body.error.code).toBe('FORBIDDEN');
      expect(storage.files.size).toBe(0);
    });

    it('409 when the driver already submitted', async () => {
      const token = await driverToken();
      expect((await submit(buildForm({ steps: fullSteps() }), token)).res.status).toBe(200);
      const again = await submit(buildForm({ steps: fullSteps() }), token);
      expect(again.res.status).toBe(409);
      expect(again.body.error.code).toBe('CONFLICT');
    });
  });

  describe('a bad application saves nothing', () => {
    const expectNothingSaved = () => {
      expect(storage.files.size).toBe(0);
      expect(db.tables.driverDocument).toHaveLength(0);
      expect(driverRow().status).toBe('DOCUMENTS_PENDING');
    };

    it('a required step is missing', async () => {
      const steps = fullSteps().filter((step) => step.key !== 'FITNESS');
      const parts = allPhotos();
      delete parts.FITNESS_FRONT;
      const { res, body } = await submit(buildForm({ steps }, parts), await driverToken());
      expect(res.status).toBe(400);
      expect(body.error.code).toBe('INVALID_INPUT');
      expect(detailsOf(body)).toEqual({ 'data.steps.FITNESS': 'REQUIRED' });
      expectNothingSaved();
    });

    it('a photo is missing', async () => {
      const parts = allPhotos();
      delete parts.DRIVING_LICENCE_BACK;
      const { res, body } = await submit(buildForm({ steps: fullSteps() }, parts), await driverToken());
      expect(res.status).toBe(400);
      expect(detailsOf(body)).toEqual({ DRIVING_LICENCE_BACK: 'REQUIRED' });
      expectNothingSaved();
    });

    it('a file is not a real JPG or PNG, whatever its name says', async () => {
      const parts = { ...allPhotos(), PERMIT_FRONT: Buffer.from('%PDF-1.4 not a photo') };
      const { res, body } = await submit(buildForm({ steps: fullSteps() }, parts), await driverToken());
      expect(res.status).toBe(400);
      expect(detailsOf(body)).toEqual({ PERMIT_FRONT: 'INVALID_FORMAT' });
      expectNothingSaved();
    });

    it('a photo is bigger than 2 MB', async () => {
      const big = Buffer.concat([JPEG, Buffer.alloc(2 * 1024 * 1024)]);
      const { res, body } = await submit(buildForm({ steps: fullSteps() }, { ...allPhotos(), FITNESS_FRONT: big }), await driverToken());
      expect(res.status).toBe(400);
      expect(body.error.code).toBe('INVALID_INPUT');
      expectNothingSaved();
    });

    it('a file part with a name no step uses', async () => {
      const { res, body } = await submit(buildForm({ steps: fullSteps() }, { ...allPhotos(), SOMETHING_ELSE: JPEG }), await driverToken());
      expect(res.status).toBe(400);
      expect(body.error.code).toBe('INVALID_INPUT');
      expectNothingSaved();
    });

    it('a photo for a step that is not in the application', async () => {
      const steps = fullSteps().filter((step) => step.key !== 'FITNESS');
      db.tables.documentRequirement.find((row) => row.type === 'FITNESS')!.required = false;
      const { res, body } = await submit(buildForm({ steps }), await driverToken()); // FITNESS_FRONT is still sent
      expect(res.status).toBe(400);
      expect(detailsOf(body)).toEqual({ FITNESS_FRONT: 'UNKNOWN_FIELD' });
      expectNothingSaved();
    });

    it('an unknown field, even a status', async () => {
      const steps = fullSteps();
      steps[3].status = 'APPROVED';
      const { res, body } = await submit(buildForm({ steps }), await driverToken());
      expect(res.status).toBe(400);
      expect(detailsOf(body)['data.steps.3.status']).toBe('UNKNOWN_FIELD');
      expectNothingSaved();
    });

    it('an expired document and a driver under 18', async () => {
      const steps = fullSteps();
      steps[3].expiryDate = day(-1);
      steps[1].dateOfBirth = day(-17);
      const { res, body } = await submit(buildForm({ steps }), await driverToken());
      expect(res.status).toBe(400);
      expect(detailsOf(body)).toEqual({
        'data.steps.1.dateOfBirth': 'OUT_OF_RANGE',
        'data.steps.3.expiryDate': 'OUT_OF_RANGE',
      });
      expectNothingSaved();
    });

    it('a date that is not a real calendar date', async () => {
      const steps = fullSteps();
      steps[3].expiryDate = '2030-02-30';
      const { body } = await submit(buildForm({ steps }), await driverToken());
      expect(detailsOf(body)['data.steps.3.expiryDate']).toBe('INVALID_FORMAT');
      expectNothingSaved();
    });

    it('a missing number, a missing choice and a missing profile field', async () => {
      const steps = fullSteps();
      delete steps[3].number;
      delete steps[0].option;
      delete steps[1].gender;
      const { body } = await submit(buildForm({ steps }), await driverToken());
      expect(detailsOf(body)).toEqual({
        'data.steps.0.option': 'REQUIRED',
        'data.steps.1.gender': 'REQUIRED',
        'data.steps.3.number': 'REQUIRED',
      });
      expectNothingSaved();
    });

    it('a field the step does not take', async () => {
      const steps = fullSteps();
      steps[0].number = '123'; // VEHICLE takes only a choice
      const { body } = await submit(buildForm({ steps }), await driverToken());
      expect(detailsOf(body)).toEqual({ 'data.steps.0.number': 'UNKNOWN_FIELD' });
      expectNothingSaved();
    });

    it('a choice that is switched off', async () => {
      db.tables.documentRequirement.find((row) => row.type === 'VEHICLE')!.options = ['CAR'];
      const steps = fullSteps();
      steps[0].option = 'BIKE';
      const { body } = await submit(buildForm({ steps }), await driverToken());
      expect(detailsOf(body)).toEqual({ 'data.steps.0.option': 'NOT_ALLOWED' });
      expectNothingSaved();
    });

    it('a choice that is coming soon cannot be picked', async () => {
      const vehicle = db.tables.documentRequirement.find((row) => row.type === 'VEHICLE')!;
      vehicle.options = ['CAR'];
      vehicle.comingSoonOptions = ['BIKE', 'AUTO'];
      const steps = fullSteps();
      steps[0].option = 'BIKE';
      const { body } = await submit(buildForm({ steps }), await driverToken());
      expect(detailsOf(body)).toEqual({ 'data.steps.0.option': 'NOT_ALLOWED' });
      expectNothingSaved();
    });

    it('a step that is switched off', async () => {
      db.tables.documentRequirement.find((row) => row.type === 'FITNESS')!.enabled = false;
      const { body } = await submit(buildForm({ steps: fullSteps() }), await driverToken());
      expect(detailsOf(body)['data.steps.7.key']).toBe('NOT_ALLOWED');
      expectNothingSaved();
    });

    it('the same step twice', async () => {
      // 8 steps in all (the most a request may have): FITNESS is replaced by a second PERMIT.
      const steps = [...fullSteps().filter((step) => step.key !== 'FITNESS'), { key: 'PERMIT', number: 'X1', expiryDate: day(1) }];
      const { body } = await submit(buildForm({ steps }), await driverToken());
      expect(detailsOf(body)['data.steps.7.key']).toBe('INVALID_VALUE');
      expectNothingSaved();
    });

    it('data that is not JSON, or not an object, or has no steps', async () => {
      const token = await driverToken();
      for (const data of ['not json', '[]', '{}', '{"steps":[]}', '{"steps":"x"}']) {
        const { res, body } = await submit(buildForm(data), token);
        expect(res.status).toBe(400);
        expect(body.error.code).toBe('INVALID_INPUT');
      }
      expectNothingSaved();
    });

    it('a request with no data part at all', async () => {
      const form = new FormData();
      form.append('DRIVING_LICENCE_FRONT', new Blob([new Uint8Array(JPEG)]), 'x.jpg');
      const { res, body } = await submit(form, await driverToken());
      expect(res.status).toBe(400);
      expect(body.error.code).toBe('INVALID_INPUT');
      expectNothingSaved();
    });
  });

  describe('when the database fails after the photos are stored', () => {
    it('deletes the photos again and replies with an error', async () => {
      db.failOn = 'driver.updateMany';
      const { res, body } = await submit(buildForm({ steps: fullSteps() }), await driverToken());
      expect(res.status).toBe(500);
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(storage.files.size).toBe(0);
      expect(db.tables.driverDocument).toHaveLength(0);
      expect(driverRow().status).toBe('DOCUMENTS_PENDING');
    });
  });

  describe('sending the application again after an admin sent it back', () => {
    it('needs only the missing step, and replaces its photos', async () => {
      const token = await driverToken();
      expect((await submit(buildForm({ steps: fullSteps() }), token)).res.status).toBe(200);
      const oldPermit = db.tables.driverDocument.find((row) => row.key === 'PERMIT') as Row;
      const oldFront = oldPermit.frontPath;
      // The admin sends the driver back (admin side is not built; this is what it will do).
      driverRow().status = 'DOCUMENTS_PENDING';
      oldPermit.status = 'REJECTED';

      const again = await submit(
        buildForm({ steps: [{ key: 'PERMIT', number: 'NEW-1', expiryDate: day(2) }] }, { PERMIT_FRONT: JPEG, PERMIT_BACK: PNG }),
        token,
      );
      expect(again.res.status).toBe(200);
      const permit = db.tables.driverDocument.find((row) => row.key === 'PERMIT') as Row;
      expect(permit).toMatchObject({ number: 'NEW-1', status: 'PENDING', reviewNote: null });
      expect(permit.frontPath).not.toBe(oldFront);
      expect(storage.files.has(oldFront)).toBe(false); // the replaced photo is deleted
      expect(storage.files.has(permit.frontPath)).toBe(true);
      expect(driverRow().status).toBe('UNDER_REVIEW');
    });
  });

  describe('GET /v1/driver/documents/requirements', () => {
    const getSteps = async (token?: string) => {
      const res = await fetch(`${versionedBaseUrl(app)}/driver/documents/requirements`, {
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      });
      return { res, body: await res.json() };
    };

    it('lists the switched-on steps in the fixed order, with options only where a step has choices', async () => {
      const { res, body } = await getSteps(await driverToken());
      expect(res.status).toBe(200);
      expect(body.data.steps.map((step: Row) => step.key)).toEqual([
        'VEHICLE', 'PERSONAL_INFO', 'PERSONAL_IDENTITY', 'DRIVING_LICENCE', 'VEHICLE_NUMBER', 'PERMIT', 'CAB_INSURANCE', 'FITNESS',
      ]);
      expect(body.data.steps[0]).toEqual({
        key: 'VEHICLE',
        required: true,
        options: [
          { value: 'CAR', status: 'AVAILABLE' },
          { value: 'BIKE', status: 'AVAILABLE' },
          { value: 'AUTO', status: 'AVAILABLE' },
        ],
      });
      expect(body.data.steps[1]).toEqual({ key: 'PERSONAL_INFO', required: true });
    });

    it('hides a switched-off step and a switched-off choice, and shows required false', async () => {
      db.tables.documentRequirement.find((row) => row.type === 'FITNESS')!.enabled = false;
      db.tables.documentRequirement.find((row) => row.type === 'VEHICLE')!.options = ['CAR'];
      db.tables.documentRequirement.find((row) => row.type === 'PERMIT')!.required = false;
      const { body } = await getSteps(await driverToken());
      const keys = body.data.steps.map((step: Row) => step.key);
      expect(keys).not.toContain('FITNESS');
      expect(body.data.steps[0].options).toEqual([{ value: 'CAR', status: 'AVAILABLE' }]);
      expect(body.data.steps.find((step: Row) => step.key === 'PERMIT').required).toBe(false);
    });

    it('shows coming-soon options, in the fixed order, so the cards never move', async () => {
      const vehicle = db.tables.documentRequirement.find((row) => row.type === 'VEHICLE')!;
      vehicle.options = ['CAR'];
      vehicle.comingSoonOptions = ['AUTO', 'BIKE']; // stored in another order on purpose
      const { body } = await getSteps(await driverToken());
      expect(body.data.steps[0].options).toEqual([
        { value: 'CAR', status: 'AVAILABLE' },
        { value: 'BIKE', status: 'COMING_SOON' },
        { value: 'AUTO', status: 'COMING_SOON' },
      ]);
    });

    it('an option in both columns counts as available; a value the server does not know is ignored', async () => {
      const vehicle = db.tables.documentRequirement.find((row) => row.type === 'VEHICLE')!;
      vehicle.options = ['CAR', 'BIKE', 'TRUCK'];
      vehicle.comingSoonOptions = ['BIKE', 'HELICOPTER'];
      const { body } = await getSteps(await driverToken());
      expect(body.data.steps[0].options).toEqual([
        { value: 'CAR', status: 'AVAILABLE' },
        { value: 'BIKE', status: 'AVAILABLE' },
      ]);
    });

    it('a step whose every option is hidden sends no options', async () => {
      const vehicle = db.tables.documentRequirement.find((row) => row.type === 'VEHICLE')!;
      vehicle.options = [];
      vehicle.comingSoonOptions = [];
      const { body } = await getSteps(await driverToken());
      expect(body.data.steps[0]).toEqual({ key: 'VEHICLE', required: true });
    });

    it('401 without a token and 403 with a rider token', async () => {
      expect((await getSteps()).res.status).toBe(401);
      expect((await getSteps(await riderToken())).res.status).toBe(403);
    });
  });
});
