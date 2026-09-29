import { Body, Controller, Post } from '@nestjs/common';
import type { INestApplication, Type } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  assertRouteInputs,
  controllersOf,
  findRouteInputProblems,
  ROUTE_INPUT_ALLOWLIST,
} from './route-inputs.js';

// CI guard over the REAL application modules. The test sets its own dummy environment before
// AppModule is imported, and replaces PrismaService with an empty object, so it never uses a
// developer's values and never touches a database.
const FAKE_DATABASE_URL = 'postgresql://user:pass@127.0.0.1:1/x';

@Controller('probe')
class BrokenControllerAddedLater {
  @Post()
  create(@Body() body: { name: string }) {
    return body;
  }
}

describe('the route input check over the real application', () => {
  let AppModule: Type<unknown>;
  let moduleRef: TestingModule;
  let app: INestApplication;

  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', FAKE_DATABASE_URL);
    vi.stubEnv('NODE_ENV', 'test');
    ({ AppModule } = await import('../../app.module.js'));
    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();
    app = moduleRef.createNestApplication();
  });

  afterAll(async () => {
    await moduleRef.close();
    vi.unstubAllEnvs();
  });

  it('never used a developer database: the dummy URL is in force and PrismaService is an empty stand-in', () => {
    expect(process.env.DATABASE_URL).toBe(FAKE_DATABASE_URL);
    expect(moduleRef.get(PrismaService)).toEqual({});
  });

  it('the scan sees the real controllers (it is not vacuous)', () => {
    const names = controllersOf(app).map((c) => c.name);
    expect(names).toContain('AppController');
    expect(names).toContain('AuthController');
  });

  it('every production route passes the check', () => {
    expect(() => assertRouteInputs(app)).not.toThrow();
    expect(findRouteInputProblems(controllersOf(app))).toEqual([]);
  });

  it('the allowlist has exactly one entry', () => {
    expect(ROUTE_INPUT_ALLOWLIST).toEqual([
      { controller: 'AuthController', handler: 'login', reason: 'remove in F4' },
    ]);
  });

  it('without the allowlist, the login route is the ONLY production violation', () => {
    const problems = findRouteInputProblems(controllersOf(app), []);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('AuthController.login');
    expect(problems[0]).toContain('reads one named value');
  });

  it('a real controller that breaks the rule would fail this test', async () => {
    const broken = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [BrokenControllerAddedLater],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();
    const brokenApp = broken.createNestApplication();
    expect(() => assertRouteInputs(brokenApp)).toThrow(/BrokenControllerAddedLater\.create/);
    await broken.close();
  });
});
