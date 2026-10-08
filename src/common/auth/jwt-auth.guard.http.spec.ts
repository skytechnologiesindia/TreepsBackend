import { Controller, Get, UseGuards } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CLOCK } from '../clock.js';
import { AccessTokenService, type AccessTokenClaims } from '../jwt/access-token.service.js';
import { setupApp } from '../setup-app.js';
import { versionedBaseUrl } from '../testing/base-url.js';
import { AuthUser } from './auth-user.decorator.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';

const SECRET = 'placeholder-jwt-secret-0123456789abcdef';
const T0 = new Date('2026-10-05T10:00:00.000Z');

// One probe route in each domain, so the domain rule is tested on a /v1/driver/* route too (no real
// guarded driver route exists yet).
@Controller('rider/probe')
class RiderProbe {
  @UseGuards(JwtAuthGuard)
  @Get()
  who(@AuthUser() user: AccessTokenClaims) {
    return user;
  }
}
@Controller('driver/probe')
class DriverProbe {
  @UseGuards(JwtAuthGuard)
  @Get()
  who(@AuthUser() user: AccessTokenClaims) {
    return user;
  }
}

describe('JwtAuthGuard', () => {
  let app: INestApplication;
  let now = T0.getTime();
  const tokens = new AccessTokenService(SECRET);
  const rider = () => tokens.issue({ riderId: 'rider-1', deviceId: 'device-1', now: new Date(now) }).token;
  const driver = () => tokens.issueForDriver({ driverId: 'driver-1', deviceId: 'device-2', now: new Date(now) }).token;

  beforeEach(async () => {
    now = T0.getTime();
    const moduleRef = await Test.createTestingModule({
      controllers: [RiderProbe, DriverProbe],
      providers: [
        { provide: AccessTokenService, useValue: tokens },
        { provide: CLOCK, useValue: () => new Date(now) },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.listen(0, '127.0.0.1');
  });
  afterEach(async () => {
    await app.close();
  });

  const get = async (path: string, token?: string) => {
    const res = await fetch(`${versionedBaseUrl(app)}${path}`, { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });
    return { res, body: await res.json() };
  };

  it('a RIDER token on a rider route: userId, role and deviceId reach the handler', async () => {
    const { res, body } = await get('/rider/probe', rider());
    expect(res.status).toBe(200);
    expect(body.data).toEqual({ userId: 'rider-1', role: 'RIDER', deviceId: 'device-1' });
  });

  it('a DRIVER token on a driver route', async () => {
    const { res, body } = await get('/driver/probe', driver());
    expect(res.status).toBe(200);
    expect(body.data).toEqual({ userId: 'driver-1', role: 'DRIVER', deviceId: 'device-2' });
  });

  it('a RIDER token on a driver route is 403 FORBIDDEN', async () => {
    const { res, body } = await get('/driver/probe', rider());
    expect(res.status).toBe(403);
    expect(body.error).toEqual({ code: 'FORBIDDEN', message: "You don't have access to this.", field: null });
  });

  it('a DRIVER token on a rider route is 403 FORBIDDEN', async () => {
    const { res, body } = await get('/rider/probe', driver());
    expect(res.status).toBe(403);
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it.each(['/rider/probe', '/driver/probe'])('no token on %s is 401 UNAUTHORIZED', async (path) => {
    const { res, body } = await get(path);
    expect(res.status).toBe(401);
    expect(body.error).toEqual({ code: 'UNAUTHORIZED', message: 'Please log in again.', field: null });
  });

  it('a malformed token is 401', async () => {
    expect((await get('/rider/probe', 'abc')).res.status).toBe(401);
  });

  it('an expired token is 401, also on a driver route', async () => {
    const token = driver();
    now += 15 * 60_000;
    expect((await get('/driver/probe', token)).res.status).toBe(401);
  });

  it('a token signed with another secret is 401, not 403', async () => {
    const forged = new AccessTokenService('another-secret-0123456789abcdefghij').issue({ riderId: 'rider-1', deviceId: 'd', now: new Date(now) }).token;
    expect((await get('/driver/probe', forged)).res.status).toBe(401);
  });
});
