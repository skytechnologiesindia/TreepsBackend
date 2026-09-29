import { Body, Controller, Get, Logger, Post } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { AppException } from '../errors/app.exception.js';
import { setupApp } from '../setup-app.js';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Controller()
class TestController {
  @Post('echo')
  echo(@Body() body: unknown) {
    return body;
  }

  @Get('boom')
  boom(): never {
    throw new Error('secret-db-password-xyz');
  }

  @Get('app-error')
  appError(): never {
    throw new AppException('OUT_OF_SERVICE_AREA', { field: 'pickupLat' });
  }
}

describe('AllExceptionsFilter over real HTTP', () => {
  let app: INestApplication;
  let baseUrl: string;
  let errorLog: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [TestController],
    }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  async function expectErrorReply(res: Response, status: number, code: string) {
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(['success', 'error', 'requestId']);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe(code);
    expect(body.error.field).toBeNull();
    expect(body.requestId).toMatch(UUID_V4);
    expect(res.headers.get('x-request-id')).toBe(body.requestId);
    return body;
  }

  it('turns malformed JSON into INVALID_INPUT 400 with the standard shape and a requestId', async () => {
    const res = await fetch(`${baseUrl}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"a": ',
    });
    await expectErrorReply(res, 400, 'INVALID_INPUT');
  });

  it('turns an unknown route into NOT_FOUND 404', async () => {
    const res = await fetch(`${baseUrl}/no-such-route`);
    await expectErrorReply(res, 404, 'NOT_FOUND');
  });

  it('turns a crash into INTERNAL_ERROR 500 with no secret text and logs it with the requestId', async () => {
    const res = await fetch(`${baseUrl}/boom`);
    const raw = JSON.stringify(await expectErrorReply(res, 500, 'INTERNAL_ERROR'));
    expect(raw).not.toContain('secret-db-password-xyz');
    expect(raw).not.toContain('stack');
    const requestId = res.headers.get('x-request-id');
    expect(
      errorLog.mock.calls.some((call: unknown[]) =>
        String(call[0]).includes(`requestId=${requestId}`),
      ),
    ).toBe(true);
  });

  it('replies to an AppException with its registry status, message and field', async () => {
    const res = await fetch(`${baseUrl}/app-error`);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toEqual({
      code: 'OUT_OF_SERVICE_AREA',
      message: "We don't serve this area yet.",
      field: 'pickupLat',
    });
  });

  it('treats an oversized body as a client error (INVALID_INPUT 400), not INTERNAL_ERROR', async () => {
    const res = await fetch(`${baseUrl}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blob: 'x'.repeat(300_000) }),
    });
    await expectErrorReply(res, 400, 'INVALID_INPUT');
  });
});
