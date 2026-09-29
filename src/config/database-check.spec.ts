import pg from 'pg';
import {
  assertDatabaseReachable,
  DATABASE_CHECK_FAILED,
  DATABASE_CHECK_TIMEOUT_MS,
  DatabaseCheckError,
  type CheckClient,
} from './database-check.js';

const URL_WITH_SECRETS = 'postgresql://SECRET-USER-xyz:SECRET-PASSWORD-xyz@SECRET-HOST-xyz:5432/db';
const DRIVER_TEXT = 'password authentication failed for user "SECRET-USER-xyz" (SECRET-PASSWORD-xyz)';
const SECRETS = ['SECRET-USER-xyz', 'SECRET-PASSWORD-xyz', 'SECRET-HOST-xyz', 'password authentication'];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fake(overrides: Partial<CheckClient> = {}) {
  const calls: string[] = [];
  const client: CheckClient = {
    connect: async () => { calls.push('connect'); },
    query: async (text) => { calls.push(`query:${text}`); },
    end: async () => { calls.push('end'); },
    ...overrides,
  };
  return { client, calls, create: () => client };
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected assertDatabaseReachable to reject');
}

function expectFixedMessage(error: Error) {
  expect(error.message).toBe(DATABASE_CHECK_FAILED);
  expect(error.cause).toBeUndefined();
  const everything = [error.message, String(error.stack), JSON.stringify(error)].join('\n');
  for (const secret of SECRETS) expect(everything).not.toContain(secret);
}

