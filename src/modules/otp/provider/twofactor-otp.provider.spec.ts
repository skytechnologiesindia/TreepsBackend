import { afterEach, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from 'vitest';
import { Logger } from '@nestjs/common';
import { OtpProviderError, TwoFactorOtpProvider } from './twofactor-otp.provider.js';

const KEY = 'SECRET-KEY-abc123-do-not-leak';
const PHONE = '+919477172214';

function reply(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

function make(fetchFn: Mock, timeoutMs?: number) {
  return new TwoFactorOtpProvider({
    apiKey: KEY,
    template: 'OTP1',
    fetchFn: fetchFn as unknown as typeof fetch,
    timeoutMs,
  });
}

describe('TwoFactorOtpProvider', () => {
  let warn: MockInstance;
  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('send: calls the AUTOGEN url with 91 + number, returns Details as the session id', async () => {
    const fetchFn = vi.fn().mockResolvedValue(reply({ Status: 'Success', Details: 'sess-1' }));
    expect(await make(fetchFn).send(PHONE)).toEqual({ providerSessionId: 'sess-1' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe(`https://2factor.in/API/V1/${KEY}/SMS/919477172214/AUTOGEN/OTP1`);
  });

  it('send: returns only the session id, never a code', async () => {
    const fetchFn = vi.fn().mockResolvedValue(reply({ Status: 'Success', Details: 'sess-1', Otp: '123456' }));
    expect(Object.keys(await make(fetchFn).send(PHONE))).toEqual(['providerSessionId']);
  });

  it('verify: Success + OTP Matched is true, and the url carries session and code', async () => {
    const fetchFn = vi.fn().mockResolvedValue(reply({ Status: 'Success', Details: 'OTP Matched' }));
    expect(await make(fetchFn).verify('sess-1', '123456')).toBe(true);
    expect(fetchFn.mock.calls[0][0]).toBe(`https://2factor.in/API/V1/${KEY}/SMS/VERIFY/sess-1/123456`);
  });

  it('verify: wrong code is false', async () => {
    const fetchFn = vi.fn().mockResolvedValue(reply({ Status: 'Error', Details: 'OTP Mismatch' }));
    expect(await make(fetchFn).verify('s', '000000')).toBe(false);
  });

  it('verify: expired code is false, even when the HTTP status is 400', async () => {
    const fetchFn = vi.fn().mockResolvedValue(reply({ Status: 'Error', Details: 'OTP Expired' }, 400));
    expect(await make(fetchFn).verify('s', '000000')).toBe(false);
  });

  it('send: Status Error becomes OtpProviderError', async () => {
    const fetchFn = vi.fn().mockResolvedValue(reply({ Status: 'Error', Details: 'Invalid API Key' }));
    await expect(make(fetchFn).send(PHONE)).rejects.toBeInstanceOf(OtpProviderError);
  });

  it('verify: any other Error detail is a provider error, not a wrong code', async () => {
    const fetchFn = vi.fn().mockResolvedValue(reply({ Status: 'Error', Details: 'Invalid API Key' }));
    await expect(make(fetchFn).verify('s', '123456')).rejects.toBeInstanceOf(OtpProviderError);
  });

  it('timeout becomes OtpProviderError', async () => {
    const fetchFn = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))),
    );
    await expect(make(fetchFn, 20).send(PHONE)).rejects.toMatchObject({ reason: 'NETWORK_OR_TIMEOUT' });
  });

  it('malformed JSON and non-object JSON become OtpProviderError', async () => {
    for (const body of ['<html>oops</html>', '[]', 'null', '"text"']) {
      const fetchFn = vi.fn().mockResolvedValue(reply(body));
      await expect(make(fetchFn).send(PHONE)).rejects.toMatchObject({ reason: 'BAD_REPLY' });
    }
  });

  it('does not retry after a failure', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(make(fetchFn).send(PHONE)).rejects.toBeInstanceOf(OtpProviderError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await expect(make(fetchFn).verify('s', '123456')).rejects.toBeInstanceOf(OtpProviderError);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('refuses a phone that is not +91 and 10 digits, without calling out', async () => {
    const fetchFn = vi.fn();
    await expect(make(fetchFn).send('+14155550100')).rejects.toBeInstanceOf(OtpProviderError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('the API key is in no error, stack, log line or console output, for every failure kind', async () => {
    const leakyError = Object.assign(new Error(`fetch failed https://2factor.in/API/V1/${KEY}/SMS/x`), {
      cause: new Error(`cause ${KEY}`),
    });
    const failures: Array<() => Promise<Response>> = [
      async () => {
        throw leakyError;
      },
      async () => reply('not json'),
      async () => reply({ Status: 'Error', Details: `bad key ${KEY}` }),
      async () => reply({ Status: 'Success', Details: '' }),
    ];
    const output: string[] = [];
    warn.mockImplementation((...a: unknown[]) => void output.push(JSON.stringify(a)));
    for (const m of ['log', 'warn', 'error', 'info', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void output.push(JSON.stringify(a)));
    }
    for (const m of ['error', 'log', 'debug', 'verbose'] as const) {
      vi.spyOn(Logger.prototype, m).mockImplementation((...a: unknown[]) => void output.push(JSON.stringify(a)));
    }

    const errors: unknown[] = [];
    for (const f of failures) {
      const provider = make(vi.fn(f));
      await provider.send(PHONE).catch((e: unknown) => errors.push(e));
      await provider.verify('s', '123456').catch((e: unknown) => errors.push(e));
    }

    expect(errors).toHaveLength(8);
    for (const e of errors) {
      expect(e).toBeInstanceOf(OtpProviderError);
      const err = e as Error & { cause?: unknown };
      expect([err.message, err.stack, err.name, JSON.stringify(err), String(err.cause)].join('|')).not.toContain(KEY);
      expect(err.cause).toBeUndefined();
    }
    expect(output.length).toBeGreaterThan(0); // the failures are logged...
    expect(output.join('\n')).not.toContain(KEY); // ...without the key
    expect(output.join('\n')).not.toContain('2factor.in');
  });
});
