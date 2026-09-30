import { Body, Controller, Get, HttpCode, Logger, Post } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { setupApp } from '../setup-app.js';
import { versionedBaseUrl } from '../testing/base-url.js';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Controller()
class TestController {
  @Post('items')
  create(@Body() body: { name: string }) {
    return { id: 'abc', name: body.name };
  }

  @Post('accepted')
  @HttpCode(202)
  accepted() {
    return { queued: true };
  }

  @Get('nothing')
  nothing() {
    return undefined;
  }

  @Get('list')
  list() {
    return [1, 2, 3];
  }

  @Get('legacy-shape')
  legacy() {
    return { message: 'hi', statusCode: 999, data: { x: 1 } };
  }

  @Get('boom')
  boom(): never {
    throw new Error('secret-db-password-xyz');
  }
}

describe('ResponseInterceptor over real HTTP', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [TestController],
    }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.listen(0, '127.0.0.1');
    baseUrl = versionedBaseUrl(app);
  });

  afterAll(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  function postJson(path: string, payload: unknown) {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  it('POST returns 201 with the exact success envelope', async () => {
    const res = await postJson('/items', { name: 'x' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(['success', 'data', 'requestId']);
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ id: 'abc', name: 'x' });
    expect(body.requestId).toMatch(UUID_V4);
  });

  it('keeps a status set by the API (HttpCode 202) and wraps the result', async () => {
    const res = await postJson('/accepted', {});
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.data).toEqual({ queued: true });
  });

  it('a GET returning undefined gives 200 with data: null (the key is present)', async () => {
    const res = await fetch(`${baseUrl}/nothing`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect('data' in body).toBe(true);
    expect(body.data).toBeNull();
  });

  it('passes an array through under data', async () => {
    const res = await fetch(`${baseUrl}/list`);
    const body = await res.json();
    expect(body.data).toEqual([1, 2, 3]);
  });

  it('does not unwrap a returned { message, statusCode, data } object and does not change the HTTP status', async () => {
    const res = await fetch(`${baseUrl}/legacy-shape`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(['success', 'data', 'requestId']);
    expect(body.data).toEqual({ message: 'hi', statusCode: 999, data: { x: 1 } });
  });

  it('puts the same requestId in the body and in the X-Request-Id header (GET and POST)', async () => {
    const get = await fetch(`${baseUrl}/list`);
    const getBody = await get.json();
    expect(get.headers.get('x-request-id')).toBe(getBody.requestId);
    expect(getBody.requestId).toMatch(UUID_V4);

    const post = await postJson('/items', { name: 'y' });
    const postBody = await post.json();
    expect(post.headers.get('x-request-id')).toBe(postBody.requestId);
  });

  it('does not wrap a thrown error in the success envelope: it is the error envelope from the filter', async () => {
    const res = await fetch(`${baseUrl}/boom`);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(['success', 'error', 'requestId']);
    expect(body.success).toBe(false);
    expect('data' in body).toBe(false);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(body)).not.toContain('secret-db-password-xyz');
  });
});
