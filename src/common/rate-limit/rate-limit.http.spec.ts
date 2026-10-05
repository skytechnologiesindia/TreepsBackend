import { Body, Controller, Post } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { setupApp } from '../setup-app.js';
import { versionedBaseUrl } from '../testing/base-url.js';
import { IndianMobile, Required } from '../validation/fields.js';
import { RateLimit } from './rate-limit.decorator.js';
import { RateLimiter } from './rate-limiter.js';

class PhoneDto {
  @Required(IndianMobile()) phoneNumber!: string;
}

// Throwaway routes. The numbers are test-local, not the real limits.
@Controller('probe')
class ProbeController {
  @RateLimit({ name: 'by-ip', ip: { limit: 2, windowMs: 60_000 } })
  @Post('ip')
  byIp() {
    return { ok: true };
  }

  @RateLimit({ name: 'by-phone', phone: { limit: 2, windowMs: 60_000 } })
  @Post('phone')
  byPhone(@Body() _body: PhoneDto) {
    return { ok: true };
  }

  @Post('open')
  open() {
    return { ok: true };
  }
}

async function startApp(hops: number) {
  const moduleRef = await Test.createTestingModule({
    controllers: [ProbeController],
    providers: [
      { provide: ConfigService, useValue: { get: () => hops } },
      { provide: RateLimiter, useFactory: () => new RateLimiter() },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  setupApp(app);
  await app.listen(0, '127.0.0.1');
  return app;
}

async function post(app: INestApplication, path: string, headers: Record<string, string> = {}, body: unknown = {}) {
  const res = await fetch(`${versionedBaseUrl(app)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { res, body: await res.json() };
}

describe('@RateLimit over real HTTP, TRUST_PROXY_HOPS = 0', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await startApp(0);
  });
  afterAll(async () => {
    await app.close();
  });

  it('lets requests through under the limit, then replies RATE_LIMITED 429 in the standard envelope', async () => {
    expect((await post(app, '/probe/ip')).res.status).toBe(201);
    expect((await post(app, '/probe/ip')).res.status).toBe(201);
    const { res, body } = await post(app, '/probe/ip');
    expect(res.status).toBe(429);
    expect(body.success).toBe(false);
    expect(body.error).toEqual({ code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.', field: null });
    expect(body.requestId).toBe(res.headers.get('x-request-id'));
    expect(Object.keys(body).sort()).toEqual(['error', 'requestId', 'success']);
  });

  it('sends no Retry-After header (the docs do not say to; TO DECIDE)', async () => {
    const { res } = await post(app, '/probe/ip');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeNull();
  });

  it('ignores X-Forwarded-For when hops is 0: a changed header does not give a fresh counter', async () => {
    const { res } = await post(app, '/probe/ip', { 'x-forwarded-for': '198.51.100.77' });
    expect(res.status).toBe(429);
  });

  it('a route without @RateLimit is never limited', async () => {
    for (let i = 0; i < 10; i++) expect((await post(app, '/probe/open')).res.status).toBe(201);
  });

  it('limits by the phone in the body, and a different phone has its own counter', async () => {
    const a = { phoneNumber: '+919477172214' };
    const b = { phoneNumber: '+919477172215' };
    expect((await post(app, '/probe/phone', {}, a)).res.status).toBe(201);
    expect((await post(app, '/probe/phone', {}, a)).res.status).toBe(201);
    expect((await post(app, '/probe/phone', {}, a)).res.status).toBe(429);
    expect((await post(app, '/probe/phone', {}, b)).res.status).toBe(201);
  });

  it('a phone in the wrong shape is not counted: the validation pipe rejects it as INVALID_INPUT', async () => {
    for (let i = 0; i < 5; i++) {
      const { res, body } = await post(app, '/probe/phone', {}, { phoneNumber: '9477172214' });
      expect(res.status).toBe(400);
      expect(body.error.code).toBe('INVALID_INPUT');
    }
    expect((await post(app, '/probe/phone', {}, null)).res.status).toBe(400);
  });
});

describe('@RateLimit over real HTTP, TRUST_PROXY_HOPS = 1', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await startApp(1);
  });
  afterAll(async () => {
    await app.close();
  });

  it('uses X-Forwarded-For: each forwarded client has its own counter', async () => {
    const one = { 'x-forwarded-for': '198.51.100.1' };
    const two = { 'x-forwarded-for': '198.51.100.2' };
    expect((await post(app, '/probe/ip', one)).res.status).toBe(201);
    expect((await post(app, '/probe/ip', one)).res.status).toBe(201);
    expect((await post(app, '/probe/ip', one)).res.status).toBe(429);
    expect((await post(app, '/probe/ip', two)).res.status).toBe(201);
  });

  it('a client cannot dodge the limit by writing extra entries on the left', async () => {
    const headers = (spoof: string) => ({ 'x-forwarded-for': `${spoof}, 198.51.100.3` });
    expect((await post(app, '/probe/ip', headers('1.1.1.1'))).res.status).toBe(201);
    expect((await post(app, '/probe/ip', headers('2.2.2.2'))).res.status).toBe(201);
    expect((await post(app, '/probe/ip', headers('3.3.3.3'))).res.status).toBe(429);
  });
});
