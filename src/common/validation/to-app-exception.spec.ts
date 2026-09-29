import { plainToInstance } from 'class-transformer';
import { IsString, Matches, validate, type ValidationError } from 'class-validator';
import { AppException } from '../errors/app.exception.js';
import { MAX_DETAILS, toAppException } from './to-app-exception.js';

const err = (
  property: string,
  keys: string[],
  children: ValidationError[] = [],
): ValidationError =>
  ({
    property,
    constraints: Object.fromEntries(keys.map((k) => [k, 'x'])),
    children,
  }) as ValidationError;

const fieldsOf = (e: AppException) => (e.details ?? []).map((d) => d.field);
const numbered = (n: number) => `f${String(n).padStart(2, '0')}`;

describe('toAppException', () => {
  it('returns INVALID_INPUT 400 with the registry message', () => {
    const e = toAppException([err('a', ['treepsWrongType'])]);
    expect(e).toBeInstanceOf(AppException);
    expect(e.code).toBe('INVALID_INPUT');
    expect(e.getStatus()).toBe(400);
    expect(e.message).toBe('Please check your input.');
  });

  it('flattens nested and list errors to dot paths', () => {
    const e = toAppException([
      err('pickup', [], [err('lat', ['treepsWrongType'])]),
      err('stops', [], [err('1', [], [err('lat', ['treepsOutOfRange'])])]),
    ]);
    expect(e.details).toEqual([
      { field: 'pickup.lat', reason: 'WRONG_TYPE' },
      { field: 'stops.1.lat', reason: 'OUT_OF_RANGE' },
    ]);
  });

  it('gives one reason per field: the strongest', () => {
    const e = toAppException([err('lat', ['treepsOutOfRange', 'isDefined', 'treepsWrongType'])]);
    expect(e.details).toEqual([{ field: 'lat', reason: 'REQUIRED' }]);
  });

  it('dedupes a field reported twice and keeps the stronger reason', () => {
    const e = toAppException([err('a', ['treepsTooLong']), err('a', ['treepsWrongType'])]);
    expect(e.details).toEqual([{ field: 'a', reason: 'WRONG_TYPE' }]);
  });

  it('sorts A to Z in plain code-unit order (not locale order)', () => {
    const e = toAppException(['b', 'B', 'a', '_x', 'Z'].map((n) => err(n, ['treepsWrongType'])));
    expect(fieldsOf(e)).toEqual(['B', 'Z', '_x', 'a', 'b']);
  });

  it('caps details at 20 after sorting', () => {
    const names = Array.from({ length: 25 }, (_, i) => numbered(i + 1)).reverse();
    const e = toAppException(names.map((n) => err(n, ['treepsWrongType'])));
    expect(MAX_DETAILS).toBe(20);
    expect(fieldsOf(e)).toEqual(Array.from({ length: 20 }, (_, i) => numbered(i + 1)));
  });

  it('keeps $unknown in a capped list because it sorts first', () => {
    const many = Array.from({ length: 24 }, (_, i) => err(numbered(i), ['treepsWrongType']));
    const e = toAppException([err('a b', ['whitelistValidation']), ...many]);
    expect(e.details).toHaveLength(20);
    expect(e.details?.[0]).toEqual({ field: '$unknown', reason: 'UNKNOWN_FIELD' });
  });

  describe('unsafe unknown names', () => {
    it.each(['a b', 'ünï', 'x'.repeat(65), '1abc', '$evil', 'a-b', 'a\nb'])(
      'collapses %j into ONE $unknown entry',
      (name) => {
        const e = toAppException([
          err(name, ['whitelistValidation']),
          err('another bad ✓', ['whitelistValidation']),
        ]);
        expect(e.details).toEqual([{ field: '$unknown', reason: 'UNKNOWN_FIELD' }]);
      },
    );

    it.each(['promoCode', '_x', 'a.b', 'x'.repeat(64)])('echoes the safe name %j', (name) => {
      expect(fieldsOf(toAppException([err(name, ['whitelistValidation'])]))).toEqual([name]);
    });

    it('checks the unknown name inside a nested object too', () => {
      const e = toAppException([err('pickup', [], [err('bad name', ['whitelistValidation'])])]);
      expect(e.details).toEqual([{ field: '$unknown', reason: 'UNKNOWN_FIELD' }]);
    });
  });

  describe('the field rule', () => {
    it('only $unknown invalid: field is null and details holds the $unknown entry', () => {
      const e = toAppException([err('bad name', ['whitelistValidation'])]);
      expect(e.field).toBeNull();
      expect(e.details).toEqual([{ field: '$unknown', reason: 'UNKNOWN_FIELD' }]);
    });

    it('$unknown plus a real bad field: field is the real field', () => {
      const e = toAppException([
        err('bad name', ['whitelistValidation']),
        err('lat', ['treepsWrongType']),
      ]);
      expect(e.field).toBe('lat');
      expect(fieldsOf(e)).toEqual(['$unknown', 'lat']);
    });

    it('several real fields: field is the first in A to Z order', () => {
      const e = toAppException([err('zeta', ['isDefined']), err('alpha', ['isDefined'])]);
      expect(e.field).toBe('alpha');
    });
  });

  describe('unusable input', () => {
    it('a root-level error (no property) is the whole body: field null, no details', () => {
      const root = { constraints: { unknownValue: 'x' }, children: [] } as unknown as ValidationError;
      const e = toAppException([root]);
      expect(e.field).toBeNull();
      expect(e.details).toBeUndefined();
    });

    it('no errors at all gives a plain INVALID_INPUT', () => {
      const e = toAppException([]);
      expect(e.code).toBe('INVALID_INPUT');
      expect(e.details).toBeUndefined();
    });
  });

  describe('what it never reads', () => {
    it('never reads a constraint value, value, target or message text', () => {
      const boom = () => {
        throw new Error('read something it must not');
      };
      const constraints: Record<string, string> = {};
      Object.defineProperty(constraints, 'treepsWrongType', { enumerable: true, get: boom });
      const bad = { property: 'a', constraints, children: [] } as unknown as ValidationError;
      Object.defineProperty(bad, 'value', { get: boom });
      Object.defineProperty(bad, 'target', { get: boom });
      expect(() => toAppException([bad])).not.toThrow();
    });

    it('never lets class-validator text or the submitted value into the exception', async () => {
      class Dto {}
      IsString({ message: 'SECRET-CLASS-VALIDATOR-TEXT' })(Dto.prototype, 'phone');
      Matches(/^x$/, { message: 'SECRET-PATTERN-TEXT' })(Dto.prototype, 'phone');
      // default options on purpose: these errors DO carry value and target
      const errors = await validate(
        plainToInstance(Dto, { phone: 12345, other: 'secret-submitted-value' }),
        { whitelist: true, forbidNonWhitelisted: true },
      );
      const e = toAppException(errors);
      const text = JSON.stringify({
        response: e.getResponse(),
        message: e.message,
        field: e.field,
        details: e.details,
      });
      for (const forbidden of [
        'SECRET-CLASS-VALIDATOR-TEXT',
        'SECRET-PATTERN-TEXT',
        'secret-submitted-value',
        '12345',
        'must be',
      ]) {
        expect(text).not.toContain(forbidden);
      }
      expect(e.details).toEqual([
        { field: 'other', reason: 'UNKNOWN_FIELD' },
        { field: 'phone', reason: 'INVALID_VALUE' },
      ]);
    });

    it('gives every details entry exactly the keys field and reason', () => {
      const e = toAppException([err('a', ['treepsWrongType'])]);
      expect(Object.keys(e.details![0])).toEqual(['field', 'reason']);
    });
  });
});
