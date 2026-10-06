import { RouteInputsError } from '../common/validation/route-inputs.js';
import { DatabaseCheckError, DATABASE_CHECK_FAILED } from './database-check.js';
import { EnvConfigError } from './env.validation.js';
import { OTP_PROVIDER_NOT_BUILT, OtpProviderNotBuiltError } from './otp-provider-not-built.error.js';
import { describeStartupFailure, refuseToStart, STARTUP_FAILED_LINE, type StartupIo } from './startup-failure.js';

class Exited extends Error {
  constructor(readonly code: number) {
    super(`exit:${code}`);
  }
}

// A fake process: it records what would be printed and turns exit() into a throw we can catch.
function fakeIo() {
  const printed: string[] = [];
  const exits: number[] = [];
  const io: StartupIo = {
    print: (line) => printed.push(line),
    exit: (code) => {
      exits.push(code);
      throw new Exited(code);
    },
  };
  return { io, printed, exits };
}

function run(rejection: unknown) {
  const { io, printed, exits } = fakeIo();
  let threw: unknown;
  try {
    refuseToStart(rejection, io);
  } catch (error) {
    threw = error;
  }
  return { printed, exits, threw };
}

const SECRET = 'postgresql://SECRET-USER-xyz:SECRET-PASSWORD-xyz@SECRET-HOST-xyz/db';
const routeError = new RouteInputsError(
  'Route input check failed:\n  - AuthController.login: @Body() is typed as Object',
);
const envError = new EnvConfigError([{ variable: 'NODE_ENV', reason: 'REQUIRED' }]);

describe('describeStartupFailure', () => {
  it('EnvConfigError prints its own message', () => {
    expect(describeStartupFailure(envError)).toBe(envError.message);
  });

  it('RouteInputsError prints its own message (controller and handler names only)', () => {
    expect(describeStartupFailure(routeError)).toBe(routeError.message);
  });

  it('OtpProviderNotBuiltError prints its fixed message (a key name and constants only)', () => {
    expect(describeStartupFailure(new OtpProviderNotBuiltError())).toBe(OTP_PROVIDER_NOT_BUILT);
  });

  it('DatabaseCheckError prints its fixed message', () => {
    expect(describeStartupFailure(new DatabaseCheckError())).toBe(DATABASE_CHECK_FAILED);
  });

  it.each([
    ['a foreign Error whose message holds a secret', new Error(`connect failed: ${SECRET}`)],
    ['a TypeError from a library', new TypeError(`Invalid URL: ${SECRET}`)],
    ['a foreign Error with a secret cause', new Error('x', { cause: new Error(SECRET) })],
    ['a string rejection holding a secret', SECRET],
    ['a plain object with a message', { message: SECRET }],
    ['an object that only LOOKS like EnvConfigError', Object.assign(new Error(SECRET), { name: 'EnvConfigError', problems: [] })],
    ['an object that only LOOKS like RouteInputsError', Object.assign(new Error(SECRET), { name: 'RouteInputsError' })],
    ['an object that only LOOKS like DatabaseCheckError', Object.assign(new Error(SECRET), { name: 'DatabaseCheckError' })],
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
  ])('%s prints only the fixed line', (_name, rejection) => {
    const line = describeStartupFailure(rejection);
    expect(line).toBe(STARTUP_FAILED_LINE);
    for (const part of ['SECRET', 'postgresql', 'Invalid URL', 'connect failed']) {
      expect(line).not.toContain(part);
    }
  });

  it('the fixed line is exactly the agreed text', () => {
    expect(STARTUP_FAILED_LINE).toBe('Startup failed. See server logs for details.');
  });
});

describe('refuseToStart', () => {
  it.each([
    ['EnvConfigError', envError, envError.message],
    ['DatabaseCheckError', new DatabaseCheckError(), DATABASE_CHECK_FAILED],
    ['RouteInputsError', routeError, routeError.message],
    ['a foreign Error with a secret', new Error(SECRET), STARTUP_FAILED_LINE],
    ['a string rejection with a secret', SECRET, STARTUP_FAILED_LINE],
    ['a plain object', { message: SECRET }, STARTUP_FAILED_LINE],
    ['undefined', undefined, STARTUP_FAILED_LINE],
  ])('%s: prints exactly one line and exits with code 1', (_name, rejection, expected) => {
    const { printed, exits, threw } = run(rejection);
    expect(printed).toEqual([expected]);
    expect(exits).toEqual([1]);
    expect((threw as Exited).code).toBe(1);
    expect(printed.join('\n')).not.toContain('SECRET');
  });

  it('by default it prints with console.error and exits through process.exit(1)', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Exited(code ?? -1);
    }) as never);
    try {
      expect(() => refuseToStart(new Error(SECRET))).toThrow('exit:1');
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(STARTUP_FAILED_LINE);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('works as an unhandledRejection listener wrapper: it takes the reason, not the promise', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Exited(code ?? -1);
    }) as never);
    try {
      // this is what main.ts registers: (reason) => refuseToStart(reason)
      const listener = (reason: unknown) => refuseToStart(reason);
      expect(() => (listener as (r: unknown, p: unknown) => never)(new Error(SECRET), Promise.resolve())).toThrow('exit:1');
      expect(error).toHaveBeenCalledWith(STARTUP_FAILED_LINE);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
