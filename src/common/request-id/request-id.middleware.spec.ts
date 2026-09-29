import type { NextFunction, Request, Response } from 'express';
import {
  REQUEST_ID_HEADER,
  getRequestId,
  requestIdMiddleware,
} from './request-id.middleware.js';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function run(clientHeaders: Record<string, string> = {}) {
  const req = { headers: clientHeaders } as unknown as Request;
  const headers: Record<string, string> = {};
  const res = {
    setHeader: (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    },
  } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  requestIdMiddleware(req, res, next);
  return { req, headers, next };
}

describe('requestIdMiddleware', () => {
  it('generates a UUID v4 and stores it on the request', () => {
    const { req } = run();
    expect(getRequestId(req)).toMatch(UUID_V4);
  });

  it('sets the X-Request-Id response header to the same id', () => {
    const { req, headers } = run();
    expect(headers[REQUEST_ID_HEADER.toLowerCase()]).toBe(getRequestId(req));
  });

  it('ignores a client-sent X-Request-Id', () => {
    const { req, headers } = run({ 'x-request-id': 'forged-by-client' });
    expect(getRequestId(req)).not.toBe('forged-by-client');
    expect(headers['x-request-id']).not.toBe('forged-by-client');
    expect(getRequestId(req)).toMatch(UUID_V4);
  });

  it('gives two requests different ids', () => {
    expect(getRequestId(run().req)).not.toBe(getRequestId(run().req));
  });

  it('calls next() exactly once so the request continues', () => {
    const { next } = run();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
