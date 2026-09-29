import type { ReasonCode } from '../common/validation/validation-reasons.js';

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];
export const DEFAULT_PORT = 3000;

export interface ValidatedEnv {
  DATABASE_URL: string;
  PORT: number;
  NODE_ENV: NodeEnv;
}

export interface EnvProblem {
  variable: keyof ValidatedEnv;
  reason: ReasonCode;
}

// The message names each bad variable and its reason code. It never contains a value, and the
// error keeps only variable names and reason codes: not the raw configuration.
export class EnvConfigError extends Error {
  constructor(readonly problems: readonly EnvProblem[]) {
    super(
      `Invalid environment configuration: ${problems
        .map((p) => `${p.variable} (${p.reason})`)
        .join(', ')}. See docs/standards/input-validation.md section 6 and .env.example.`,
    );
    this.name = 'EnvConfigError';
  }
}

// Only the two schemes with "//" count as a database URL. Node's URL parser also accepts
// "postgresql:" and "postgresql:host/db" (empty host), which are not database URLs.
const DATABASE_URL_PREFIX = /^postgres(?:ql)?:\/\//i;

function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 0x20) return true; // newline, NUL, tab, ...
  }
  return false;
}

function checkDatabaseUrl(raw: unknown): ReasonCode | undefined {
  if (raw === undefined || raw === null || raw === '') return 'REQUIRED';
  if (typeof raw !== 'string' || raw !== raw.trim() || hasControlCharacter(raw)) {
    return 'INVALID_FORMAT';
  }
  if (!DATABASE_URL_PREFIX.test(raw)) return 'INVALID_FORMAT';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'INVALID_FORMAT';
  }
  return url.protocol === 'postgresql:' || url.protocol === 'postgres:'
    ? undefined
    : 'INVALID_FORMAT';
}

function checkPort(raw: unknown): { port?: number; reason?: ReasonCode } {
  if (raw === undefined) return { port: DEFAULT_PORT };
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw)) {
    return { reason: 'INVALID_FORMAT' };
  }
  const port = Number(raw); // the one explicit conversion
  return port >= 1 && port <= 65535 ? { port } : { reason: 'OUT_OF_RANGE' };
}

function checkNodeEnv(raw: unknown): ReasonCode | undefined {
  if (raw === undefined || raw === null || raw === '') return 'REQUIRED';
  return typeof raw === 'string' && (NODE_ENVS as readonly string[]).includes(raw)
    ? undefined
    : 'NOT_ALLOWED';
}

export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> & ValidatedEnv {
  const problems: EnvProblem[] = [];
  const databaseUrl = checkDatabaseUrl(config.DATABASE_URL);
  if (databaseUrl) problems.push({ variable: 'DATABASE_URL', reason: databaseUrl });
  const port = checkPort(config.PORT);
  if (port.reason) problems.push({ variable: 'PORT', reason: port.reason });
  const nodeEnv = checkNodeEnv(config.NODE_ENV);
  if (nodeEnv) problems.push({ variable: 'NODE_ENV', reason: nodeEnv });
  if (problems.length > 0) throw new EnvConfigError(problems);

  return {
    ...config, // keep every other variable available
    DATABASE_URL: config.DATABASE_URL as string,
    PORT: port.port as number,
    NODE_ENV: config.NODE_ENV as NodeEnv,
  };
}
