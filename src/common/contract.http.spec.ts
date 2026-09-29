import {
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Logger,
  Param,
  ParseIntPipe,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { CanActivate, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { AppException } from './errors/app.exception.js';
import { ERROR_REGISTRY, type ErrorCode } from './errors/error-registry.js';
import { setupApp } from './setup-app.js';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Loosely typed constructor, only so one route can throw any code taken from the path.
const LooseAppException = AppException as unknown as new (code: string) => AppException;

@Injectable()
class DenyUnauthorizedGuard implements CanActivate {
  canActivate(): boolean {
    throw new UnauthorizedException('secret-guard-message-401');
  }
}

@Injectable()
class DenyForbiddenGuard implements CanActivate {
  canActivate(): boolean {
    throw new ForbiddenException('secret-guard-message-403');
  }
}

@Injectable()
class DenyFalseGuard implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}

@Controller()
class ContractController {
  @Get('ok')
  ok() {
    return { fine: true };
  }

  @Get('throw/:code')
  throwCode(@Param('code') code: string): never {
    throw new LooseAppException(code);
  }

  @Get('guard-401')
  @UseGuards(DenyUnauthorizedGuard)
  guard401() {
    return { reached: true };
  }

  @Get('guard-403')
  @UseGuards(DenyForbiddenGuard)
  guard403() {
    return { reached: true };
  }

  @Get('guard-false')
  @UseGuards(DenyFalseGuard)
  guardFalse() {
    return { reached: true };
  }

  @Get('int/:id')
  int(@Param('id', ParseIntPipe) id: number) {
    return { id };
  }

  @Get('boom')
  boom(): never {
    throw new Error('secret-db-password-xyz');
  }
}

describe('HTTP contract for the response standard', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [ContractController],
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

  async function get(path: string) {
    const res = await fetch(`${baseUrl}${path}`);
    const body = await res.json();
    return { res, body };
  }

  function expectErrorEnvelope(body: any) {
    expect(Object.keys(body)).toEqual(['success', 'error', 'requestId']);
    expect(body.success).toBe(false);
    expect('data' in body).toBe(false);
    expect(body.requestId).toMatch(UUID_V4);
  }

  it.each(Object.keys(ERROR_REGISTRY) as ErrorCode[])(
    '%s replies with its registry status and message in the standard shape',
    async (code) => {
      const { res, body } = await get(`/throw/${code}`);
      const { status, message } = ERROR_REGISTRY[code];
      expect(res.status).toBe(status);
      expect(Object.keys(body)).toEqual(['success', 'error', 'requestId']);
      expect(Object.keys(body.error)).toEqual(['code', 'message', 'field']);
      expect(body.success).toBe(false);
      expect(body.error).toEqual({ code, message, field: null });
      expect(body.requestId).toMatch(UUID_V4);
      expect(res.headers.get('x-request-id')).toBe(body.requestId);
    },
  );

  describe('errors thrown by a real Guard', () => {
    it('turns a guard that throws UnauthorizedException into UNAUTHORIZED 401', async () => {
      const { res, body } = await get('/guard-401');
      expect(res.status).toBe(401);
      expectErrorEnvelope(body);
      expect(body.error.code).toBe('UNAUTHORIZED');
      expect(body.error.message).toBe(ERROR_REGISTRY.UNAUTHORIZED.message);
      expect(JSON.stringify(body)).not.toContain('secret-guard-message');
      expect(JSON.stringify(body)).not.toContain('reached');
    });

    it('turns a guard that throws ForbiddenException into FORBIDDEN 403', async () => {
      const { res, body } = await get('/guard-403');
      expect(res.status).toBe(403);
      expectErrorEnvelope(body);
      expect(body.error.code).toBe('FORBIDDEN');
      expect(body.error.message).toBe(ERROR_REGISTRY.FORBIDDEN.message);
      expect(JSON.stringify(body)).not.toContain('secret-guard-message');
      expect(JSON.stringify(body)).not.toContain('reached');
    });

    it('turns a guard that returns false into FORBIDDEN 403 and never reaches the handler', async () => {
      const { res, body } = await get('/guard-false');
      expect(res.status).toBe(403);
      expectErrorEnvelope(body);
      expect(body.error.code).toBe('FORBIDDEN');
      expect(body.error.message).toBe(ERROR_REGISTRY.FORBIDDEN.message);
      expect(JSON.stringify(body)).not.toContain('reached');
    });
  });

  describe('errors thrown by a real Pipe', () => {
    it('turns a ParseIntPipe failure into INVALID_INPUT 400 and never wraps it as success', async () => {
      const { res, body } = await get('/int/abc');
      expect(res.status).toBe(400);
      expectErrorEnvelope(body);
      expect(body.error.code).toBe('INVALID_INPUT');
      expect(body.error.message).toBe(ERROR_REGISTRY.INVALID_INPUT.message);
      // field is null for pipe errors today; F3.3 decides whether pipe errors carry a
      // field, and this assertion will change on purpose
      expect(body.error.field).toBeNull();
      const raw = JSON.stringify(body);
      expect(raw).not.toContain('Validation failed');
      expect(raw).not.toContain('numeric string');
    });

    it('lets a valid param through the same pipe (sanity check)', async () => {
      const { res, body } = await get('/int/42');
      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).toEqual({ id: 42 });
    });
  });

  it('gives 20 concurrent requests 20 different requestIds, each a UUID v4', async () => {
    const paths = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? '/ok' : '/boom'));
    const replies = await Promise.all(paths.map((path) => get(path)));
    const ids = replies.map(({ body }) => body.requestId as string);
    for (const { res, body } of replies) {
      expect(body.requestId).toMatch(UUID_V4);
      expect(res.headers.get('x-request-id')).toBe(body.requestId);
    }
    expect(new Set(ids).size).toBe(20);
  });

  it('keeps success and error bodies apart on one app instance', async () => {
    const success = await get('/ok');
    const failure = await get('/boom');

    expect(success.body.success).toBe(true);
    expect('data' in success.body).toBe(true);
    expect('error' in success.body).toBe(false);

    expect(failure.body.success).toBe(false);
    expect('error' in failure.body).toBe(true);
    expect('data' in failure.body).toBe(false);

    expect(success.body.requestId).toMatch(UUID_V4);
    expect(failure.body.requestId).toMatch(UUID_V4);
    expect(success.body.requestId).not.toBe(failure.body.requestId);
  });
});
