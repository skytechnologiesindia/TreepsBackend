import { HttpException } from '@nestjs/common';
import { AppException } from './app.exception.js';
import { ERROR_REGISTRY, type ErrorCode } from './error-registry.js';

const codes = Object.keys(ERROR_REGISTRY) as ErrorCode[];

// Loosely typed constructor, only so loops can pass any code (the real one is strict).
const LooseAppException = AppException as unknown as new (
  code: string,
  options?: object,
) => AppException;

describe('AppException', () => {
  it('takes its status and message from the registry for every code', () => {
    for (const code of codes) {
      const error = new LooseAppException(code);
      expect(error.getStatus()).toBe(ERROR_REGISTRY[code].status);
      expect(error.message).toBe(ERROR_REGISTRY[code].message);
      expect(error.code).toBe(code);
    }
  });

  it('defaults field to null and leaves details undefined', () => {
    const error = new AppException('NOT_FOUND');
    expect(error.field).toBeNull();
    expect(error.details).toBeUndefined();
  });

  it('keeps a field when one is given', () => {
    const error = new AppException('OUT_OF_SERVICE_AREA', { field: 'pickupLat' });
    expect(error.field).toBe('pickupLat');
  });

  it('accepts field and details on INVALID_INPUT', () => {
    const details = [{ field: 'dropLat', reason: 'x' }];
    const error = new AppException('INVALID_INPUT', { field: 'dropLat', details });
    expect(error.field).toBe('dropLat');
    expect(error.details).toEqual(details);
  });

  it('rejects details on every code except INVALID_INPUT', () => {
    for (const code of codes.filter((c) => c !== 'INVALID_INPUT')) {
      expect(() => new LooseAppException(code, { details: [] })).toThrow(TypeError);
    }
  });

  it('makes details on a non-INVALID_INPUT code a compile error and a runtime error', () => {
    expect(() => {
      // @ts-expect-error details is only allowed on INVALID_INPUT
      return new AppException('NOT_FOUND', { details: [{ field: 'a', reason: 'b' }] });
    }).toThrow(TypeError);
  });

  it('makes a code that is not in the registry a compile error and a runtime error', () => {
    expect(() => {
      // @ts-expect-error a code that is not in the registry is a compile error
      return new AppException('NOT_A_REAL_CODE');
    }).toThrow(TypeError);
  });

  it('is an HttpException whose body holds only the code and the message', () => {
    const error = new AppException('FORBIDDEN', { field: 'x' });
    expect(error).toBeInstanceOf(HttpException);
    expect(error.getResponse()).toEqual({
      code: 'FORBIDDEN',
      message: ERROR_REGISTRY.FORBIDDEN.message,
    });
  });
});
