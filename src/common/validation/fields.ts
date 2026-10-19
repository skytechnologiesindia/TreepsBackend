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

// For the few fields an API doc marks as nullable: omitted and null both skip every check.
export function OptionalNullable(type: FieldType): PropertyDecorator {
  return applyDecorators(
    ValidateIf((_object, value) => value !== undefined && value !== null),
    ...type.checks,
  );
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

// The OTP the rider typed: exactly 6 ASCII digits, as text so a leading zero survives.
const OTP_CODE = /^[0-9]{6}$/;
export function OtpCode(): FieldType {
  return {
    checks: [
      check(CHECK_KEYS.wrongType, isString),
      check(CHECK_KEYS.invalidFormat, (v) => !isString(v) || OTP_CODE.test(v)),
    ],
  };
}

// The app's install id: 1 to 64 characters from A-Z a-z 0-9 _ -. The shape check allows an empty
// string on purpose, so an empty value is TOO_SHORT (and not INVALID_FORMAT, which would win).
const DEVICE_ID_SHAPE = /^[A-Za-z0-9_-]*$/;
export function DeviceId(): FieldType {
  return {
    checks: [
      check(CHECK_KEYS.wrongType, isString),
      check(CHECK_KEYS.invalidFormat, (v) => !isString(v) || DEVICE_ID_SHAPE.test(v)),
      check(CHECK_KEYS.tooShort, (v) => !isString(v) || v.length >= 1),
      check(CHECK_KEYS.tooLong, (v) => !isString(v) || v.length <= 64),
    ],
  };
}

// The app version label: 1 to 20 characters from A-Z a-z 0-9 . + _ - (so 1.4.2, 1.4.2+37 and
// 2.0.0-beta.1 all pass). The shape check allows an empty string on purpose, so "" is TOO_SHORT.
const APP_VERSION_SHAPE = /^[0-9A-Za-z.+_-]*$/;
export function AppVersion(): FieldType {
  return {
    checks: [
      check(CHECK_KEYS.wrongType, isString),
      check(CHECK_KEYS.invalidFormat, (v) => !isString(v) || APP_VERSION_SHAPE.test(v)),
      check(CHECK_KEYS.tooShort, (v) => !isString(v) || v.length >= 1),
      check(CHECK_KEYS.tooLong, (v) => !isString(v) || v.length <= 20),
    ],
  };
}

// The push token of one install (FCM): 1 to 512 characters, no whitespace of any kind and no NUL.
// The value is never logged, returned or put in an error (error details carry the field name only).
const FCM_TOKEN_SHAPE = /^\S*$/u;
export function FcmToken(): FieldType {
  return {
    checks: [
      check(CHECK_KEYS.wrongType, isString),
      check(CHECK_KEYS.invalidFormat, (v) => !isString(v) || (FCM_TOKEN_SHAPE.test(v) && !v.includes('\u0000'))),
      check(CHECK_KEYS.tooShort, (v) => !isString(v) || v.length >= 1),
      check(CHECK_KEYS.tooLong, (v) => !isString(v) || v.length <= 512),
    ],
  };
}

// An opaque token: base64url of 32 random bytes, always 43 characters (the shape of a session token). No route uses it for input now, so it is kept as a shared type.
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export function OpaqueToken(): FieldType {
  return {
    checks: [
      check(CHECK_KEYS.wrongType, isString),
      check(CHECK_KEYS.invalidFormat, (v) => !isString(v) || OPAQUE_TOKEN.test(v)),
    ],
  };
}

// A person's name (decisions 135 and 141, changed 2026-10-10 by the owner): 2 to 50 code points with
// at least 2 letters; Unicode letters, combining marks, space, . ' ’ and -. Digits, emoji, < > \ / @ # $
// % & *, URLs, newlines and zero-width characters fail the character rule. The text is cleaned by
// Normalize() before it gets here (NFC, spaces collapsed and trimmed), so a stray or double space is
// fixed, not rejected. A hyphen that is first, last or doubled is still rejected.
const PERSON_NAME_CHARACTERS = /^[\p{L}\p{M} .'’-]+$/u;
const LETTER = /\p{L}/gu;
function personNameShapeOk(value: string): boolean {
  return (
    PERSON_NAME_CHARACTERS.test(value) &&
    !value.startsWith(' ') &&
    !value.endsWith(' ') &&
    !value.includes('  ') &&
    !value.startsWith('-') &&
    !value.endsWith('-') &&
    !value.includes('--')
  );
}
export function PersonName(): FieldType {
  const blank = (v: unknown) => v === '';
  return {
    checks: [
      check(CHECK_KEYS.wrongType, isString),
      check(CHECK_KEYS.required, (v) => !blank(v)),
      check(CHECK_KEYS.invalidFormat, (v) => !isString(v) || blank(v) || personNameShapeOk(v)),
      check(CHECK_KEYS.tooShort, (v) => !isString(v) || blank(v) || (codePointLength(v) >= 2 && (v.match(LETTER)?.length ?? 0) >= 2)),
      check(CHECK_KEYS.tooLong, (v) => !isString(v) || codePointLength(v) <= 50),
    ],
  };
}

// A postal-style address line: at most 150 code points; Unicode letters, combining marks, decimal
// digits, space and , . - / # ( ). Cleaned by Normalize() first.
const ADDRESS_CHARACTERS = /^[\p{L}\p{M}\p{Nd} ,.\-/#()]*$/u;
export function Address(): FieldType {
  return {
    checks: [
      check(CHECK_KEYS.wrongType, isString),
      check(CHECK_KEYS.invalidFormat, (v) => !isString(v) || ADDRESS_CHARACTERS.test(v)),
      check(CHECK_KEYS.tooLong, (v) => !isString(v) || codePointLength(v) <= 150),
    ],
  };
}

// The explicit clean-up the owner asked for on profile fields (2026-10-10; this replaces "nothing is
// trimmed or fixed" for these fields only). It runs BEFORE the checks, as a class-transformer step.
//   NFC       : composed form, so one name has one spelling.
//   collapse  : runs of the space character (U+0020) become one space. A newline or a tab inside the
//               text is left alone, so the character rule still rejects it.
//   trim      : leading and trailing whitespace removed (String.prototype.trim).
//   lower     : email.            title: city and state ("new delhi" -> "New Delhi").
// blank is what a text with nothing left becomes: 'unset' makes it undefined (the field counts as
// not sent), 'keep-empty' leaves "" so the length check can reject it. Only strings are touched; any
// other type reaches the checks unchanged and fails there with WRONG_TYPE.
export interface NormalizeOptions {
  lower?: boolean;
  title?: boolean;
  blank: 'unset' | 'keep-empty';
}
function titleCase(text: string): string {
  return text
    .split(/([ -])/u)
    .map((part) => (part.length === 0 ? part : part.charAt(0).toLocaleUpperCase() + part.slice(1).toLocaleLowerCase()))
    .join('');
}
export function normalizeText(value: string, options: NormalizeOptions): string | undefined {
  if (value === '' && options.blank === 'keep-empty') return value;
  let text = value.normalize('NFC').trim().replace(/ {2,}/g, ' ');
  if (options.lower) text = text.toLowerCase();
  if (options.title) text = titleCase(text);
  if (text === '') return options.blank === 'unset' ? undefined : text;
  return text;
}
export function Normalize(options: NormalizeOptions): PropertyDecorator {
  return Transform(({ value }) => (typeof value === 'string' ? normalizeText(value, options) : value));
}

// An email address (decisions 136, 142 and 145): at most 254 characters, no whitespace, no
// uppercase (the app lowercases first, because a Postgres unique index is case-sensitive), and
// local@domain with exactly one @, a non-empty local part and a domain with a dot and no empty part.
function emailShapeOk(value: string): boolean {
  if (/\s/u.test(value) || value !== value.toLowerCase()) return false;
  const parts = value.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (local.length === 0) return false;
  const labels = domain.split('.');
  return labels.length >= 2 && labels.every((label) => label.length > 0);
}
export function Email(): FieldType {
  return {
    checks: [
      check(CHECK_KEYS.wrongType, isString),
      check(CHECK_KEYS.invalidFormat, (v) => !isString(v) || emailShapeOk(v)),
      check(CHECK_KEYS.tooLong, (v) => !isString(v) || v.length <= 254),
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
// emptyIsTooShort: for an optional field, "" is a value the client chose to send, so it fails as
// TOO_SHORT. The default stays REQUIRED, which is right for a required field (rider-register.md).
export function Text(limits: { min: number; max: number; emptyIsTooShort?: boolean }): FieldType {
  const { min, max } = limits;
  assertLimit(
    Number.isSafeInteger(min) && Number.isSafeInteger(max) && min >= 0 && min <= max,
    'Text min/max',
  );
  const blank = (v: unknown) => v === '' && min >= 1 && limits.emptyIsTooShort !== true;
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

const CALENDAR_DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
// A real calendar date written YYYY-MM-DD (a birth date or an expiry date has no time), read as
// midnight UTC. Years before 1900 are refused. Returns the UTC time in milliseconds.
export function parseCalendarDate(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const m = CALENDAR_DATE.exec(value);
  if (!m) return undefined;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1900) return undefined;
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  const real = back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d;
  return real ? t : undefined;
}
export function CalendarDate(limits: { min: () => Date; max: () => Date }): FieldType {
  assertLimit(
    typeof limits?.min === 'function' && typeof limits?.max === 'function',
    'CalendarDate min/max (both must be functions)',
  );
  const earliest = limits.min();
  const latest = limits.max();
  assertLimit(
    earliest instanceof Date &&
      latest instanceof Date &&
      !Number.isNaN(earliest.getTime()) &&
      !Number.isNaN(latest.getTime()) &&
      earliest.getTime() <= latest.getTime(),
    'CalendarDate min() and max() must each return a valid Date, min not after max',
  );
  return {
    checks: [
      check(CHECK_KEYS.wrongType, isString),
      check(CHECK_KEYS.invalidFormat, (v) => !isString(v) || parseCalendarDate(v) !== undefined),
      check(CHECK_KEYS.outOfRange, (v) => {
        const t = parseCalendarDate(v);
        if (t === undefined) return true; // wrong type or format is reported by the checks above
        return t >= limits.min().getTime() && t <= limits.max().getTime();
      }),
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