describe('assertDatabaseReachable', () => {
  it('runs connect, then SELECT 1, then closes the client, and resolves', async () => {
    const { calls, create } = fake();
    await expect(assertDatabaseReachable(URL_WITH_SECRETS, { createClient: create })).resolves.toBeUndefined();
    expect(calls).toEqual(['connect', 'query:SELECT 1', 'end']);
  });

  it('hands the connection string and the 5 second limit to the client factory', async () => {
    const { client } = fake();
    const createClient = vi.fn(() => client);
    await assertDatabaseReachable(URL_WITH_SECRETS, { createClient });
    expect(createClient).toHaveBeenCalledWith(URL_WITH_SECRETS, DATABASE_CHECK_TIMEOUT_MS);
    expect(DATABASE_CHECK_TIMEOUT_MS).toBe(5000);
  });

  it('the fixed message names DATABASE_URL and holds no URL', () => {
    expect(DATABASE_CHECK_FAILED).toContain('DATABASE_URL');
    expect(DATABASE_CHECK_FAILED).not.toMatch(/postgres|:\/\/|@/i);
  });

  describe('a failure gives the fixed message and nothing else', () => {
    it('when connect fails with driver text that holds the username and password', async () => {
      const { calls, create } = fake({ connect: async () => { calls.push('connect'); throw new Error(DRIVER_TEXT); } });
      expectFixedMessage(await failure(assertDatabaseReachable(URL_WITH_SECRETS, { createClient: create })));
      expect(calls).toContain('end'); // the client is still closed
    });

    it('when the query fails', async () => {
      const { create } = fake({ query: async () => { throw new Error(DRIVER_TEXT); } });
      expectFixedMessage(await failure(assertDatabaseReachable(URL_WITH_SECRETS, { createClient: create })));
    });

    it('when the client factory itself throws', async () => {
      const createClient = () => { throw new Error(DRIVER_TEXT); };
      expectFixedMessage(await failure(assertDatabaseReachable(URL_WITH_SECRETS, { createClient })));
    });
  });

  describe('the timeout', () => {
    it('gives the fixed message when connect never finishes, and still closes the client', async () => {
      const { calls, create } = fake({ connect: () => new Promise(() => undefined) });
      const started = Date.now();
      const error = await failure(assertDatabaseReachable(URL_WITH_SECRETS, { timeoutMs: 50, createClient: create }));
      expectFixedMessage(error);
      expect(Date.now() - started).toBeGreaterThanOrEqual(45);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(calls).toContain('end');
    });

    it('a connect that FAILS after the timeout already fired leaves nothing unhandled, and the fixed message is still what was thrown', async () => {
      const unhandled: unknown[] = [];
      const listener = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', listener);
      try {
        const { create } = fake({
          connect: () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error(DRIVER_TEXT)), 120)),
        });
        const error = await failure(
          assertDatabaseReachable(URL_WITH_SECRETS, { timeoutMs: 30, cleanupMs: 20, createClient: create }),
        );
        expectFixedMessage(error);
        await sleep(300); // the late rejection arrives during this wait
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', listener);
      }
    });

    it('a connect that SUCCEEDS after the timeout fired is still a failure', async () => {
      const { create } = fake({ connect: () => sleep(100) });
      expectFixedMessage(
        await failure(assertDatabaseReachable(URL_WITH_SECRETS, { timeoutMs: 30, cleanupMs: 20, createClient: create })),
      );
    });
  });

  describe('closing the client never changes the result or blocks startup', () => {
    it('an end() that rejects does not turn a success into a failure', async () => {
      const { create } = fake({ end: async () => { throw new Error(DRIVER_TEXT); } });
      await expect(assertDatabaseReachable(URL_WITH_SECRETS, { createClient: create })).resolves.toBeUndefined();
    });

    it('an end() that rejects does not change the fixed failure message', async () => {
      const { create } = fake({
        connect: async () => { throw new Error(DRIVER_TEXT); },
        end: async () => { throw new Error(DRIVER_TEXT); },
      });
      expectFixedMessage(await failure(assertDatabaseReachable(URL_WITH_SECRETS, { createClient: create })));
    });

    it('an end() that never finishes is abandoned after the cleanup limit', async () => {
      const { create } = fake({ end: () => new Promise(() => undefined) });
      const started = Date.now();
      await assertDatabaseReachable(URL_WITH_SECRETS, { cleanupMs: 30, createClient: create });
      expect(Date.now() - started).toBeLessThan(1500);
    });
  });

  describe('the error it throws', () => {
    it('is a DatabaseCheckError that carries the fixed message and nothing else', async () => {
      const { create } = fake({ connect: async () => { throw new Error(DRIVER_TEXT); } });
      const error = await failure(assertDatabaseReachable(URL_WITH_SECRETS, { createClient: create }));
      expect(error).toBeInstanceOf(DatabaseCheckError);
      expect(error.name).toBe('DatabaseCheckError');
      expect(Object.getOwnPropertyNames(error).sort()).toEqual(['message', 'name', 'stack']);
    });
  });

  describe('the REAL pg.Client with a malformed connection string', () => {
    // These strings make the pg client CONSTRUCTOR throw (Node's URL parser throws "Invalid URL"
    // and attaches the raw input to the error). The precondition below proves that path is used.
    const MALFORMED = [
      'postgresql://[bad',
      'postgresql://SECRET-USER-xyz:SECRET-PASSWORD-xyz@h:notaport/SECRET-DB-xyz',
    ];

    it.each(MALFORMED)('precondition: the pg constructor really throws for %s', (input) => {
      expect(() => new pg.Client({ connectionString: input })).toThrow();
    });

    it.each(MALFORMED)('%s gives exactly the fixed message, with no cause and no input', async (input) => {
      const error = await failure(assertDatabaseReachable(input, { timeoutMs: 1000 }));
      expect(error).toBeInstanceOf(DatabaseCheckError);
      expect(error.message).toBe(DATABASE_CHECK_FAILED);
      expect(error.cause).toBeUndefined();
      expect('input' in error).toBe(false);
      expect(Object.getOwnPropertyNames(error).sort()).toEqual(['message', 'name', 'stack']);
      const everything = [error.message, String(error.stack), JSON.stringify(error)].join('\n');
      for (const part of ['[bad', 'SECRET-USER-xyz', 'SECRET-PASSWORD-xyz', 'SECRET-DB-xyz', 'notaport', 'Invalid URL']) {
        expect(everything).not.toContain(part);
      }
    });
  });

  // Not a database: nothing listens on port 1, so the real pg client is refused at once.
  // This proves the default client path really ends in the fixed message.
  it('the default pg client, refused by a closed local port, gives the fixed message', async () => {
    const error = await failure(assertDatabaseReachable('postgresql://user:pass@127.0.0.1:1/x', { timeoutMs: 3000 }));
    expect(error.message).toBe(DATABASE_CHECK_FAILED);
    expect(error.message).not.toContain('ECONNREFUSED');
    expect(error.message).not.toContain('127.0.0.1');
  });
});
