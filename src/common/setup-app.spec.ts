import { Controller, Get } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { setupApp } from './setup-app.js';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Controller()
class PingController {
  @Get('ping')
  ping() {
    return { ok: true };
  }
}

describe('setupApp: request id', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PingController],
    }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('sets a UUID v4 X-Request-Id header on a normal reply', async () => {
    const res = await fetch(`${baseUrl}/ping`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toMatch(UUID_V4);
  });

  it('sets the header on an unknown route too', async () => {
    const res = await fetch(`${baseUrl}/no-such-route`);
    expect(res.status).toBe(404);
    expect(res.headers.get('x-request-id')).toMatch(UUID_V4);
  });

  it('ignores a client-sent X-Request-Id over real HTTP', async () => {
    const res = await fetch(`${baseUrl}/ping`, {
      headers: { 'X-Request-Id': 'forged-by-client' },
    });
    const id = res.headers.get('x-request-id');
    expect(id).not.toBe('forged-by-client');
    expect(id).toMatch(UUID_V4);
  });
});
