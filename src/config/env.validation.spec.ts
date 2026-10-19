import { readFileSync } from 'node:fs';
import { REASON_CODES } from '../common/validation/validation-reasons.js';
import {
  DEFAULT_PORT,
  DEFAULT_TERMS_VERSION,
  DEFAULT_TRUST_PROXY_HOPS,
  EnvConfigError,
  NODE_ENVS,
  validateEnv,
  type EnvProblem,
} from './env.validation.js';

const VALID_URL = 'postgresql://user:pass@localhost:5432/db?schema=public';
// Placeholders only: nothing here is a real key or secret.
const VALID = {
  DATABASE_URL: VALID_URL,
  NODE_ENV: 'development',
  OTP_PROVIDER: 'twofactor',
  TWOFACTOR_API_KEY: 'placeholder-2factor-api-key',
};
// The fake provider needs both settings and a 6-digit code (and is refused in production).
const FAKE = {
  DATABASE_URL: VALID_URL,
  NODE_ENV: 'development',
  OTP_PROVIDER: 'fake',
  ALLOW_FAKE_OTP: 'true',
  FAKE_OTP_CODE: '123456',
};

// Photos go to a bucket in production. Placeholders only.
const S3 = { STORAGE_DRIVER: 's3', S3_BUCKET: 'treeps-driver-documents', S3_REGION: 'ap-south-1' };

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
      expect(result.OTP_PROVIDER).toBe('twofactor');
      expect(result.TRUST_PROXY_HOPS).toBe(0);
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
      expect(validateEnv({ ...VALID, ...S3, NODE_ENV: value }).NODE_ENV).toBe(value);
    });
  });

  describe('OTP_PROVIDER', () => {
    it.each([[undefined], [null], ['']])('%j is REQUIRED (there is no default)', (value) => {
      expect(reasonsFor('OTP_PROVIDER', { ...VALID, OTP_PROVIDER: value })).toEqual(['REQUIRED']);
    });

    it.each([['TwoFactor'], ['FAKE'], ['sms'], [' fake'], ['twofactor '], [1]])(
      '%j is NOT_ALLOWED (exact, case-sensitive)',
      (value) => {
        expect(reasonsFor('OTP_PROVIDER', { ...VALID, OTP_PROVIDER: value })).toEqual(['NOT_ALLOWED']);
      },
    );

    it('accepts twofactor in every NODE_ENV', () => {
      for (const env of NODE_ENVS) {
        expect(validateEnv({ ...VALID, ...S3, NODE_ENV: env }).OTP_PROVIDER).toBe('twofactor');
      }
    });

    it.each([['development'], ['test']])('accepts fake with both settings in %s', (env) => {
      expect(validateEnv({ ...FAKE, NODE_ENV: env }).OTP_PROVIDER).toBe('fake');
    });

    it('refuses fake in production, even with ALLOW_FAKE_OTP=true and a valid code', () => {
      const config = { ...FAKE, ...S3, NODE_ENV: 'production' };
      expect(config.ALLOW_FAKE_OTP).toBe('true');
      expect(problemsOf(config)).toEqual([{ variable: 'OTP_PROVIDER', reason: 'NOT_ALLOWED' }]);
      expect(() => validateEnv(config)).toThrow(/OTP_PROVIDER \(NOT_ALLOWED\)/);
    });

    it('twofactor is allowed in production', () => {
      expect(problemsOf({ ...VALID, NODE_ENV: 'production', ...S3 })).toEqual([]);
    });
  });

  describe('ALLOW_FAKE_OTP (read only when OTP_PROVIDER is fake)', () => {
    it.each([[undefined], [null], ['']])('%j with fake is REQUIRED', (value) => {
      expect(reasonsFor('ALLOW_FAKE_OTP', { ...FAKE, ALLOW_FAKE_OTP: value })).toEqual(['REQUIRED']);
    });

    it.each([['false'], ['TRUE'], ['True'], ['1'], ['yes'], [' true'], ['true '], [true]])(
      '%j with fake is NOT_ALLOWED (it must be exactly "true")',
      (value) => {
        expect(reasonsFor('ALLOW_FAKE_OTP', { ...FAKE, ALLOW_FAKE_OTP: value })).toEqual(['NOT_ALLOWED']);
      },
    );

    it('is not read for twofactor, whatever it holds', () => {
      expect(problemsOf({ ...VALID, ALLOW_FAKE_OTP: 'nonsense' })).toEqual([]);
    });
  });

  describe('FAKE_OTP_CODE (read only when OTP_PROVIDER is fake)', () => {
    it.each([[undefined], [null], ['']])('%j with fake is REQUIRED', (value) => {
      expect(reasonsFor('FAKE_OTP_CODE', { ...FAKE, FAKE_OTP_CODE: value })).toEqual(['REQUIRED']);
    });

    it.each([['12345'], ['1234567'], ['12a456'], [' 12345'], ['١٢٣٤٥٦'], [123456]])(
      '%j is INVALID_FORMAT (exactly 6 ASCII digits, as text)',
      (value) => {
        expect(reasonsFor('FAKE_OTP_CODE', { ...FAKE, FAKE_OTP_CODE: value })).toEqual(['INVALID_FORMAT']);
      },
    );

    it.each([['000000'], ['012345'], ['123456']])('accepts %s', (value) => {
      expect(problemsOf({ ...FAKE, FAKE_OTP_CODE: value })).toEqual([]);
    });

    it('is not read for twofactor, whatever it holds', () => {
      expect(problemsOf({ ...VALID, FAKE_OTP_CODE: 'nonsense' })).toEqual([]);
    });
  });

  describe('TWOFACTOR_API_KEY (read only when OTP_PROVIDER is twofactor)', () => {
    it.each([[undefined], [null], ['']])('%j with twofactor is REQUIRED', (value) => {
      expect(reasonsFor('TWOFACTOR_API_KEY', { ...VALID, TWOFACTOR_API_KEY: value })).toEqual(['REQUIRED']);
    });

    it.each([[' key'], ['key '], ['ke\ny'], ['ke\u0000y'], ['   '], [42]])(
      '%j is INVALID_FORMAT',
      (value) => {
        expect(reasonsFor('TWOFACTOR_API_KEY', { ...VALID, TWOFACTOR_API_KEY: value })).toEqual([
          'INVALID_FORMAT',
        ]);
      },
    );

    it('is not required for fake', () => {
      expect(problemsOf({ ...FAKE, TWOFACTOR_API_KEY: undefined })).toEqual([]);
    });
  });

  describe('TWOFACTOR_TEMPLATE (optional, read only when OTP_PROVIDER is twofactor)', () => {
    it('is optional', () => {
      expect(problemsOf({ ...VALID, TWOFACTOR_TEMPLATE: undefined })).toEqual([]);
      expect(problemsOf({ ...VALID, TWOFACTOR_TEMPLATE: 'OTP_2-b' })).toEqual([]);
    });

    it.each([[''], ['a b'], ['a/b'], ['a?b'], ['x'.repeat(51)], [42]])('%j is INVALID_FORMAT', (value) => {
      expect(reasonsFor('TWOFACTOR_TEMPLATE', { ...VALID, TWOFACTOR_TEMPLATE: value })).toEqual(['INVALID_FORMAT']);
    });

    it('is not read for fake', () => {
      expect(problemsOf({ ...FAKE, TWOFACTOR_TEMPLATE: 'a/b' })).toEqual([]);
    });
  });

  describe('STORAGE_DRIVER, S3_BUCKET, S3_REGION and S3_ENDPOINT', () => {
    it('defaults to the local folder outside production', () => {
      expect(validateEnv(VALID).STORAGE_DRIVER).toBe('local');
      expect(validateEnv({ ...VALID, STORAGE_DRIVER: 'local' }).STORAGE_DRIVER).toBe('local');
    });

    it('production must say s3: missing is REQUIRED and local is NOT_ALLOWED', () => {
      expect(reasonsFor('STORAGE_DRIVER', { ...VALID, NODE_ENV: 'production' })).toEqual(['REQUIRED']);
      expect(reasonsFor('STORAGE_DRIVER', { ...VALID, NODE_ENV: 'production', STORAGE_DRIVER: 'local' })).toEqual(['NOT_ALLOWED']);
      expect(problemsOf({ ...VALID, NODE_ENV: 'production', ...S3 })).toEqual([]);
    });

    it('refuses an unknown driver', () => {
      for (const value of ['gcs', 'S3', '', 5, null]) {
        expect(reasonsFor('STORAGE_DRIVER', { ...VALID, STORAGE_DRIVER: value })).toEqual(['NOT_ALLOWED']);
      }
    });

    it('s3 needs a bucket and a region', () => {
      expect(reasonsFor('S3_BUCKET', { ...VALID, STORAGE_DRIVER: 's3', S3_REGION: 'ap-south-1' })).toEqual(['REQUIRED']);
      expect(reasonsFor('S3_REGION', { ...VALID, STORAGE_DRIVER: 's3', S3_BUCKET: 'treeps-docs' })).toEqual(['REQUIRED']);
    });

    it('checks the shape of the bucket name and the region', () => {
      for (const bucket of ['AB', 'Has_Upper', '-leading', 'trailing-', 'has space', 'x'.repeat(64), 5]) {
        expect(reasonsFor('S3_BUCKET', { ...VALID, ...S3, S3_BUCKET: bucket })).toEqual(['INVALID_FORMAT']);
      }
      for (const region of ['Mumbai', 'ap_south_1', 'ap-south', 'us-east-100', 5]) {
        expect(reasonsFor('S3_REGION', { ...VALID, ...S3, S3_REGION: region })).toEqual(['INVALID_FORMAT']);
      }
      for (const region of ['ap-south-1', 'us-east-1', 'eu-west-2', 'auto']) {
        expect(reasonsFor('S3_REGION', { ...VALID, ...S3, S3_REGION: region })).toEqual([]);
      }
    });

    it('the endpoint is optional, https only, and carries no password', () => {
      expect(reasonsFor('S3_ENDPOINT', { ...VALID, ...S3 })).toEqual([]);
      expect(reasonsFor('S3_ENDPOINT', { ...VALID, ...S3, S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com' })).toEqual([]);
      for (const endpoint of ['http://insecure.example.com', 'https://user:pass@host.example.com', 'not a url', ' https://x.com', '']) {
        expect(reasonsFor('S3_ENDPOINT', { ...VALID, ...S3, S3_ENDPOINT: endpoint })).toEqual(['INVALID_FORMAT']);
      }
    });

    it('does not read the bucket settings when the folder is used', () => {
      expect(problemsOf({ ...VALID, S3_BUCKET: 'NOT A BUCKET', S3_REGION: '???' })).toEqual([]);
    });

    it('never puts a value in the error', () => {
      try {
        validateEnv({ ...VALID, STORAGE_DRIVER: 's3', S3_BUCKET: 'Bad_Bucket_Name_Secret', S3_REGION: 'ap-south-1' });
      } catch (error) {
        expect((error as Error).message).toContain('S3_BUCKET (INVALID_FORMAT)');
        expect((error as Error).message).not.toContain('Secret');
      }
    });
  });

  describe('TRUST_PROXY_HOPS', () => {
    it('defaults to 0 (untrusted) as a number when it is not set', () => {
      expect(validateEnv(VALID).TRUST_PROXY_HOPS).toBe(0);
      expect(DEFAULT_TRUST_PROXY_HOPS).toBe(0);
    });

    it.each([['0', 0], ['1', 1], ['2', 2], ['10', 10]])('accepts %j as %d', (value, hops) => {
      expect(validateEnv({ ...VALID, TRUST_PROXY_HOPS: value }).TRUST_PROXY_HOPS).toBe(hops);
    });

    it.each([['11'], ['100'], ['9'.repeat(400)]])('%j is OUT_OF_RANGE', (value) => {
      expect(reasonsFor('TRUST_PROXY_HOPS', { ...VALID, TRUST_PROXY_HOPS: value })).toEqual(['OUT_OF_RANGE']);
    });

    it.each([[''], ['-1'], ['01'], ['00'], ['1.5'], ['1e1'], [' 1'], ['1 '], ['+1'], ['two'], ['١']])(
      '%j is INVALID_FORMAT',
      (value) => {
        expect(reasonsFor('TRUST_PROXY_HOPS', { ...VALID, TRUST_PROXY_HOPS: value })).toEqual([
          'INVALID_FORMAT',
        ]);
      },
    );

    it('a value that is not a string is INVALID_FORMAT', () => {
      expect(reasonsFor('TRUST_PROXY_HOPS', { ...VALID, TRUST_PROXY_HOPS: 1 })).toEqual(['INVALID_FORMAT']);
      expect(reasonsFor('TRUST_PROXY_HOPS', { ...VALID, TRUST_PROXY_HOPS: null })).toEqual(['INVALID_FORMAT']);
    });
  });

  describe('TERMS_VERSION', () => {
    it('defaults to 2026-10-v1 when it is not set', () => {
      expect(validateEnv(VALID).TERMS_VERSION).toBe('2026-10-v1');
      expect(DEFAULT_TERMS_VERSION).toBe('2026-10-v1');
    });

    it.each([['2027-01-v2'], ['v1'], ['a.b_c-d'], ['x'.repeat(32)]])('accepts %j', (value) => {
      expect(validateEnv({ ...VALID, TERMS_VERSION: value }).TERMS_VERSION).toBe(value);
    });

    it.each([[''], [' v1'], ['v 1'], ['x'.repeat(33)], ['v1/../x'], [7], [null]])('%j is INVALID_FORMAT', (value) => {
      expect(reasonsFor('TERMS_VERSION', { ...VALID, TERMS_VERSION: value })).toEqual(['INVALID_FORMAT']);
    });
  });

  describe('the new keys never put a value in the error', () => {
    const SECRETS = ['SECRET-JWT-VALUE', 'SECRET-KEY-VALUE', 'SECRET-CODE-VALUE', 'SECRET-ALLOW-VALUE', 'SECRET-HOPS-VALUE'];
    const bad = [
      { ...VALID, TWOFACTOR_API_KEY: ' ' + SECRETS[1] },
      { ...FAKE, FAKE_OTP_CODE: SECRETS[2], ALLOW_FAKE_OTP: SECRETS[3] },
      { ...VALID, TRUST_PROXY_HOPS: SECRETS[4] },
      { ...FAKE, NODE_ENV: 'production', FAKE_OTP_CODE: '123456' },
    ];

    it.each(bad.map((config, i) => [i, config] as const))('case %d: message, stack and own properties hold no value', (_i, config) => {
      let error: EnvConfigError | undefined;
      try {
        validateEnv(config);
      } catch (e) {
        error = e as EnvConfigError;
      }
      expect(error).toBeInstanceOf(EnvConfigError);
      const text = [
        error!.message,
        String(error!.stack),
        JSON.stringify(error),
        JSON.stringify(Object.getOwnPropertyNames(error).map((k) => (error as any)[k])),
      ].join(' ');
      for (const secret of [...SECRETS, FAKE.ALLOW_FAKE_OTP + '-no-such-text']) expect(text).not.toContain(secret);
      expect(text).not.toContain('123456');
    });

    it('names the key and the reason', () => {
      expect(() => validateEnv({ ...VALID, TRUST_PROXY_HOPS: '1x' })).toThrow(/TRUST_PROXY_HOPS \(INVALID_FORMAT\)/);
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
        { variable: 'OTP_PROVIDER', reason: 'REQUIRED' },
      ]);
      expect(error!.message).toBe(
        'Invalid environment configuration: DATABASE_URL (REQUIRED), PORT (OUT_OF_RANGE), NODE_ENV (REQUIRED), ' +
          'OTP_PROVIDER (REQUIRED). ' +
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
    const providerCases = [
      ['ALLOW_FAKE_OTP', FAKE, [undefined, 'false']],
      ['FAKE_OTP_CODE', FAKE, [undefined, '12']],
      ['TWOFACTOR_API_KEY', VALID, [undefined, ' key']],
    ] as const;
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
      ['OTP_PROVIDER', [undefined, 'sms']],
      ['TRUST_PROXY_HOPS', ['1x', '11']],
    ] as const)('%s: the reasons the code can give are exactly the ones the doc lists', (variable, badValues) => {
      const produced = new Set<string>();
      for (const value of badValues) {
        const config: Record<string, unknown> = { ...VALID, [variable]: value };
        for (const reason of reasonsFor(variable, config)) produced.add(reason);
      }
      expect(docReasons(variable).size, 'section 6 table row could not be read').toBeGreaterThan(0);
      expect(produced).toEqual(docReasons(variable));
    });

    it.each(providerCases)('%s: the reasons the code can give are exactly the ones the doc lists', (variable, base, badValues) => {
      const produced = new Set<string>();
      for (const value of badValues) {
        for (const reason of reasonsFor(variable, { ...base, [variable]: value })) produced.add(reason);
      }
      expect(docReasons(variable).size, 'section 6 table row could not be read').toBeGreaterThan(0);
      expect(produced).toEqual(docReasons(variable));
    });

    it('OTP_PROVIDER: the production refusal uses a reason the doc lists', () => {
      const production = reasonsFor('OTP_PROVIDER', { ...FAKE, NODE_ENV: 'production' });
      expect(production).toEqual(['NOT_ALLOWED']);
      expect(docReasons('OTP_PROVIDER').has('NOT_ALLOWED')).toBe(true);
    });
  });
});
