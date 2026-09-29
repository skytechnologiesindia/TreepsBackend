import type { ArgumentMetadata } from '@nestjs/common';
import { IsString } from 'class-validator';
import { AppException } from '../errors/app.exception.js';
import { Latitude, Page, Required, ToInt } from './fields.js';
import { InputValidationPipe, isUsableBody } from './input-validation.pipe.js';

class Point {
  @Required(Latitude()) lat!: number;
}
class Paging {
  @ToInt() @Required(Page({ max: 50 })) page!: number;
}
class Empty {} // a DTO class with no rules at all
class Secretive {
  @IsString({ message: 'SECRET-CLASS-VALIDATOR-TEXT' }) name!: string;
}

const body = (metatype: new () => object = Point): ArgumentMetadata => ({ type: 'body', metatype });
const query = (metatype: new () => object): ArgumentMetadata => ({ type: 'query', metatype });

async function failure(promise: Promise<unknown>): Promise<AppException> {
  try {
    await promise;
  } catch (error) {
    return error as AppException;
  }
  throw new Error('expected the pipe to reject');
}
const pairs = (e: AppException) => (e.details ?? []).map((d) => [d.field, d.reason]);

describe('isUsableBody (rule 11)', () => {
  it.each([[{}], [{ a: 1 }]])('accepts the plain object %j', (value) => {
    expect(isUsableBody(value)).toBe(true);
  });
  it.each([[undefined], [null], [[]], [[1]], ['abc'], [5], [true], [false]])('rejects %j', (value) => {
    expect(isUsableBody(value)).toBe(false);
  });
});

describe('InputValidationPipe', () => {
  const pipe = new InputValidationPipe();

  describe('an unusable body', () => {
    it.each([[undefined], [null], [[]], ['abc'], [5], [true]])(
      'gives INVALID_INPUT with field null and no details for %j',
      async (value) => {
        const e = await failure(pipe.transform(value, body()));
        expect(e).toBeInstanceOf(AppException);
        expect(e.code).toBe('INVALID_INPUT');
        expect(e.field).toBeNull();
        expect(e.details).toBeUndefined();
      },
    );

    it('is decided before any DTO rule runs (a DTO with rules and one without behave the same)', async () => {
      for (const dto of [Point, Empty]) {
        const e = await failure(pipe.transform([], body(dto)));
        expect(e.field).toBeNull();
        expect(e.details).toBeUndefined();
      }
    });
  });

  describe('an empty object is a normal body', () => {
    it('is validated by the DTO, so the missing required fields are listed', async () => {
      const e = await failure(pipe.transform({}, body()));
      expect(pairs(e)).toEqual([['lat', 'REQUIRED']]);
      expect(e.field).toBe('lat');
    });
  });

  describe('the body rule applies only to a whole body', () => {
    it('a named body value (@Body("idToken")) is not treated as unusable', async () => {
      const named: ArgumentMetadata = { type: 'body', data: 'idToken', metatype: String };
      await expect(pipe.transform('token-value', named)).resolves.toBe('token-value');
      await expect(pipe.transform(undefined, named)).resolves.toBeUndefined();
    });

    it('a query value is validated as a query, not judged as a body', async () => {
      const e = await failure(pipe.transform({}, query(Paging)));
      expect(pairs(e)).toEqual([['page', 'REQUIRED']]);
    });
  });

  describe('the options', () => {
    it('rejects an unknown field (whitelist and forbidNonWhitelisted)', async () => {
      const e = await failure(pipe.transform({ lat: 1, price: 100 }, body()));
      expect(pairs(e)).toEqual([['price', 'UNKNOWN_FIELD']]);
      expect(e.field).toBe('price');
    });

    it('does not coerce a string into a number (no implicit conversion)', async () => {
      const e = await failure(pipe.transform({ lat: '12.5' }, body()));
      expect(pairs(e)).toEqual([['lat', 'WRONG_TYPE']]);
    });

    it('fails a DTO class with no rules at all (forbidUnknownValues), as an unusable body', async () => {
      const e = await failure(pipe.transform({ a: 1 }, body(Empty)));
      expect(e.field).toBeNull();
      expect(e.details).toBeUndefined();
    });

    it('returns a DTO instance, with the explicit ToInt conversion applied (transform)', async () => {
      const result = (await pipe.transform({ page: '2' }, query(Paging))) as Paging;
      expect(result).toBeInstanceOf(Paging);
      expect(result.page).toBe(2);
    });

    it('never puts the submitted value or library text into the exception', async () => {
      const e = await failure(pipe.transform({ name: 12345, other: 'secret-submitted-value' }, body(Secretive)));
      const text = JSON.stringify({ response: e.getResponse(), message: e.message, field: e.field, details: e.details });
      for (const forbidden of ['SECRET-CLASS-VALIDATOR-TEXT', 'secret-submitted-value', '12345']) {
        expect(text).not.toContain(forbidden);
      }
      expect(pairs(e)).toEqual([['name', 'INVALID_VALUE'], ['other', 'UNKNOWN_FIELD']]);
    });
  });
});
