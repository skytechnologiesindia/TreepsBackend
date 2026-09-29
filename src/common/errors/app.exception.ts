import { HttpException } from '@nestjs/common';
import { ERROR_REGISTRY, type ErrorCode } from './error-registry.js';

export interface ErrorDetail {
  field: string;
  reason: string;
}

export class AppException extends HttpException {
  readonly code: ErrorCode;
  readonly field: string | null;
  readonly details?: ErrorDetail[];

  constructor(
    code: 'INVALID_INPUT',
    options?: { field?: string | null; details?: ErrorDetail[] },
  );
  constructor(
    code: Exclude<ErrorCode, 'INVALID_INPUT'>,
    options?: { field?: string | null },
  );
  constructor(
    code: ErrorCode,
    options: { field?: string | null; details?: ErrorDetail[] } = {},
  ) {
    const entry = ERROR_REGISTRY[code];
    if (!entry) {
      throw new TypeError(`Unknown error code: ${String(code)}`);
    }
    if (options.details !== undefined && code !== 'INVALID_INPUT') {
      throw new TypeError('details is only allowed on INVALID_INPUT');
    }
    super({ code, message: entry.message }, entry.status);
    this.code = code;
    this.field = options.field ?? null;
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}
