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
import { openScratchDb, PG_TESTS_ENABLED, SCRATCH_ADMIN_DB_NAME, type ScratchDb } from '../rider-auth/testing/scratch-db.js';
import { AdminAuthController } from './admin-auth.controller.js';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminDriverSubmissionsController } from './admin-driver-submissions.controller.js';
import { AdminDriverSubmissionsService } from './admin-driver-submissions.service.js';
import { AdminSessionGuard } from './admin-session.guard.js';
import { AdminSessionService } from './admin-session.service.js';
import { hashPassword } from './password.js';

// The admin routes through HTTP against REAL Postgres (the list needs groupBy, ordering and paging, which
// the in-memory fake does not do). Skipped unless RUN_PG_TESTS=1; uses only the scratch database named
// below, never treeps_db.
const PASSWORD = 'a-long-test-password';
type Row = Record<string, any>;

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

describe.skipIf(!PG_TESTS_ENABLED)(`admin login and driver submissions, real Postgres (${SCRATCH_ADMIN_DB_NAME})`, () => {
  let db: ScratchDb;
  let app: INestApplication;
  let storage: FakeStorage;
  let counter = 0;

  async function empty() {
    for (const table of ['adminSession', 'admin', 'driverDocument', 'driverRefreshToken', 'driverDevice', 'driver'] as const) {
      await (db.prisma[table] as any).deleteMany();
    }
  }
  beforeAll(async () => {
    db = await openScratchDb(SCRATCH_ADMIN_DB_NAME);
    await empty();
  }, 120_000);
  afterAll(async () => {
    await empty();
    await db.close();
  });
  beforeEach(async () => {
    await empty();
    counter = 0;
    storage = new FakeStorage();
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminAuthController, AdminDriverSubmissionsController],
      providers: [
        AdminAuthService, AdminSessionService, AdminSessionGuard, AdminDriverSubmissionsService, SessionService,
        { provide: PrismaService, useValue: db.prisma },
        { provide: CLOCK, useValue: () => new Date() },
        { provide: FILE_STORAGE, useValue: storage },
        { provide: ConfigService, useValue: { get: () => 0 } },
        { provide: RateLimiter, useFactory: () => new RateLimiter() },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.listen(0, '127.0.0.1');
  });
  afterEach(async () => {
    await app.close();
  });

  const call = async (path: string, init: { method?: string; token?: string; json?: unknown } = {}) => {
    const res = await fetch(`${versionedBaseUrl(app)}${path}`, {
      method: init.method ?? 'GET',
      headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.json ? { 'content-type': 'application/json' } : {}) },
      body: init.json ? JSON.stringify(init.json) : undefined,
    });
    return { status: res.status, body: (await res.json()) as Row };
  };
  const newAdmin = async (overrides: Row = {}) =>
    db.prisma.admin.create({ data: { email: 'asha@treeps.in', name: 'Asha Verma', passwordHash: await hashPassword(PASSWORD), ...overrides } });
  const loginToken = async (email = 'asha@treeps.in') =>
    (await call('/admin/auth/login', { method: 'POST', json: { email, password: PASSWORD } })).body.data.tokens.accessToken as string;

  // A driver who submitted, with stored photos under paths we control.
  async function submitted(name: string, status: 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' = 'UNDER_REVIEW', minutesAgo = 0) {
    counter += 1;
    const profilePath = `drivers/d${counter}/profile.jpg`;
    const frontPath = `drivers/d${counter}/licence-front.png`;
    storage.files.set(profilePath, Buffer.from(`profile-${counter}`));
    storage.files.set(frontPath, Buffer.from(`front-${counter}`));
    const driver = await db.prisma.driver.create({
      data: {
        phoneNumber: `+91900003${String(counter).padStart(4, '0')}`, status, isPhoneVerified: true, fullName: name,
        dateOfBirth: new Date('1995-05-10'), gender: 'MALE', profilePhotoPath: profilePath,
        submittedAt: new Date(Date.now() - minutesAgo * 60_000),
      },
    });
    await db.prisma.driverDocument.createMany({
      data: [
        { driverId: driver.id, key: 'VEHICLE', option: 'CAR' },
        { driverId: driver.id, key: 'DRIVING_LICENCE', number: `DL-${counter}`, expiryDate: new Date('2031-01-01'), frontPath, backPath: null },
        { driverId: driver.id, key: 'PERMIT', number: 'PRM-1', expiryDate: new Date('2027-01-01'), status: 'REJECTED', reviewNote: 'Blurry' },
      ],
    });
    return driver;
  }

  describe('POST /v1/admin/auth/login', () => {
    it('logs in with any letter case in the email and never returns the hash', async () => {
      await newAdmin();
      const { status, body } = await call('/admin/auth/login', { method: 'POST', json: { email: 'ASHA@Treeps.IN', password: PASSWORD } });
      expect(status).toBe(200);
      expect(body.data.admin).toMatchObject({ name: 'Asha Verma', email: 'asha@treeps.in' });
      expect(body.data.tokens.accessToken).toEqual(expect.any(String));
      expect(JSON.stringify(body)).not.toContain('scrypt');
      expect((await db.prisma.admin.findFirstOrThrow()).lastLoginAt).toBeInstanceOf(Date);
    });

    it('wrong password, unknown email and switched-off admin all give the same 401', async () => {
      await newAdmin();
      await newAdmin({ email: 'off@treeps.in', isActive: false });
      const replies = [
        await call('/admin/auth/login', { method: 'POST', json: { email: 'asha@treeps.in', password: 'not-the-password-123' } }),
        await call('/admin/auth/login', { method: 'POST', json: { email: 'nobody@treeps.in', password: PASSWORD } }),
        await call('/admin/auth/login', { method: 'POST', json: { email: 'off@treeps.in', password: PASSWORD } }),
      ];
      for (const reply of replies) {
        expect(reply.status).toBe(401);
        expect(reply.body.error.code).toBe('UNAUTHORIZED');
      }
      expect(new Set(replies.map((r) => r.body.error.message)).size).toBe(1);
    });

    it('400 for a bad email, a missing password or an unknown field', async () => {
      for (const json of [{ email: 'nope', password: 'x' }, { email: 'a@b.in' }, { email: 'a@b.in', password: 'x', extra: 1 }]) {
        expect((await call('/admin/auth/login', { method: 'POST', json })).status).toBe(400);
      }
    });

    it('a second login replaces the first session', async () => {
      await newAdmin();
      const first = await loginToken();
      const second = await loginToken();
      expect((await call('/admin/driver-submissions', { token: first })).status).toBe(401);
      expect((await call('/admin/driver-submissions', { token: second })).status).toBe(200);
    });

    it('is limited to 10 tries an hour per IP', async () => {
      let last = 0;
      for (let i = 0; i < 12; i++) last = (await call('/admin/auth/login', { method: 'POST', json: { email: 'asha@treeps.in', password: 'wrong-wrong-wrong' } })).status;
      expect(last).toBe(429);
    });
  });

  describe('who can read the submissions', () => {
    it('401 without a token, 401 with a made-up token, 403 with a driver token', async () => {
      const driver = await submitted('Rahul');
      await db.prisma.driverDevice.create({ data: { driverId: driver.id, deviceId: 'dev', platform: 'ANDROID', appVersion: '1.0.0', lastSeenAt: new Date() } });
      const driverToken = (await new SessionService(db.prisma as unknown as PrismaService).create({ role: 'DRIVER', accountId: driver.id, deviceId: 'dev', now: new Date() })).accessToken;
      expect((await call('/admin/driver-submissions')).status).toBe(401);
      expect((await call('/admin/driver-submissions', { token: 'made-up-token' })).status).toBe(401);
      expect((await call('/admin/driver-submissions', { token: driverToken })).status).toBe(403);
      expect((await call(`/admin/driver-submissions/${driver.id}`, { token: driverToken })).status).toBe(403);
    });

    it('a switched-off admin loses the token at once', async () => {
      const admin = await newAdmin();
      const token = await loginToken();
      await db.prisma.admin.update({ where: { id: admin.id }, data: { isActive: false } });
      expect((await call('/admin/driver-submissions', { token })).status).toBe(401);
      expect(await db.prisma.adminSession.count()).toBe(0);
    });
  });

  describe('GET /v1/admin/driver-submissions', () => {
    it('counts every status, lists only drivers who submitted, newest first, with no photos or numbers', async () => {
      await newAdmin();
      await submitted('Oldest', 'UNDER_REVIEW', 30);
      await submitted('Middle', 'APPROVED', 20);
      await submitted('Newest', 'REJECTED', 10);
      await db.prisma.driver.create({ data: { phoneNumber: '+919000039999', status: 'DOCUMENTS_PENDING', isPhoneVerified: true } }); // never submitted
      await db.prisma.driver.create({ data: { phoneNumber: '+919000039998', status: 'DELETED', isPhoneVerified: true, submittedAt: new Date() } });

      const { status, body } = await call('/admin/driver-submissions', { token: await loginToken() });
      expect(status).toBe(200);
      expect(body.data.counts).toMatchObject({ total: 3, UNDER_REVIEW: 1, APPROVED: 1, REJECTED: 1, DOCUMENTS_PENDING: 0 });
      expect(body.data.items.map((item: Row) => item.fullName)).toEqual(['Newest', 'Middle', 'Oldest']);
      expect(body.data.items[0].documents).toEqual({ total: 3, pending: 2, approved: 0, rejected: 1 });
      expect(body.data.items[0].submittedAtIst).toEqual(expect.any(String));
      const text = JSON.stringify(body);
      expect(text).not.toContain('DL-');
      expect(text).not.toContain('base64');
      expect(text).not.toContain('profilePhotoPath');
    });

    it('filters by status (counts stay global) and pages', async () => {
      await newAdmin();
      for (let i = 0; i < 5; i++) await submitted(`Driver ${i}`, i === 0 ? 'APPROVED' : 'UNDER_REVIEW', 50 - i);
      const token = await loginToken();
      const approved = await call('/admin/driver-submissions?status=APPROVED', { token });
      expect(approved.body.data.items).toHaveLength(1);
      expect(approved.body.data.total).toBe(1);
      expect(approved.body.data.counts.total).toBe(5);
      const page2 = await call('/admin/driver-submissions?page=2&pageSize=2', { token });
      expect(page2.body.data).toMatchObject({ page: 2, pageSize: 2, total: 5 });
      expect(page2.body.data.items).toHaveLength(2);
      expect((await call('/admin/driver-submissions?page=99', { token })).body.data.items).toEqual([]);
    });

    it('400 for a bad status, page, page size or an unknown query field', async () => {
      await newAdmin();
      const token = await loginToken();
      for (const query of ['status=NOPE', 'status=DELETED', 'page=0', 'page=abc', 'pageSize=101', 'pageSize=0', 'foo=1']) {
        expect((await call(`/admin/driver-submissions?${query}`, { token })).status).toBe(400);
      }
    });

    it('an empty system gives zero counts and an empty list', async () => {
      await newAdmin();
      const { body } = await call('/admin/driver-submissions', { token: await loginToken() });
      expect(body.data.counts.total).toBe(0);
      expect(body.data.items).toEqual([]);
    });
  });

  describe('GET /v1/admin/driver-submissions/:driverId', () => {
    it('returns everything the driver typed and uploaded, photos as base64, in the fixed step order', async () => {
      await newAdmin();
      const driver = await submitted('Rahul Kumar');
      const { status, body } = await call(`/admin/driver-submissions/${driver.id}`, { token: await loginToken() });
      expect(status).toBe(200);
      expect(body.data).toMatchObject({ driverId: driver.id, phoneNumber: driver.phoneNumber, status: 'UNDER_REVIEW' });
      expect(body.data.profile).toMatchObject({ fullName: 'Rahul Kumar', dateOfBirth: '1995-05-10', gender: 'MALE' });
      expect(body.data.profile.photo).toEqual({ contentType: 'image/jpeg', data: Buffer.from('profile-1').toString('base64') });
      expect(body.data.documents.map((d: Row) => d.key)).toEqual(['VEHICLE', 'DRIVING_LICENCE', 'PERMIT']);
      const licence = body.data.documents[1];
      expect(licence).toMatchObject({ number: 'DL-1', expiryDate: '2031-01-01', status: 'PENDING', back: null });
      expect(licence.front).toEqual({ contentType: 'image/png', data: Buffer.from('front-1').toString('base64') });
      expect(body.data.documents[2]).toMatchObject({ status: 'REJECTED', reviewNote: 'Blurry' });
      expect(body.data.documents[0]).toMatchObject({ option: 'CAR', number: null, front: null });
    });

    it('a photo file that is gone gives null for that photo and still 200', async () => {
      await newAdmin();
      const driver = await submitted('Rahul');
      storage.files.delete('drivers/d1/licence-front.png');
      const { status, body } = await call(`/admin/driver-submissions/${driver.id}`, { token: await loginToken() });
      expect(status).toBe(200);
      expect(body.data.documents[1].front).toBeNull();
      expect(body.data.profile.photo).not.toBeNull();
    });

    it('404 for a driver who never submitted, a deleted driver and an unknown id; 400 for a bad id', async () => {
      await newAdmin();
      const token = await loginToken();
      const pending = await db.prisma.driver.create({ data: { phoneNumber: '+919000039997', status: 'DOCUMENTS_PENDING', isPhoneVerified: true } });
      const deleted = await db.prisma.driver.create({ data: { phoneNumber: '+919000039996', status: 'DELETED', isPhoneVerified: true, submittedAt: new Date() } });
      for (const id of [pending.id, deleted.id, '11111111-1111-4111-8111-111111111111']) {
        expect((await call(`/admin/driver-submissions/${id}`, { token })).status).toBe(404);
      }
      expect((await call('/admin/driver-submissions/not-a-uuid', { token })).status).toBe(400);
    });
  });
});
