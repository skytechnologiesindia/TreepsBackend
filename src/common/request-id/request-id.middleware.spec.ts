import type { NextFunction, Request, Response } from 'express';
import {
  REQUEST_ID_HEADER,
  ensureRequestId,
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

describe('ensureRequestId', () => {
  function fake(reqProps: Record<string, unknown> = {}) {
    const headers: Record<string, string> = {};
    const req = { ...reqProps } as unknown as Request;
    const res = {
      headersSent: false,
      setHeader: (name: string, value: string) => {
        headers[name.toLowerCase()] = value;
      },
    } as unknown as Response;
    return { req, res, headers };
  }

  it('returns an existing id and leaves the header alone', () => {
    const { req, res, headers } = fake({ requestId: 'already-set' });
    expect(ensureRequestId(req, res)).toBe('already-set');
    expect(headers['x-request-id']).toBeUndefined();
  });

  it('generates a UUID v4, stores it and sets the header when there is none', () => {
    const { req, res, headers } = fake();
    const id = ensureRequestId(req, res);
    expect(id).toMatch(UUID_V4);
    expect(getRequestId(req)).toBe(id);
    expect(headers['x-request-id']).toBe(id);
  });

  it('is not what the middleware uses: the middleware still replaces an id already on the request', () => {
    const req = { headers: {}, requestId: 'stale' } as unknown as Request;
    const res = { setHeader: () => undefined } as unknown as Response;
    requestIdMiddleware(req, res, vi.fn() as unknown as NextFunction);
    expect(getRequestId(req)).not.toBe('stale');
    expect(getRequestId(req)).toMatch(UUID_V4);
  });
});
