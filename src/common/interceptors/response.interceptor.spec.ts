import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { ResponseInterceptor } from './response.interceptor.js';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function makeContext(req: Record<string, unknown> = { requestId: 'req-1' }) {
  const headers: Record<string, string> = {};
  const res = {
    headersSent: false,
    status: vi.fn(),
    json: vi.fn(),
    send: vi.fn(),
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
  return { context, res, headers };
}

async function wrap(returned: unknown, req?: Record<string, unknown>) {
  const { context, res, headers } = makeContext(req);
  const next: CallHandler = { handle: () => of(returned) };
  const body = await lastValueFrom(new ResponseInterceptor().intercept(context, next));
  return { body: body as any, res, headers };
}

describe('ResponseInterceptor', () => {
  it('replies with exactly the keys success, data and requestId', async () => {
    const { body } = await wrap({ id: 1 });
    expect(Object.keys(body)).toEqual(['success', 'data', 'requestId']);
    expect(body.success).toBe(true);
  });

  it('turns undefined into data: null', async () => {
    const { body } = await wrap(undefined);
    expect(body.data).toBeNull();
    expect('data' in body).toBe(true);
  });

  it.each([
    ['an object', { id: 1, name: 'a' }],
    ['an array', [1, 'two', { three: 3 }]],
    ['a string', 'text'],
    ['a number', 42],
    ['zero', 0],
    ['false', false],
    ['an empty string', ''],
    ['null', null],
  ])('passes %s through unchanged', async (_name, value) => {
    const { body } = await wrap(value);
    expect(body.data).toStrictEqual(value);
  });

  it('does not unwrap an object shaped like { data: { x: 1 } }', async () => {
    const { body } = await wrap({ data: { x: 1 } });
    expect(body.data).toEqual({ data: { x: 1 } });
  });

  it('is not affected by message, statusCode or timestamp fields in the returned object', async () => {
    const returned = { message: 'hi', statusCode: 999, timestamp: 'now', data: { x: 1 } };
    const { body } = await wrap(returned);
    expect(Object.keys(body)).toEqual(['success', 'data', 'requestId']);
    expect(body.data).toEqual(returned);
    expect(body.message).toBeUndefined();
    expect(body.statusCode).toBeUndefined();
  });

  it('uses the request id from the request', async () => {
    const { body, headers } = await wrap('x', { requestId: 'from-middleware' });
    expect(body.requestId).toBe('from-middleware');
    expect(headers['x-request-id']).toBeUndefined();
  });

  it('generates a UUID v4 and sets the header when the middleware never ran', async () => {
    const { body, headers } = await wrap('x', {});
    expect(body.requestId).toMatch(UUID_V4);
    expect(headers['x-request-id']).toBe(body.requestId);
  });

  it('does not touch the HTTP status or write to the response itself', async () => {
    const { res } = await wrap({ ok: true });
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
  });

  it('does not wrap an error: it passes through untouched', async () => {
    const { context } = makeContext();
    const failure = new Error('handler failed');
    const next: CallHandler = { handle: () => throwError(() => failure) };
    await expect(
      lastValueFrom(new ResponseInterceptor().intercept(context, next)),
    ).rejects.toBe(failure);
  });
});
