import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { CLOCK } from '../../common/clock.js';
import { RateLimiter } from '../../common/rate-limit/rate-limiter.js';
import { setupApp } from '../../common/setup-app.js';
import { rawBaseUrl, versionedBaseUrl } from '../../common/testing/base-url.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SendOtpService } from '../otp/send-otp.service.js';
import { OTP_PROVIDER, type OtpProvider } from '../otp/provider/otp-provider.js';
import { inMemoryPrisma } from '../otp/testing/in-memory-prisma.js';
import { SessionService } from '../../common/session/session.service.js';
import { RiderAuthController } from '../rider-auth/rider-auth.controller.js';
import { VerifyOtpService } from '../rider-auth/verify-otp.service.js';
import { RegisterService } from '../rider-auth/register.service.js';
import { DriverAuthController } from './driver-auth.controller.js';
import { DriverVerifyOtpService } from './driver-verify-otp.service.js';

const SECOND = 1000;
const HOUR = 3_600_000;

// Real HTTP, real pipe, filter, interceptor and rate-limit guard. Both the rider and the driver
// controllers are mounted on one app and share one database, provider, clock and limiter, so the
// tests can show that the two purposes do not affect each other.
async function startApp(options: { failingProvider?: boolean } = {}) {
  let now = new Date('2026-10-06T10:00:00.000Z').getTime();
  const { prisma, rows } = inMemoryPrisma();
  let providerCalls = 0;
  const provider: OtpProvider = {
    async send() {
      providerCalls += 1;
      if (options.failingProvider) throw new Error('SECRET-provider-down');
      return { providerSessionId: `SECRET-SESSION-${providerCalls}` };
    },
    async verify() {
      return false;
    },
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [DriverAuthController, RiderAuthController],
    providers: [
      SendOtpService,
      VerifyOtpService,
      RegisterService,
      DriverVerifyOtpService,
      SessionService,
      { provide: PrismaService, useValue: prisma },
      { provide: OTP_PROVIDER, useValue: provider },
      { provide: CLOCK, useValue: () => new Date(now) },
      { provide: ConfigService, useValue: { get: () => 0 } },
      { provide: RateLimiter, useFactory: () => new RateLimiter() },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  setupApp(app);
  await app.listen(0, '127.0.0.1');
  return { app, rows, advance: (ms: number) => (now += ms), providerCalls: () => providerCalls };
}
type Ctx = Awaited<ReturnType<typeof startApp>>;

type Who = 'rider' | 'driver';
async function post(app: INestApplication, who: Who, body: unknown, base: 'versioned' | 'raw' = 'versioned') {
  const url = `${base === 'versioned' ? versionedBaseUrl(app) : rawBaseUrl(app)}/${who}/auth/send-otp`;
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { res, body: await res.json() };
}
const phone = (n: number) => `+9194771722${String(n).padStart(2, '0')}`;

describe('POST /v1/driver/auth/send-otp', () => {
  describe('success', () => {
    let ctx: Ctx;
    beforeEach(async () => {
      ctx = await startApp();
    });
    afterEach(async () => {
      await ctx.app.close();
    });

    it('replies 200 in the standard envelope with only the two documented numbers', async () => {
      const { res, body } = await post(ctx.app, 'driver', { phoneNumber: phone(14) });
      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).toEqual({ expiresInSeconds: 300, resendAfterSeconds: 30 });
      expect(Object.keys(body).sort()).toEqual(['data', 'requestId', 'success']);
      expect(body.requestId).toBe(res.headers.get('x-request-id'));
    });

    it('stores one OtpSession with purpose DRIVER_AUTH and never returns the provider session id', async () => {
      const { body } = await post(ctx.app, 'driver', { phoneNumber: phone(14) });
      expect(ctx.rows).toHaveLength(1);
      expect(ctx.rows[0]).toMatchObject({ phoneNumber: phone(14), purpose: 'DRIVER_AUTH', providerSessionId: 'SECRET-SESSION-1' });
      expect(JSON.stringify(body)).not.toContain('SECRET');
    });

    it('the rider route still stores RIDER_AUTH', async () => {
      await post(ctx.app, 'rider', { phoneNumber: phone(14) });
      expect(ctx.rows.map((r) => r.purpose)).toEqual(['RIDER_AUTH']);
    });

    it('gives the same reply for different phones', async () => {
      const a = await post(ctx.app, 'driver', { phoneNumber: phone(14) });
      const b = await post(ctx.app, 'driver', { phoneNumber: phone(15) });
      expect(a.body.data).toEqual(b.body.data);
    });

    it('is not served without the /v1 prefix (NOT_FOUND)', async () => {
      const { res, body } = await post(ctx.app, 'driver', { phoneNumber: phone(14) }, 'raw');
      expect(res.status).toBe(404);
      expect(body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('the purpose is fixed by the route', () => {
    let ctx: Ctx;
    beforeAll(async () => {
      ctx = await startApp();
    });
    afterAll(async () => {
      await ctx.app.close();
    });

    it('a client-sent purpose is an unknown field and is rejected, on both routes', async () => {
      for (const who of ['driver', 'rider'] as const) {
        const { res, body } = await post(ctx.app, who, { phoneNumber: phone(14), purpose: 'DRIVER_AUTH' });
        expect(res.status).toBe(400);
        expect(body.error.code).toBe('INVALID_INPUT');
        expect(body.error.details).toEqual([{ field: 'purpose', reason: 'UNKNOWN_FIELD' }]);
      }
      expect(ctx.rows).toHaveLength(0);
      expect(ctx.providerCalls()).toBe(0);
    });
  });

  describe('invalid input: INVALID_INPUT 400 and nothing is sent', () => {
    let ctx: Ctx;
    beforeAll(async () => {
      ctx = await startApp();
    });
    afterAll(async () => {
      await ctx.app.close();
    });

    it.each([
      ['no +91', '9477172214'],
      ['starts with 5', '+915477172214'],
      ['9 digits', '+91947717221'],
      ['11 digits', '+9194771722141'],
      ['a space', '+91 9477172214'],
      ['leading space', ' +919477172214'],
      ['not India', '+449477172214'],
    ])('rejects a phone with %s', async (_name, phoneNumber) => {
      const { res, body } = await post(ctx.app, 'driver', { phoneNumber });
      expect(res.status).toBe(400);
      expect(body.error.details).toEqual([{ field: 'phoneNumber', reason: 'INVALID_FORMAT' }]);
    });

    it('a number is WRONG_TYPE, a missing phone is REQUIRED, otp is an unknown field', async () => {
      expect((await post(ctx.app, 'driver', { phoneNumber: 9477172214 })).body.error.details).toEqual([{ field: 'phoneNumber', reason: 'WRONG_TYPE' }]);
      expect((await post(ctx.app, 'driver', {})).body.error.details).toEqual([{ field: 'phoneNumber', reason: 'REQUIRED' }]);
      expect((await post(ctx.app, 'driver', { phoneNumber: phone(14), otp: '123456' })).body.error.details).toEqual([{ field: 'otp', reason: 'UNKNOWN_FIELD' }]);
    });

    it('stored nothing and called the provider zero times', () => {
      expect(ctx.rows).toHaveLength(0);
      expect(ctx.providerCalls()).toBe(0);
    });
  });

  describe('429 RATE_LIMITED', () => {
    it('inside the 30 second cooldown, then allowed after 30 seconds', async () => {
      const { app, rows, advance, providerCalls } = await startApp();
      try {
        expect((await post(app, 'driver', { phoneNumber: phone(14) })).res.status).toBe(200);
        advance(10 * SECOND);
        const blocked = await post(app, 'driver', { phoneNumber: phone(14) });
        expect(blocked.res.status).toBe(429);
        expect(blocked.body.error).toEqual({ code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.', field: null });
        expect(providerCalls()).toBe(1);
        expect(rows).toHaveLength(1);
        advance(20 * SECOND);
        expect((await post(app, 'driver', { phoneNumber: phone(14) })).res.status).toBe(200);
      } finally {
        await app.close();
      }
    });

    it('the sixth send for one phone in an hour, and allowed again after the hour', async () => {
      const { app, advance } = await startApp();
      try {
        for (let i = 0; i < 5; i++) {
          expect((await post(app, 'driver', { phoneNumber: phone(14) })).res.status).toBe(200);
          advance(31 * SECOND);
        }
        expect((await post(app, 'driver', { phoneNumber: phone(14) })).res.status).toBe(429);
        advance(HOUR);
        expect((await post(app, 'driver', { phoneNumber: phone(14) })).res.status).toBe(200);
      } finally {
        await app.close();
      }
    });

    it('the 21st request from one IP in an hour, even with different phones', async () => {
      const { app, providerCalls } = await startApp();
      try {
        for (let i = 0; i < 20; i++) expect((await post(app, 'driver', { phoneNumber: phone(i) })).res.status).toBe(200);
        const blocked = await post(app, 'driver', { phoneNumber: phone(50) });
        expect(blocked.res.status).toBe(429);
        expect(blocked.body.error.code).toBe('RATE_LIMITED');
        expect(providerCalls()).toBe(20);
      } finally {
        await app.close();
      }
    });
  });

  describe('a rider session does not count toward the driver limits', () => {
    it('the same phone can get a rider code and a driver code in the same second', async () => {
      const { app, rows } = await startApp();
      try {
        expect((await post(app, 'rider', { phoneNumber: phone(14) })).res.status).toBe(200);
        expect((await post(app, 'driver', { phoneNumber: phone(14) })).res.status).toBe(200);
        expect(rows.map((r) => r.purpose)).toEqual(['RIDER_AUTH', 'DRIVER_AUTH']);
        // each purpose still has its own cooldown
        expect((await post(app, 'rider', { phoneNumber: phone(14) })).res.status).toBe(429);
        expect((await post(app, 'driver', { phoneNumber: phone(14) })).res.status).toBe(429);
      } finally {
        await app.close();
      }
    });

    it('five rider sends in the hour do not use up the driver sends, and the other way round', async () => {
      const { app, advance, rows } = await startApp();
      try {
        for (let i = 0; i < 5; i++) {
          expect((await post(app, 'rider', { phoneNumber: phone(14) })).res.status).toBe(200);
          advance(31 * SECOND);
        }
        expect((await post(app, 'rider', { phoneNumber: phone(14) })).res.status).toBe(429);
        for (let i = 0; i < 5; i++) {
          expect((await post(app, 'driver', { phoneNumber: phone(14) })).res.status).toBe(200);
          advance(31 * SECOND);
        }
        expect((await post(app, 'driver', { phoneNumber: phone(14) })).res.status).toBe(429);
        expect(rows.filter((r) => r.purpose === 'RIDER_AUTH')).toHaveLength(5);
        expect(rows.filter((r) => r.purpose === 'DRIVER_AUTH')).toHaveLength(5);
      } finally {
        await app.close();
      }
    });

    it('the driver and rider IP counters are separate: 20 rider requests do not block a driver', async () => {
      const { app } = await startApp();
      try {
        for (let i = 0; i < 20; i++) expect((await post(app, 'rider', { phoneNumber: phone(i) })).res.status).toBe(200);
        expect((await post(app, 'rider', { phoneNumber: phone(60) })).res.status).toBe(429);
        expect((await post(app, 'driver', { phoneNumber: phone(60) })).res.status).toBe(200);
      } finally {
        await app.close();
      }
    });
  });

  describe('503 OTP_PROVIDER_ERROR', () => {
    it('replies 503 in the envelope, stores nothing, calls the provider once, and leaks no provider text', async () => {
      const { app, rows, providerCalls } = await startApp({ failingProvider: true });
      try {
        const { res, body } = await post(app, 'driver', { phoneNumber: phone(14) });
        expect(res.status).toBe(503);
        expect(body.success).toBe(false);
        expect(body.error).toEqual({ code: 'OTP_PROVIDER_ERROR', message: "We couldn't reach the code service. Please try again.", field: null });
        expect(JSON.stringify(body)).not.toContain('SECRET');
        expect(rows).toHaveLength(0);
        expect(providerCalls()).toBe(1);
      } finally {
        await app.close();
      }
    });
  });
});
