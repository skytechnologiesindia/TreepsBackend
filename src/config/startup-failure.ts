import { RouteInputsError } from '../common/validation/route-inputs.js';
import { DatabaseCheckError } from './database-check.js';
import { EnvConfigError } from './env.validation.js';

export const STARTUP_FAILED_LINE = 'Startup failed. See server logs for details.';

// Only OUR error types may print their own message: their messages are built from variable names,
// controller and handler names, reason codes and constants, never from a value. Any other rejection (a library error, a string,
// an object, undefined) prints only the fixed line, because a library message can contain a
// connection string or another secret.
export function describeStartupFailure(error: unknown): string {
  return error instanceof EnvConfigError ||
    error instanceof DatabaseCheckError ||
    error instanceof RouteInputsError
    ? error.message
    : STARTUP_FAILED_LINE;
}

export interface StartupIo {
  print(line: string): void;
  exit(code: number): never;
}

const processIo: StartupIo = {
  print: (line) => console.error(line),
  exit: (code) => process.exit(code),
};

export function refuseToStart(error: unknown, io: StartupIo = processIo): never {
  io.print(describeStartupFailure(error));
  return io.exit(1);
}
