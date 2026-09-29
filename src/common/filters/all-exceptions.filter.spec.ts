import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  Logger,
  MethodNotAllowedException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { AppException } from '../errors/app.exception.js';
import { ERROR_REGISTRY, type ErrorCode } from '../errors/error-registry.js';
import { AllExceptionsFilter } from './all-exceptions.filter.js';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function run(
  exception: unknown,
  req: Record<string, unknown> = { requestId: 'req-1' },
  headersSent = false,
) {
  const headers: Record<string, string> = {};
  const res = {
    headersSent,
    statusCode: undefined as number | undefined,
    body: undefined as any,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  const host = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter().catch(exception, host);
  return { res, headers, req };
}

function expectReply(res: ReturnType<typeof run>['res'], code: ErrorCode, field: string | null) {
  expect(res.statusCode).toBe(ERROR_REGISTRY[code].status);
  expect(res.body.success).toBe(false);
  expect(res.body.error.code).toBe(code);
  expect(res.body.error.message).toBe(ERROR_REGISTRY[code].message);
  expect(res.body.error.field).toBe(field);
}

describe('AllExceptionsFilter', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('AppException', () => {
    it('replies with its own code, the registry status and message, and its field', () => {
      const { res } = run(new AppException('OUT_OF_SERVICE_AREA', { field: 'pickupLat' }));
      expectReply(res, 'OUT_OF_SERVICE_AREA', 'pickupLat');
    });

    it('includes details on INVALID_INPUT and puts the first invalid field in field', () => {
      const details = [
        { field: 'dropLat', reason: 'x' },
        { field: 'dropLng', reason: 'y' },
      ];
      const { res } = run(new AppException('INVALID_INPUT', { field: 'dropLat', details }));
      expectReply(res, 'INVALID_INPUT', 'dropLat');
      expect(res.body.error.details).toEqual(details);
    });

    it('uses the registry status and message for every code and adds no details', () => {
      const LooseAppException = AppException as unknown as new (c: string) => AppException;
      for (const code of Object.keys(ERROR_REGISTRY) as ErrorCode[]) {
        const { res } = run(new LooseAppException(code));
        expectReply(res, code, null);
        expect('details' in res.body.error).toBe(false);
      }
    });
  });

  describe('framework exceptions', () => {
    it.each([
      { name: 'UnauthorizedException', exception: new UnauthorizedException('x'), code: 'UNAUTHORIZED' },
      { name: 'ForbiddenException', exception: new ForbiddenException('x'), code: 'FORBIDDEN' },
      { name: 'NotFoundException', exception: new NotFoundException('x'), code: 'NOT_FOUND' },
      { name: 'ConflictException', exception: new ConflictException('x'), code: 'CONFLICT' },
      { name: 'HttpException 429', exception: new HttpException('x', 429), code: 'RATE_LIMITED' },
      { name: 'BadRequestException', exception: new BadRequestException('x'), code: 'INVALID_INPUT' },
    ] as const)('$name maps to $code with field null', ({ exception, code }) => {
      const { res } = run(exception);
      expectReply(res, code, null);
    });
  });

  describe('unmapped errors', () => {
    it.each([
      ['UnprocessableEntityException 422', new UnprocessableEntityException('x'), 422],
      ['MethodNotAllowedException 405', new MethodNotAllowedException('x'), 405],
      ['HttpException 413', new HttpException('x', 413), 413],
      [
        'non-Nest error with status 413 and expose true',
        Object.assign(new Error('too large'), { status: 413, expose: true }),
        413,
      ],
      [
        'non-Nest error with statusCode 415 and expose true',
        Object.assign(new Error('bad type'), { statusCode: 415, expose: true }),
        415,
      ],
    ] as const)('%s becomes INVALID_INPUT 400 and logs originalStatus', (_n, exception, original) => {
      const { res } = run(exception);
      expectReply(res, 'INVALID_INPUT', null);
      expect(warn.mock.calls[0][0]).toContain(`originalStatus=${original}`);
      expect(error).not.toHaveBeenCalled();
    });

    it.each([
      ['ServiceUnavailableException 503', new ServiceUnavailableException('x')],
      ['InternalServerErrorException', new InternalServerErrorException('x')],
      ['HttpException 502', new HttpException('x', 502)],
      ['non-Nest error with status 503', Object.assign(new Error('x'), { status: 503 })],
      [
        'non-Nest error with status 503 and expose true',
        Object.assign(new Error('x'), { status: 503, expose: true }),
      ],
      ['plain Error', new Error('boom')],
      ['TypeError', new TypeError('boom')],
      ['a thrown string', 'boom'],
      ['undefined', undefined],
      ['null', null],
    ])('%s becomes INTERNAL_ERROR 500', (_name, exception) => {
      const { res } = run(exception);
      expectReply(res, 'INTERNAL_ERROR', null);
    });
  });

  describe('upstream provider errors (a 4xx without expose)', () => {
    it.each([
      ['status 403', { status: 403 }],
      ['status 429', { status: 429 }],
      ['statusCode 429', { statusCode: 429 }],
    ])(
      'a non-Nest error with %s and no expose stays INTERNAL_ERROR 500 and is logged as an error with its stack',
      (_name, props) => {
        const upstream = Object.assign(new Error('upstream rejected our key'), props);
        const { res } = run(upstream);
        expectReply(res, 'INTERNAL_ERROR', null);
        expect(JSON.stringify(res.body)).not.toContain('upstream rejected');
        expect(error).toHaveBeenCalledTimes(1);
        expect(error.mock.calls[0][1]).toBe(upstream.stack);
        expect(warn).not.toHaveBeenCalled();
      },
    );

    it('a non-Nest error with status 413 and expose false becomes INTERNAL_ERROR 500', () => {
      const upstream = Object.assign(new Error('too large'), { status: 413, expose: false });
      const { res } = run(upstream);
      expectReply(res, 'INTERNAL_ERROR', null);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0][1]).toBe(upstream.stack);
    });
  });

  describe('reply body', () => {
    it('never copies a framework or error message into the reply', () => {
      const { res } = run(new UnauthorizedException('Invalid mock Firebase token'));
      expect(res.body.error.message).toBe(ERROR_REGISTRY.UNAUTHORIZED.message);
      expect(JSON.stringify(res.body)).not.toContain('mock');
      const bad = run(new BadRequestException(['dropLat must be a number'])).res;
      expect(JSON.stringify(bad.body)).not.toContain('dropLat must be');
    });

    it('leaks nothing from a crash: no secret text, stack or file path', () => {
      const crash = new Error('secret-db-password-xyz');
      crash.stack = 'Error: secret-db-password-xyz\n    at run (C:/app/src/x.ts:1:1)';
      const { res } = run(crash);
      const text = JSON.stringify(res.body);
      for (const forbidden of [
        'secret-db-password-xyz',
        'stack',
        'node_modules',
        '.ts',
        'C:/',
        ' at ',
      ]) {
        expect(text).not.toContain(forbidden);
      }
      expectReply(res, 'INTERNAL_ERROR', null);
    });

    it('has exactly the standard keys and no others', () => {
      const plain = run(new NotFoundException('x')).res.body;
      expect(Object.keys(plain)).toEqual(['success', 'error', 'requestId']);
      expect(Object.keys(plain.error)).toEqual(['code', 'message', 'field']);
      const withDetails = run(
        new AppException('INVALID_INPUT', { field: 'a', details: [{ field: 'a', reason: 'r' }] }),
      ).res.body;
      expect(Object.keys(withDetails.error)).toEqual(['code', 'message', 'field', 'details']);
    });
  });

  describe('request id', () => {
    it('uses the request id set by the middleware and does not touch the header', () => {
      const { res, headers } = run(new NotFoundException('x'), { requestId: 'from-middleware' });
      expect(res.body.requestId).toBe('from-middleware');
      expect(headers['x-request-id']).toBeUndefined();
    });

    it('generates a UUID v4 and sets the header when the middleware never ran', () => {
      const { res, headers } = run(new NotFoundException('x'), {});
      expect(res.body.requestId).toMatch(UUID_V4);
      expect(headers['x-request-id']).toBe(res.body.requestId);
    });
  });

  describe('headers already sent', () => {
    it('writes no second reply and logs that it skipped', () => {
      const { res } = run(new NotFoundException('x'), { requestId: 'r' }, true);
      expect(res.statusCode).toBeUndefined();
      expect(res.body).toBeUndefined();
      expect(warn.mock.calls.map((c: unknown[]) => c[0]).join('\n')).toContain(
        'headers already sent',
      );
    });
  });

  describe('logging', () => {
    const req = {
      requestId: 'req-log',
      url: '/riders/+911234567890',
      method: 'PATCH',
      body: { phone: '+911234567890' },
      headers: { authorization: 'Bearer top-secret-token' },
    };

    it('logs a 4xx as a warning with requestId, code and status, and no stack', () => {
      run(new ForbiddenException('x'), req);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]).toHaveLength(1);
      expect(warn.mock.calls[0][0]).toBe('requestId=req-log code=FORBIDDEN status=403');
      expect(error).not.toHaveBeenCalled();
    });

    it('logs a 5xx or crash as an error with requestId, the error and its stack', () => {
      const crash = new Error('db exploded');
      run(crash, req);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0][0]).toBe(
        'requestId=req-log code=INTERNAL_ERROR status=500 error=db exploded',
      );
      expect(error.mock.calls[0][1]).toBe(crash.stack);
      expect(warn).not.toHaveBeenCalled();
    });

    it('never logs the request url, method, body or headers', () => {
      run(new Error('x'), req);
      run(new ForbiddenException('x'), req);
      const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
      for (const secret of ['+911234567890', 'top-secret-token', '/riders/', 'authorization', 'PATCH']) {
        expect(logged).not.toContain(secret);
      }
    });
  });
});
