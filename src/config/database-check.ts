import pg from 'pg';

export const DATABASE_CHECK_TIMEOUT_MS = 5000;
const CLEANUP_TIMEOUT_MS = 1000;

// A fixed message. It names DATABASE_URL and never prints its value or the driver's error text
// (the driver's text contains the username).
export const DATABASE_CHECK_FAILED =
  'Database check failed: could not run a test query using DATABASE_URL (the database is unreachable within 5 seconds, or it refused the connection). ' +
  'Check that the database is running and that the host, port, user, password and database name in DATABASE_URL are right.';

// The only error this check ever throws. It carries the fixed message and nothing else: no cause,
// no input, no driver text.
export class DatabaseCheckError extends Error {
  constructor() {
    super(DATABASE_CHECK_FAILED);
    this.name = 'DatabaseCheckError';
  }
}

export interface CheckClient {
  connect(): Promise<unknown>;
  query(text: string): Promise<unknown>;
  end(): Promise<unknown>;
}
export type CreateCheckClient = (connectionString: string, timeoutMs: number) => CheckClient;

const createPgClient: CreateCheckClient = (connectionString, timeoutMs) => {
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
  });
  client.on('error', () => undefined); // a late socket error must not become an uncaught exception
  return client;
};

function timer(ms: number) {
  let handle!: NodeJS.Timeout;
  const promise = new Promise<'timeout'>((resolve) => {
    handle = setTimeout(() => resolve('timeout'), ms);
  });
  return { promise, cancel: () => clearTimeout(handle) };
}

export async function assertDatabaseReachable(
  connectionString: string,
  options: { timeoutMs?: number; cleanupMs?: number; createClient?: CreateCheckClient } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DATABASE_CHECK_TIMEOUT_MS;
  const limit = timer(timeoutMs);
  let client: CheckClient | undefined;
  try {
    // Created INSIDE the try: the pg client constructor throws for a malformed connection string,
    // and that error carries the raw input.
    const created = (options.createClient ?? createPgClient)(connectionString, timeoutMs);
    client = created;
    const attempt = (async () => {
      await created.connect();
      await created.query('SELECT 1');
      return 'ok' as const;
    })();
    // A rejection that arrives AFTER the timeout has won must not become an unhandled rejection.
    attempt.catch(() => undefined);
    const outcome = await Promise.race([attempt, limit.promise]);
    if (outcome !== 'ok') throw new Error('timeout');
  } catch {
    throw new DatabaseCheckError(); // the original error is dropped on purpose (no cause)
  } finally {
    limit.cancel();
    if (client) {
      // Always close the check connection, but never let cleanup hang the startup.
      const open = client;
      const cleanup = timer(options.cleanupMs ?? CLEANUP_TIMEOUT_MS);
      await Promise.race([
        Promise.resolve()
          .then(() => open.end())
          .catch(() => undefined),
        cleanup.promise,
      ]);
      cleanup.cancel();
    }
  }
}
