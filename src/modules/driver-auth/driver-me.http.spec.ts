import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { CLOCK } from '../../common/clock.js';
import { RateLimiter } from '../../common/rate-limit/rate-limiter.js';
import { SessionService } from '../../common/session/session.service.js';
import { setupApp } from '../../common/setup-app.js';
import { versionedBaseUrl } from '../../common/testing/base-url.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { InMemoryAuthDb } from '../rider-auth/testing/in-memory-auth-db.js';
import { DriverMeController } from './driver-me.controller.js';
import { DriverMeService, nextStepOf } from './driver-me.service.js';

type Row = Record<string, any>;

// The shared in-memory database, plus the driver's documents for `include: { documents }`.
class MeDb extends InMemoryAuthDb {
  constructor() {
    super();
    this.tables.driverDocument = [];
    const find = this.driver.findUnique;
    this.driver.findUnique = async (args: { where: Row }) => {
      const row = await find(args);
      return row && { ...row, documents: this.tables.driverDocument.filter((d) => d.driverId === row.id) };
    };
  }
}

describe('nextStepOf', () => {
  it.each([
    ['DOCUMENTS_PENDING', null, 'SUBMIT_DOCUMENTS'],
    ['DOCUMENTS_PENDING', new Date(), 'FIX_DOCUMENTS'],
    ['UNDER_REVIEW', new Date(), 'WAIT_FOR_REVIEW'],
    ['APPROVED', new Date(), 'READY'],
    ['REJECTED', new Date(), 'REJECTED'],
  ] as const)('%s, submitted %s -> %s', (status, submittedAt, expected) => {
    expect(nextStepOf({ status, submittedAt })).toBe(expected);
  });
});

describe('GET /v1/driver/me', () => {
  let app: INestApplication;
  let db: MeDb;
  let sessions: SessionService;

  beforeEach(async () => {
    db = new MeDb();
    const moduleRef = await Test.createTestingModule({
      controllers: [DriverMeController],
      providers: [
        DriverMeService,
        SessionService,
        { provide: PrismaService, useValue: db },
        { provide: CLOCK, useValue: () => new Date() },
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

  const tokenFor = async (role: 'DRIVER' | 'RIDER', accountId: string) =>
    (await sessions.create({ role, accountId, deviceId: 'device-1', now: new Date() })).accessToken;
  const me = async (token?: string) => {
    const res = await fetch(`${versionedBaseUrl(app)}/driver/me`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.status, body: (await res.json()) as Row };
  };
  const addDoc = (driverId: string, key: string, extra: Row = {}) =>
    db.tables.driverDocument.push({ driverId, key, status: 'PENDING', reviewNote: null, number: 'SECRET-NO-123', frontPath: 'drivers/x/a.jpg', ...extra });

  it('a new driver: SUBMIT_DOCUMENTS and no documents', async () => {
    const driver = db.addDriver({ status: 'DOCUMENTS_PENDING', submittedAt: null });
    const { status, body } = await me(await tokenFor('DRIVER', driver.id));
    expect(status).toBe(200);
    expect(body.data).toEqual({
      driver: { id: driver.id, phoneNumber: driver.phoneNumber, status: 'DOCUMENTS_PENDING', createdAt: driver.createdAt.toISOString(), createdAtIst: expect.any(String) },
      nextStep: 'SUBMIT_DOCUMENTS',
      documents: [],
    });
  });

  it('under review: WAIT_FOR_REVIEW, documents in step order, no number or photo path', async () => {
    const driver = db.addDriver({ status: 'UNDER_REVIEW', submittedAt: new Date() });
    addDoc(driver.id, 'FITNESS');
    addDoc(driver.id, 'VEHICLE');
    addDoc(driver.id, 'DRIVING_LICENCE');
    const { body } = await me(await tokenFor('DRIVER', driver.id));
    expect(body.data.nextStep).toBe('WAIT_FOR_REVIEW');
    expect(body.data.documents.map((d: Row) => d.key)).toEqual(['VEHICLE', 'DRIVING_LICENCE', 'FITNESS']);
    expect(body.data.documents[0]).toEqual({ key: 'VEHICLE', status: 'PENDING', reviewNote: null });
    expect(JSON.stringify(body)).not.toContain('SECRET-NO-123');
    expect(JSON.stringify(body)).not.toContain('drivers/');
  });

  it('sent back: FIX_DOCUMENTS, with the rejected step and its note', async () => {
    const driver = db.addDriver({ status: 'DOCUMENTS_PENDING', submittedAt: new Date() });
    addDoc(driver.id, 'DRIVING_LICENCE', { status: 'REJECTED', reviewNote: 'Back photo is blurry' });
    addDoc(driver.id, 'PERMIT', { status: 'APPROVED' });
    const { body } = await me(await tokenFor('DRIVER', driver.id));
    expect(body.data.nextStep).toBe('FIX_DOCUMENTS');
    expect(body.data.documents).toEqual([
      { key: 'DRIVING_LICENCE', status: 'REJECTED', reviewNote: 'Back photo is blurry' },
      { key: 'PERMIT', status: 'APPROVED', reviewNote: null },
    ]);
  });

  it('approved: READY; rejected: REJECTED', async () => {
    const approved = db.addDriver({ status: 'APPROVED', submittedAt: new Date() });
    const rejected = db.addDriver({ phoneNumber: '+919000000002', status: 'REJECTED', submittedAt: new Date() });
    expect((await me(await tokenFor('DRIVER', approved.id))).body.data.nextStep).toBe('READY');
    expect((await me(await tokenFor('DRIVER', rejected.id))).body.data.nextStep).toBe('REJECTED');
  });

  it('shows the live status: a change in the database shows on the next call', async () => {
    const driver = db.addDriver({ status: 'UNDER_REVIEW', submittedAt: new Date() });
    const token = await tokenFor('DRIVER', driver.id);
    expect((await me(token)).body.data.nextStep).toBe('WAIT_FOR_REVIEW');
    driver.status = 'APPROVED';
    expect((await me(token)).body.data.nextStep).toBe('READY');
  });

  it('401 without a token, 403 with a rider token, ACCOUNT_BANNED for a blocked driver', async () => {
    expect((await me()).status).toBe(401);
    const rider = db.addRider();
    expect((await me(await tokenFor('RIDER', rider.id))).status).toBe(403);
    const blocked = db.addDriver({ status: 'BLOCKED', submittedAt: new Date() });
    const reply = await me(await tokenFor('DRIVER', blocked.id));
    expect(reply.status).toBe(403);
    expect(reply.body.error.code).toBe('ACCOUNT_BANNED');
  });

  it('401 when the driver no longer exists', async () => {
    const driver = db.addDriver({ status: 'APPROVED' });
    const token = await tokenFor('DRIVER', driver.id);
    db.tables.driver = [];
    expect((await me(token)).status).toBe(401);
  });
});
