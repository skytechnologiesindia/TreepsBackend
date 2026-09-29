import { readFileSync } from 'node:fs';
import { CHECK_KEYS, REASON_CODES, reasonFor, type ReasonCode } from './validation-reasons.js';

const doc = readFileSync(
  new URL('../../../docs/standards/input-validation.md', import.meta.url),
  'utf8',
);
const section = doc.split('## 3. Reason codes')[1]?.split('\n## ')[0] ?? '';
const docCodes = [...section.matchAll(/^\| ([A-Z_]+) \|/gm)].map((m) => m[1]);
const docPriority = /first code in this order wins: ([A-Z_, ]+)\./.exec(section)?.[1].split(', ');

// One key per code, used to test priority. INVALID_VALUE has no key on purpose.
const KEY_FOR: Record<ReasonCode, string> = {
  REQUIRED: CHECK_KEYS.required,
  UNKNOWN_FIELD: 'whitelistValidation',
  WRONG_TYPE: CHECK_KEYS.wrongType,
  INVALID_FORMAT: CHECK_KEYS.invalidFormat,
  OUT_OF_RANGE: CHECK_KEYS.outOfRange,
  NOT_ALLOWED: CHECK_KEYS.notAllowed,
  TOO_SHORT: CHECK_KEYS.tooShort,
  TOO_LONG: CHECK_KEYS.tooLong,
  INVALID_VALUE: 'someUnmappedKey',
};

describe('reason codes', () => {
  it('match input-validation.md section 3, in the same order', () => {
    expect(docCodes.length, 'input-validation.md section 3 table could not be read').toBe(9);
    expect([...REASON_CODES]).toEqual(docCodes);
    expect([...REASON_CODES]).toEqual(docPriority);
  });

  it('are UPPER_SNAKE_CASE', () => {
    for (const code of REASON_CODES) expect(code).toMatch(/^[A-Z]+(_[A-Z]+)*$/);
  });
});

describe('reasonFor: constraint key to code', () => {
  it.each([
    ['isDefined', 'REQUIRED'],
    ['treepsRequired', 'REQUIRED'],
    ['whitelistValidation', 'UNKNOWN_FIELD'],
    ['treepsWrongType', 'WRONG_TYPE'],
    ['nestedValidation', 'WRONG_TYPE'],
    ['treepsInvalidFormat', 'INVALID_FORMAT'],
    ['treepsOutOfRange', 'OUT_OF_RANGE'],
    ['treepsNotAllowed', 'NOT_ALLOWED'],
    ['treepsTooShort', 'TOO_SHORT'],
    ['treepsTooLong', 'TOO_LONG'],
  ])('%s gives %s', (key, code) => {
    expect(reasonFor([key])).toBe(code);
  });

  it('maps every key our own checks can produce', () => {
    for (const key of Object.values(CHECK_KEYS)) {
      expect(reasonFor([key])).not.toBe('INVALID_VALUE');
    }
  });

  it.each(['isEmail', 'someNewValidator', '__proto__', 'constructor', 'toString', ''])(
    'an unmapped key (%j) gives INVALID_VALUE',
    (key) => {
      expect(reasonFor([key])).toBe('INVALID_VALUE');
    },
  );

  it('gives INVALID_VALUE for an empty list', () => {
    expect(reasonFor([])).toBe('INVALID_VALUE');
  });

  it('lets a mapped key beat an unmapped one', () => {
    expect(reasonFor(['someNewValidator', CHECK_KEYS.tooLong])).toBe('TOO_LONG');
  });
});

describe('priority', () => {
  it('the earlier code wins for every pair, in either input order', () => {
    for (let i = 0; i < REASON_CODES.length; i++) {
      for (let j = i + 1; j < REASON_CODES.length; j++) {
        const [a, b] = [REASON_CODES[i], REASON_CODES[j]];
        expect(reasonFor([KEY_FOR[a], KEY_FOR[b]])).toBe(a);
        expect(reasonFor([KEY_FOR[b], KEY_FOR[a]])).toBe(a);
      }
    }
  });
});
