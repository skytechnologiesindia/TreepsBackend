import { readFileSync } from 'node:fs';
import { REASON_CODES } from '../common/validation/validation-reasons.js';
import {
  DEFAULT_PORT,
  EnvConfigError,
  NODE_ENVS,
  validateEnv,
  type EnvProblem,
} from './env.validation.js';

const VALID_URL = 'postgresql://user:pass@localhost:5432/db?schema=public';
const VALID = { DATABASE_URL: VALID_URL, NODE_ENV: 'development' };

function problemsOf(config: Record<string, unknown>): EnvProblem[] {
  try {
    validateEnv(config);
  } catch (error) {
    return [...(error as EnvConfigError).problems];
  }
  return [];
}
const reasonsFor = (variable: string, config: Record<string, unknown>) =>
  problemsOf(config)
    .filter((p) => p.variable === variable)
    .map((p) => p.reason);

describe('validateEnv', () => {
  describe('a valid configuration', () => {
    it('returns the values, with PORT defaulting to 3000 as a number', () => {
      const result = validateEnv(VALID);
      expect(result.DATABASE_URL).toBe(VALID_URL);
      expect(result.NODE_ENV).toBe('development');
      expect(result.PORT).toBe(3000);
      expect(DEFAULT_PORT).toBe(3000);
    });

    it('converts PORT explicitly to a number', () => {
      expect(validateEnv({ ...VALID, PORT: '8080' }).PORT).toBe(8080);
    });

    it('keeps every other variable available', () => {
      expect(validateEnv({ ...VALID, FIREBASE_PROJECT_ID: 'p' }).FIREBASE_PROJECT_ID).toBe('p');
    });
  });

  describe('DATABASE_URL', () => {
    it.each([[undefined], [null], ['']])('%j is REQUIRED', (value) => {
      expect(reasonsFor('DATABASE_URL', { ...VALID, DATABASE_URL: value })).toEqual(['REQUIRED']);
    });

    it.each([
      ['not a url'],
      ['postgresql:'],
      ['://x'],
      [' postgresql://u:p@h/db'],
      ['postgresql://u:p@h/db '],
      [12345],
    ])('garbage %j is INVALID_FORMAT', (value) => {
      expect(reasonsFor('DATABASE_URL', { ...VALID, DATABASE_URL: value })).toEqual([
        'INVALID_FORMAT',
      ]);
    });

    it.each([['mysql://u:p@h/db'], ['http://h/db'], ['file:///x'], ['redis://h:6379']])(
      'the wrong protocol %j is INVALID_FORMAT',
      (value) => {
        expect(reasonsFor('DATABASE_URL', { ...VALID, DATABASE_URL: value })).toEqual([
          'INVALID_FORMAT',
        ]);
      },
    );

    it.each([['postgres://u:p@h:5432/db'], ['postgresql://u:p@h/db?schema=public']])(
      'accepts %s',
      (value) => {
        expect(problemsOf({ ...VALID, DATABASE_URL: value })).toEqual([]);
      },
    );
  });

  describe('DATABASE_URL prefix and control characters', () => {
    it.each([['postgres:///db'], ['POSTGRESQL://u:p@h/db'], ['postgres://u:p@h:5432/db']])(
      'accepts %s',
      (value) => {
        expect(problemsOf({ ...VALID, DATABASE_URL: value })).toEqual([]);
      },
    );

    it.each([
      ['postgresql:'],
      ['postgresql:host/db'],
      ['postgres:'],
      ['postgresql://u:p@h/db\nX'],
      ['postgresql://u:p@h/db\u0000'],
      ['postgresql://u:p@h/\tdb'],
      ['postgresql://u:p@h/db\r'],
      ['postgresql://u:p@h/db\u001f'],
      ['\npostgresql://u:p@h/db'],
    ])('rejects %j as INVALID_FORMAT', (value) => {
      expect(reasonsFor('DATABASE_URL', { ...VALID, DATABASE_URL: value })).toEqual([
        'INVALID_FORMAT',
      ]);
    });
  });

  describe('PORT', () => {
    it.each([['1', 1], ['80', 80], ['65535', 65535]])('accepts %j as %d', (value, port) => {
      expect(validateEnv({ ...VALID, PORT: value }).PORT).toBe(port);
    });

    it.each([['0'], ['65536'], ['9'.repeat(400)]])('%j is OUT_OF_RANGE', (value) => {
      expect(reasonsFor('PORT', { ...VALID, PORT: value })).toEqual(['OUT_OF_RANGE']);
    });

    it.each([['80a'], [''], [' 80'], ['80 '], ['080'], ['00'], ['-1'], ['8e3'], ['+80'], ['٨٠']])(
      '%j is INVALID_FORMAT',
      (value) => {
        expect(reasonsFor('PORT', { ...VALID, PORT: value })).toEqual(['INVALID_FORMAT']);
      },
    );

    it('a value that is not a string is INVALID_FORMAT', () => {
      expect(reasonsFor('PORT', { ...VALID, PORT: 80 })).toEqual(['INVALID_FORMAT']);
      expect(reasonsFor('PORT', { ...VALID, PORT: null })).toEqual(['INVALID_FORMAT']);
    });
  });

  describe('NODE_ENV', () => {
    it.each([[undefined], [null], ['']])('%j is REQUIRED (there is no default)', (value) => {
      expect(reasonsFor('NODE_ENV', { ...VALID, NODE_ENV: value })).toEqual(['REQUIRED']);
    });

    it.each([['staging'], ['Production'], ['dev'], ['TEST'], [' test']])(
      '%j is NOT_ALLOWED (exact, case-sensitive)',
      (value) => {
        expect(reasonsFor('NODE_ENV', { ...VALID, NODE_ENV: value })).toEqual(['NOT_ALLOWED']);
      },
    );

    it.each(NODE_ENVS.map((v) => [v]))('accepts %s', (value) => {
      expect(validateEnv({ ...VALID, NODE_ENV: value }).NODE_ENV).toBe(value);
    });
  });

  describe('the error', () => {
    it('reports every bad variable together, in order, in one message', () => {
      let error: EnvConfigError | undefined;
      try {
        validateEnv({ PORT: '65536' });
      } catch (e) {
        error = e as EnvConfigError;
      }
      expect(error).toBeInstanceOf(EnvConfigError);
      expect(error!.name).toBe('EnvConfigError');
      expect(error!.problems).toEqual([
        { variable: 'DATABASE_URL', reason: 'REQUIRED' },
        { variable: 'PORT', reason: 'OUT_OF_RANGE' },
        { variable: 'NODE_ENV', reason: 'REQUIRED' },
      ]);
      expect(error!.message).toBe(
        'Invalid environment configuration: DATABASE_URL (REQUIRED), PORT (OUT_OF_RANGE), NODE_ENV (REQUIRED). ' +
          'See docs/standards/input-validation.md section 6 and .env.example.',
      );
    });

    describe('never contains a value', () => {
      const SECRETS = [
        'SECRET-USER-xyz',
        'SECRET-PASSWORD-xyz',
        'SECRET-HOST-xyz',
        'SECRET-PORT-VALUE',
        'SECRET-ENV-VALUE',
        'SECRET-OTHER-VALUE',
      ];
      const config = {
        DATABASE_URL: 'mysql://SECRET-USER-xyz:SECRET-PASSWORD-xyz@SECRET-HOST-xyz/db',
        PORT: 'SECRET-PORT-VALUE',
        NODE_ENV: 'SECRET-ENV-VALUE',
        OTHER: 'SECRET-OTHER-VALUE',
      };
      let error: EnvConfigError;

      beforeAll(() => {
        try {
          validateEnv(config);
        } catch (e) {
          error = e as EnvConfigError;
        }
        expect(error).toBeInstanceOf(EnvConfigError);
      });

      it.each([
        ['error.message', () => error.message],
        ['error.stack', () => String(error.stack)],
        ['JSON.stringify(error)', () => JSON.stringify(error)],
        ['Object.keys(error)', () => JSON.stringify(Object.keys(error))],
        ['every own property, including the hidden ones', () =>
          JSON.stringify(
            Object.fromEntries(
              Object.getOwnPropertyNames(error).map((k) => [k, (error as any)[k]]),
            ),
          )],
      ])('%s', (_name, read) => {
        const text = read();
        for (const secret of SECRETS) expect(text).not.toContain(secret);
      });

      it('does not keep the raw config: only the variable names and reason codes', () => {
        expect(Object.getOwnPropertyNames(error).sort()).toEqual(['message', 'name', 'problems', 'stack']);
        expect(Object.keys(error).sort()).toEqual(['name', 'problems']);
        expect(Object.values(error)).not.toContain(config);
        for (const problem of error.problems) {
          expect(Object.keys(problem).sort()).toEqual(['reason', 'variable']);
          expect(REASON_CODES).toContain(problem.reason);
        }
      });
    });
  });

  describe('input-validation.md section 6 (drift guard)', () => {
    const doc = readFileSync(
      new URL('../../docs/standards/input-validation.md', import.meta.url),
      'utf8',
    );
    const section = doc.split('## 6. Startup configuration')[1]?.split('\n## ')[0] ?? '';
    const docReasons = (variable: string) =>
      new Set(
        (new RegExp(`^\\| ${variable} \\|.*\\| ([A-Z_, ]+) \\|$`, 'm').exec(section)?.[1] ?? '')
          .split(', ')
          .filter(Boolean),
      );

    it.each([
      ['DATABASE_URL', [undefined, 'not a url']],
      ['PORT', ['80a', '0']],
      ['NODE_ENV', [undefined, 'staging']],
    ] as const)('%s: the reasons the code can give are exactly the ones the doc lists', (variable, badValues) => {
      const produced = new Set<string>();
      for (const value of badValues) {
        const config: Record<string, unknown> = { ...VALID, [variable]: value };
        for (const reason of reasonsFor(variable, config)) produced.add(reason);
      }
      expect(docReasons(variable).size, 'section 6 table row could not be read').toBeGreaterThan(0);
      expect(produced).toEqual(docReasons(variable));
    });
  });
});
