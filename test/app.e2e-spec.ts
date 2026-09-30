import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, Type } from '@nestjs/common';
import request from 'supertest';
import { setupApp } from './../src/common/setup-app.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

// The only test that boots the real AppModule, so it must test what production serves: the
// same setupApp wiring (request id, envelope, filter, pipe). It sets its own dummy environment
// before AppModule is imported (the module validates the environment when it is defined) and
// replaces PrismaService with an empty stand-in, so it never uses a developer's .env and can
// never connect to a database.
const FAKE_DATABASE_URL = 'postgresql://user:pass@127.0.0.1:1/x';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('AppController (e2e)', () => {
  let app: INestApplication;
  let moduleFixture: TestingModule;

  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', FAKE_DATABASE_URL);
    vi.stubEnv('NODE_ENV', 'test');
    const { AppModule } = (await import('./../src/app.module.js')) as { AppModule: Type<unknown> };

    moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    app = moduleFixture.createNestApplication();
    setupApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  // This assertion changed on purpose. The old one expected the raw body 'Hello World!', which
  // describes a reply that production no longer sends: every reply is wrapped in the envelope.
  // The route also moved from / to /v1 (F3.4): setupApp applies the default version.
  it('/v1 (GET) returns the success envelope', async () => {
    const response = await request(app.getHttpServer()).get('/v1').expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data).toBe('Hello World!');
    expect(Object.keys(response.body).sort()).toEqual(['data', 'requestId', 'success']);
    expect(response.body.requestId).toMatch(UUID_V4);
    expect(response.headers['x-request-id']).toBe(response.body.requestId);
  });

  function expectNotFoundEnvelope(response: request.Response) {
    expect(response.status).toBe(404);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(Object.keys(response.body).sort()).toEqual(['error', 'requestId', 'success']);
    expect(response.body.requestId).toMatch(UUID_V4);
    expect(response.headers['x-request-id']).toBe(response.body.requestId);
  }

  it('/ (GET) without a version is the NOT_FOUND envelope', async () => {
    expectNotFoundEnvelope(await request(app.getHttpServer()).get('/'));
  });

  it('/v2/x (GET), an unknown version, is the NOT_FOUND envelope', async () => {
    expectNotFoundEnvelope(await request(app.getHttpServer()).get('/v2/x'));
  });

  it('POST /auth/login without a version is 404, and POST /v1/auth/login is served', async () => {
    expectNotFoundEnvelope(await request(app.getHttpServer()).post('/auth/login').send({}));
    // Only "the route exists" is asserted; the login behavior is frozen until F4.
    const versioned = await request(app.getHttpServer()).post('/v1/auth/login').send({});
    expect(versioned.status).not.toBe(404);
  });

  it('an unknown route returns 404 with the error envelope', async () => {
    const response = await request(app.getHttpServer()).get('/no-such-route').expect(404);

    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(Object.keys(response.body).sort()).toEqual(['error', 'requestId', 'success']);
    expect(response.body.requestId).toMatch(UUID_V4);
    expect(response.headers['x-request-id']).toBe(response.body.requestId);
  });
});
