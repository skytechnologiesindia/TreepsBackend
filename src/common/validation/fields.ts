import { applyDecorators } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { IsDefined, ValidateBy, ValidateIf, ValidateNested } from 'class-validator';
import { CHECK_KEYS, type CheckKey } from './validation-reasons.js';

// A shared field type is a set of checks. It becomes a decorator only through
// Required() or Optional(), so a field cannot forget to say which it is.
export interface FieldType {
  readonly checks: readonly PropertyDecorator[];
}

export function Required(type: FieldType): PropertyDecorator {
  return applyDecorators(IsDefined(), ...type.checks);
}

export function Optional(type: FieldType): PropertyDecorator {
  return applyDecorators(ValidateIf((_object, value) => value !== undefined), ...type.checks);
}

function check(key: CheckKey, passes: (value: unknown) => boolean): PropertyDecorator {
  return ValidateBy({
    name: key,
    validator: { validate: (value: unknown) => passes(value), defaultMessage: () => 'invalid' },
  });
}

function assertLimit(ok: boolean, what: string): void {
  if (!ok) throw new RangeError(`Invalid validation limit: ${what}`);
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isSafeInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isPlainObject = (v: unknown): boolean =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function degrees(limit: number): FieldType {
  return {
    checks: [
      check(CHECK_KEYS.wrongType, isFiniteNumber),
      check(CHECK_KEYS.outOfRange, (v) => !isFiniteNumber(v) || (v >= -limit && v <= limit)),
    ],
  };
}
export function Latitude(): FieldType {
  return degrees(90);
}
export function Longitude(): FieldType {
  return degrees(180);
}

function integerInRange(min: number, max: number): FieldType {
  return {
    checks: [
      check(CHECK_KEYS.wrongType, isSafeInt),
      check(CHECK_KEYS.outOfRange, (v) => !isSafeInt(v) || (v >= min && v <= max)),
    ],
  };
}
export function Money(limits: { max: number }): FieldType {
  assertLimit(Number.isSafeInteger(limits.max) && limits.max >= 0, 'Money max');
  return integerInRange(0, limits.max);
}
export function Page(limits: { max: number }): FieldType {
  assertLimit(Number.isSafeInteger(limits.max) && limits.max >= 1, 'Page max');
  return integerInRange(1, limits.max);
}
export function PageSize(limits: { max: number }): FieldType {
  assertLimit(Number.isSafeInteger(limits.max) && limits.max >= 1, 'PageSize max');
  return integerInRange(1, limits.max);
}

export function Phone(limits: { minDigits: number; maxDigits: number }): FieldType {
  const { minDigits, maxDigits } = limits;
  assertLimit(
    Number.isInteger(minDigits) &&
      Number.isInteger(maxDigits) &&
      minDigits >= 1 &&
      minDigits <= maxDigits &&
      maxDigits <= 15,
    'Phone minDigits/maxDigits (E.164 allows at most 15 digits)',
  );
  const shape = new RegExp('^[+][1-9][0-9]{' + (minDigits - 1) + ',' + (maxDigits - 1) + '}$');
  return {
    checks: [
      check(CHECK_KEYS.wrongType, isString),
      check(CHECK_KEYS.invalidFormat, (v) => !isString(v) || shape.test(v)),
    ],
  };
}

// An Indian mobile number on the wire: exactly "+91", then 10 digits, the first 6 to 9. It is a
// separate type, not a tightened Phone(), because Phone() is the generic E.164 type that other
// countries or uses may need. Nothing is trimmed, stripped or prefixed: a wrong shape is rejected.
export const INDIAN_MOBILE_PATTERN = /^\+91[6-9][0-9]{9}$/;
export function IndianMobile(): FieldType {
  return {
    checks: [
      check(CHECK_KEYS.wrongType, isString),
      check(CHECK_KEYS.invalidFormat, (v) => !isString(v) || INDIAN_MOBILE_PATTERN.test(v)),
    ],
  };
}

const UTC_SHAPE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
function parseUtc(value: unknown): number | undefined {
  if (!isString(value)) return undefined;
  const m = UTC_SHAPE.exec(value);
  if (!m) return undefined;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const ms = Number((m[7] ?? '0').padEnd(3, '0'));
  const t = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const back = new Date(t);
  // Rebuild the date and compare every part: this rejects 02-30, hour 24 and second 60.
  // It also rejects years 0000 to 0099, because Date.UTC treats them as 1900 to 1999.
  const real =
    back.getUTCFullYear() === y &&
    back.getUTCMonth() === mo - 1 &&
    back.getUTCDate() === d &&
    back.getUTCHours() === h &&
    back.getUTCMinutes() === mi &&
    back.getUTCSeconds() === s;
  return real ? t : undefined;
}
export function UtcDate(limits: { min: () => Date; max: () => Date }): FieldType {
  // Checked once at definition time, so a broken limit stops the server at startup
  // instead of failing during a request. The messages never print a date value.
  assertLimit(
    typeof limits?.min === 'function' && typeof limits?.max === 'function',
    'UtcDate min/max (both must be functions)',
  );
  const earliest = limits.min();
  const latest = limits.max();
  assertLimit(
    earliest instanceof Date &&
      latest instanceof Date &&
      !Number.isNaN(earliest.getTime()) &&
      !Number.isNaN(latest.getTime()),
    'UtcDate min() and max() must each return a valid Date',
  );
  assertLimit(earliest.getTime() <= latest.getTime(), 'UtcDate min() must not be after max()');
  return {
    checks: [
      check(CHECK_KEYS.wrongType, isString),
      check(CHECK_KEYS.invalidFormat, (v) => !isString(v) || parseUtc(v) !== undefined),
      check(CHECK_KEYS.outOfRange, (v) => {
        const t = parseUtc(v);
        if (t === undefined) return true; // wrong type or format is reported by the checks above
        return t >= limits.min().getTime() && t <= limits.max().getTime();
      }),
    ],
  };
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-([1-8])[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type UuidVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export function Uuid(options: { versions: 'all' | readonly UuidVersion[] }): FieldType {
  const { versions } = options;
  assertLimit(versions === 'all' || versions.length > 0, 'Uuid versions');
  return {
    checks: [
      check(CHECK_KEYS.wrongType, isString),
      check(CHECK_KEYS.invalidFormat, (v) => {
        if (!isString(v)) return true;
        const m = UUID_SHAPE.exec(v);
        if (!m) return false;
        return versions === 'all' || versions.includes(Number(m[1]) as UuidVersion);
      }),
    ],
  };
}

// Length is counted in Unicode code points (an emoji counts as 1), which is how users
// and Postgres count characters.
function codePointLength(text: string): number {
  return Array.from(text).length;
}
export function Text(limits: { min: number; max: number }): FieldType {
  const { min, max } = limits;
  assertLimit(
    Number.isSafeInteger(min) && Number.isSafeInteger(max) && min >= 0 && min <= max,
    'Text min/max',
  );
  const blank = (v: unknown) => v === '' && min >= 1;
  return {
    checks: [
      check(CHECK_KEYS.wrongType, isString),
      check(CHECK_KEYS.required, (v) => !blank(v)),
      // Postgres cannot store U+0000 in text, so it must never reach the database.
      check(CHECK_KEYS.invalidFormat, (v) => !isString(v) || !v.includes('\u0000')),
      check(CHECK_KEYS.tooShort, (v) => !isString(v) || blank(v) || codePointLength(v) >= min),
      check(CHECK_KEYS.tooLong, (v) => !isString(v) || codePointLength(v) <= max),
    ],
  };
}

export function OneOf(values: readonly string[]): FieldType {
  assertLimit(values.length > 0, 'OneOf values');
  const allowed = new Set(values);
  return {
    checks: [
      check(CHECK_KEYS.wrongType, isString),
      check(CHECK_KEYS.notAllowed, (v) => !isString(v) || allowed.has(v)),
    ],
  };
}

type DtoClass = new () => object;

export function Nested(dto: () => DtoClass): FieldType {
  return { checks: [check(CHECK_KEYS.wrongType, isPlainObject), Type(dto), ValidateNested()] };
}
export function NestedList(dto: () => DtoClass, limits: { min: number; max: number }): FieldType {
  assertLimit(
    Number.isSafeInteger(limits.min) &&
      Number.isSafeInteger(limits.max) &&
      limits.min >= 0 &&
      limits.min <= limits.max,
    'NestedList min/max',
  );
  return {
    checks: [
      check(CHECK_KEYS.wrongType, Array.isArray),
      check(CHECK_KEYS.tooShort, (v) => !Array.isArray(v) || v.length >= limits.min),
      check(CHECK_KEYS.tooLong, (v) => !Array.isArray(v) || v.length <= limits.max),
      Type(dto),
      ValidateNested({ each: true }),
    ],
  };
}

const PLAIN_DECIMAL = /^(0|[1-9][0-9]*)$/;
// Explicit, strict text-to-integer conversion for query and path values (rule 4).
export function ToInt(): PropertyDecorator {
  return Transform(({ value }) => {
    if (typeof value !== 'string' || !PLAIN_DECIMAL.test(value)) return value;
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : value;
  });
}
