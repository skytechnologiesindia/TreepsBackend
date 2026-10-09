import { Controller, Get, UseGuards } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { InMemoryAuthDb } from '../../modules/rider-auth/testing/in-memory-auth-db.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CLOCK } from '../clock.js';
import { SessionService } from '../session/session.service.js';
import type { AuthClaims } from '../session/session.types.js';
import { setupApp } from '../setup-app.js';
import { versionedBaseUrl } from '../testing/base-url.js';
import { newOpaqueToken } from '../tokens.js';
import { AuthUser } from './auth-user.decorator.js';
import { SessionAuthGuard } from './session-auth.guard.js';

const T0 = new Date('2026-10-09T10:00:00.000Z').getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// One probe route in each domain, so the domain rule is tested on a /v1/driver/* route too.
@Controller('rider/probe')
class RiderProbe {
  @UseGuards(SessionAuthGuard)
  @Get()
  who(@AuthUser() user: AuthClaims) {
    return user;
  }
}
@Controller('driver/probe')
class DriverProbe {
  @UseGuards(SessionAuthGuard)
  @Get()
  who(@AuthUser() user: AuthClaims) {
    return user;
  }
}

describe('SessionAuthGuard', () => {
  let app: INestApplication;
  let db: InMemoryAuthDb;
  let sessions: SessionService;
  let now = T0;
  let riderId: string;
  let driverId: string;

  const riderToken = async (deviceId = 'device-1') => (await sessions.create({ role: 'RIDER', accountId: riderId, deviceId, now: new Date(now) })).accessToken;
  const driverToken = async (deviceId = 'device-1') => (await sessions.create({ role: 'DRIVER', accountId: driverId, deviceId, now: new Date(now) })).accessToken;

  beforeEach(async () => {
    now = T0;
    db = new InMemoryAuthDb();
    riderId = db.addRider({ status: 'ACTIVE' }).id as string;
    driverId = db.addDriver({ status: 'APPROVED' }).id as string;
    const moduleRef = await Test.createTestingModule({
      controllers: [RiderProbe, DriverProbe],
      providers: [SessionService, { provide: PrismaService, useValue: db }, { provide: CLOCK, useValue: () => new Date(now) }],
    }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.listen(0, '127.0.0.1');
    sessions = new SessionService(db as unknown as PrismaService);
  });
  afterEach(async () => {
    await app.close();
  });

  const get = async (path: string, token?: string, header?: string) => {
    const authorization = header ?? (token === undefined ? undefined : `Bearer ${token}`);
    const res = await fetch(`${versionedBaseUrl(app)}${path}`, { headers: authorization === undefined ? {} : { authorization } });
    return { res, body: await res.json() };
  };
  const UNAUTHORIZED = { code: 'UNAUTHORIZED', message: 'Please log in again.', field: null };

  describe('a good session', () => {
    it('a RIDER session on a rider route: userId, role and deviceId reach the handler', async () => {
      const { res, body } = await get('/rider/probe', await riderToken('phone-7'));
      expect(res.status).toBe(200);
      expect(body.data).toEqual({ userId: riderId, role: 'RIDER', deviceId: 'phone-7' });
    });

    it('a DRIVER session on a driver route', async () => {
      const { res, body } = await get('/driver/probe', await driverToken('phone-9'));
      expect(res.status).toBe(200);
      expect(body.data).toEqual({ userId: driverId, role: 'DRIVER', deviceId: 'phone-9' });
    });

    it('a PROFILE_PENDING rider and a DOCUMENTS_PENDING driver are allowed in', async () => {
      db.tables.rider[0].status = 'PROFILE_PENDING';
      db.tables.driver[0].status = 'DOCUMENTS_PENDING';
      expect((await get('/rider/probe', await riderToken())).res.status).toBe(200);
      expect((await get('/driver/probe', await driverToken())).res.status).toBe(200);
    });
  });

  describe('401 UNAUTHORIZED, one answer for every kind of bad token', () => {
    it.each(['/rider/probe', '/driver/probe'])('no Authorization header on %s', async (path) => {
      const { res, body } = await get(path);
      expect(res.status).toBe(401);
      expect(body.error).toEqual(UNAUTHORIZED);
    });

    it.each([['an empty bearer', 'Bearer '], ['a non-Bearer scheme', 'Basic abc'], ['two words after Bearer', 'Bearer a b']])('malformed header: %s', async (_name, header) => {
      const { res, body } = await get('/rider/probe', undefined, header);
      expect(res.status).toBe(401);
      expect(body.error).toEqual(UNAUTHORIZED);
    });

    it('an unknown token (well-formed, garbage and a JWT-looking string)', async () => {
      for (const token of [newOpaqueToken(), 'abc', 'aaa.bbb.ccc']) {
        const { res, body } = await get('/rider/probe', token);
        expect(res.status).toBe(401);
        expect(body.error).toEqual(UNAUTHORIZED);
      }
    });

    it('an expired session (30 days without use), also on a driver route', async () => {
      const rider = await riderToken();
      const driver = await driverToken();
      now += 30 * DAY + 1000;
      expect((await get('/rider/probe', rider)).res.status).toBe(401);
      expect((await get('/driver/probe', driver)).res.status).toBe(401);
    });

    it('a session just before it expires still works', async () => {
      const token = await riderToken();
      now += 30 * DAY - 1000;
      expect((await get('/rider/probe', token)).res.status).toBe(200);
    });

    it('an old refresh-token row that was revoked is not a session', async () => {
      const token = await riderToken();
      db.tables.refreshToken[0].revokedAt = new Date(T0);
      expect((await get('/rider/probe', token)).res.status).toBe(401);
    });

    it('a session whose account no longer exists is 401 and its sessions are deleted', async () => {
      const token = await riderToken();
      db.tables.rider.length = 0;
      expect((await get('/rider/probe', token)).res.status).toBe(401);
      expect(db.tables.refreshToken).toHaveLength(0);
    });
  });

  describe('403 FORBIDDEN, the wrong domain', () => {
    it('a RIDER session on a driver route', async () => {
      const { res, body } = await get('/driver/probe', await riderToken());
      expect(res.status).toBe(403);
      expect(body.error).toEqual({ code: 'FORBIDDEN', message: "You don't have access to this.", field: null });
    });

    it('a DRIVER session on a rider route', async () => {
      const { res, body } = await get('/rider/probe', await driverToken());
      expect(res.status).toBe(403);
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('a wrong-domain call does not delete or change the session', async () => {
      const token = await riderToken();
      await get('/driver/probe', token);
      expect((await get('/rider/probe', token)).res.status).toBe(200);
    });
  });

  describe('403 ACCOUNT_BANNED, and the sessions go at once', () => {
    it.each(['SUSPENDED', 'BLOCKED', 'DELETED'])('a %s rider loses every session on the first request', async (status) => {
      const first = await riderToken('phone-1');
      const second = await riderToken('phone-2');
      db.tables.rider[0].status = status;
      const { res, body } = await get('/rider/probe', first);
      expect(res.status).toBe(403);
      expect(body.error).toEqual({ code: 'ACCOUNT_BANNED', message: "This account can't book rides.", field: null });
      expect(db.tables.refreshToken).toHaveLength(0);
      expect((await get('/rider/probe', first)).res.status).toBe(401);
      expect((await get('/rider/probe', second)).res.status).toBe(401);
    });

    it.each(['SUSPENDED', 'BLOCKED', 'DELETED'])('a %s driver loses its session on the first request', async (status) => {
      const token = await driverToken();
      db.tables.driver[0].status = status;
      const { res, body } = await get('/driver/probe', token);
      expect(res.status).toBe(403);
      expect(body.error.code).toBe('ACCOUNT_BANNED');
      expect(db.tables.driverRefreshToken).toHaveLength(0);
      expect((await get('/driver/probe', token)).res.status).toBe(401);
    });

    it('a ban deletes only that account sessions', async () => {
      const other = db.addRider({ phoneNumber: '+919477172299', status: 'ACTIVE' }).id as string;
      const otherToken = (await sessions.create({ role: 'RIDER', accountId: other, deviceId: 'x', now: new Date(now) })).accessToken;
      const token = await riderToken();
      db.tables.rider.find((r) => r.id === riderId)!.status = 'SUSPENDED';
      await get('/rider/probe', token);
      expect((await get('/rider/probe', otherToken)).res.status).toBe(200);
    });
  });

  describe('sliding expiry, written at most once an hour', () => {
    const writes = () => db.calls['refreshToken.updateMany'] ?? 0;
    const expiry = () => db.tables.refreshToken[0].expiresAt.getTime();

    it('requests inside the first hour write nothing', async () => {
      const token = await riderToken();
      for (const minutes of [1, 10, 30, 59]) {
        now = T0 + minutes * MINUTE;
        expect((await get('/rider/probe', token)).res.status).toBe(200);
      }
      expect(writes()).toBe(0);
      expect(expiry()).toBe(T0 + 30 * DAY);
    });

    it('the first request after an hour extends the expiry to now + 30 days, then nothing more for an hour', async () => {
      const token = await riderToken();
      now = T0 + 61 * MINUTE;
      await get('/rider/probe', token);
      expect(writes()).toBe(1);
      expect(expiry()).toBe(now + 30 * DAY);
      const after = expiry();
      for (const minutes of [62, 90, 120]) {
        now = T0 + minutes * MINUTE;
        await get('/rider/probe', token);
      }
      expect(writes()).toBe(1);
      expect(expiry()).toBe(after);
      now = T0 + 61 * MINUTE + HOUR + MINUTE; // more than an hour after the last write
      await get('/rider/probe', token);
      expect(writes()).toBe(2);
    });

    it('a session used every day never expires', async () => {
      const token = await riderToken();
      for (let day = 1; day <= 45; day++) {
        now = T0 + day * DAY;
        expect((await get('/rider/probe', token)).res.status).toBe(200);
      }
    });

    it('a driver session slides too', async () => {
      const token = await driverToken();
      now = T0 + 2 * HOUR;
      await get('/driver/probe', token);
      expect(db.calls['driverRefreshToken.updateMany']).toBe(1);
      expect(db.tables.driverRefreshToken[0].expiresAt.getTime()).toBe(now + 30 * DAY);
    });

    it('a refused request does not extend anything', async () => {
      const token = await riderToken();
      now = T0 + 2 * HOUR;
      await get('/driver/probe', token); // wrong domain
      expect(writes()).toBe(0);
    });
  });
});
