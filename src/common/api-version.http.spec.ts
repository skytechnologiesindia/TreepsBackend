import { Controller, Get, Logger, Version, VERSION_NEUTRAL } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { API_VERSION } from './api-version.js';
import { setupApp } from './setup-app.js';
import { rawBaseUrl } from './testing/base-url.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Controller('things')
class DefaultVersionController {
  @Get()
  list() {
    return { from: 'default' };
  }
}

@Controller({ path: 'things', version: '2' })
class VersionTwoController {
  @Get('two')
  two() {
    return { from: 'v2' };
  }
}

@Controller({ path: 'health', version: VERSION_NEUTRAL })
class HealthController {
  @Get()
  health() {
    return { ok: true };
  }
}

@Controller('mixed')
class MixedController {
  @Get('old')
  old() {
    return { from: 'v1' };
  }

  @Version('2')
  @Get('old')
  newer() {
    return { from: 'v2' };
  }
}

describe('URI versioning applied by setupApp', () => {
  let app: INestApplication;
  let host: string;

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [DefaultVersionController, VersionTwoController, HealthController, MixedController],
    }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.listen(0, '127.0.0.1');
    host = rawBaseUrl(app);
  });

  afterAll(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  async function get(path: string) {
    const res = await fetch(`${host}${path}`);
    return { res, body: await res.json() };
  }

  function expectNotFoundEnvelope(res: Response, body: any) {
    expect(res.status).toBe(404);
    expect(Object.keys(body)).toEqual(['success', 'error', 'requestId']);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.requestId).toMatch(UUID_V4);
    expect(res.headers.get('x-request-id')).toBe(body.requestId);
  }

  it('the default version is the whole number 1', () => {
    expect(API_VERSION).toBe('1');
  });

  it('a route with no version annotation is served under /v1', async () => {
    const { res, body } = await get('/v1/things');
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ success: true, data: { from: 'default' } });
    expect(res.headers.get('x-request-id')).toBe(body.requestId);
  });

  it('the same path without /v1 is the NOT_FOUND envelope', async () => {
    const { res, body } = await get('/things');
    expectNotFoundEnvelope(res, body);
  });

  it('an unknown route under /v1 is the NOT_FOUND envelope', async () => {
    const { res, body } = await get('/v1/nope');
    expectNotFoundEnvelope(res, body);
  });

  it('a request for an unknown version is the NOT_FOUND envelope', async () => {
    for (const path of ['/v2/anything', '/v3/things', '/v0/things', '/v01/things']) {
      const { res, body } = await get(path);
      expectNotFoundEnvelope(res, body);
    }
  });

  it('/V1 also works, because Express matches paths without regard to case', async () => {
    const { res } = await get('/V1/things');
    expect(res.status).toBe(200);
  });

  it('a controller marked version 2 is served under /v2 and not under /v1', async () => {
    const ok = await get('/v2/things/two');
    expect(ok.res.status).toBe(200);
    expect(ok.body.data).toEqual({ from: 'v2' });
    const wrong = await get('/v1/things/two');
    expectNotFoundEnvelope(wrong.res, wrong.body);
  });

  it('one path can answer differently under /v1 and /v2', async () => {
    expect((await get('/v1/mixed/old')).body.data).toEqual({ from: 'v1' });
    expect((await get('/v2/mixed/old')).body.data).toEqual({ from: 'v2' });
  });

  it('a version-neutral route is served at /health and not under /v1', async () => {
    const ok = await get('/health');
    expect(ok.res.status).toBe(200);
    expect(ok.body.data).toEqual({ ok: true });
    const prefixed = await get('/v1/health');
    expectNotFoundEnvelope(prefixed.res, prefixed.body);
  });

  it('every reply above carries a UUID v4 X-Request-Id header, including the refused ones', async () => {
    for (const path of ['/v1/things', '/things', '/v1/nope', '/v2/anything', '/health', '/v1/health']) {
      const res = await fetch(`${host}${path}`);
      expect(res.headers.get('x-request-id'), path).toMatch(UUID_V4);
    }
  });
});
