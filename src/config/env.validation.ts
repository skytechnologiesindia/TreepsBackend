import type { ReasonCode } from '../common/validation/validation-reasons.js';

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];
export const DEFAULT_PORT = 3000;

export const OTP_PROVIDERS = ['twofactor', 'fake'] as const;
export type OtpProviderName = (typeof OTP_PROVIDERS)[number];
export const DEFAULT_TRUST_PROXY_HOPS = 0;
export const MAX_TRUST_PROXY_HOPS = 10;

export interface ValidatedEnv {
  DATABASE_URL: string;
  PORT: number;
  NODE_ENV: NodeEnv;
  OTP_PROVIDER: OtpProviderName;
  ALLOW_FAKE_OTP?: string; // only read, and only required, when OTP_PROVIDER is fake
  FAKE_OTP_CODE?: string; // only when OTP_PROVIDER is fake
  TWOFACTOR_API_KEY?: string; // only when OTP_PROVIDER is twofactor
  TWOFACTOR_TEMPLATE?: string; // only when OTP_PROVIDER is twofactor; optional, default OTP1
  TRUST_PROXY_HOPS: number;
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

const isMissing = (raw: unknown): boolean => raw === undefined || raw === null || raw === '';

// The fake provider accepts one known code, so it must be impossible to enable by accident:
// it needs two deliberate settings (this key and ALLOW_FAKE_OTP) and is refused in production.
function checkOtpProvider(raw: unknown, nodeEnv: unknown): ReasonCode | undefined {
  if (isMissing(raw)) return 'REQUIRED';
  if (typeof raw !== 'string' || !(OTP_PROVIDERS as readonly string[]).includes(raw)) {
    return 'NOT_ALLOWED';
  }
  return raw === 'fake' && nodeEnv === 'production' ? 'NOT_ALLOWED' : undefined;
}

function checkAllowFakeOtp(raw: unknown): ReasonCode | undefined {
  if (isMissing(raw)) return 'REQUIRED';
  return raw === 'true' ? undefined : 'NOT_ALLOWED';
}

function checkFakeOtpCode(raw: unknown): ReasonCode | undefined {
  if (isMissing(raw)) return 'REQUIRED';
  return typeof raw === 'string' && /^[0-9]{6}$/.test(raw) ? undefined : 'INVALID_FORMAT';
}

function checkTwoFactorApiKey(raw: unknown): ReasonCode | undefined {
  if (isMissing(raw)) return 'REQUIRED';
  if (typeof raw !== 'string' || raw !== raw.trim() || hasControlCharacter(raw)) {
    return 'INVALID_FORMAT';
  }
  return undefined;
}

// Optional. The name of an SMS template made in the 2Factor dashboard; it goes into the URL path.
function checkTwoFactorTemplate(raw: unknown): ReasonCode | undefined {
  if (raw === undefined) return undefined;
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{1,50}$/.test(raw) ? undefined : 'INVALID_FORMAT';
}

function checkTrustProxyHops(raw: unknown): { hops?: number; reason?: ReasonCode } {
  if (raw === undefined) return { hops: DEFAULT_TRUST_PROXY_HOPS };
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw)) {
    return { reason: 'INVALID_FORMAT' };
  }
  const hops = Number(raw); // the one explicit conversion
  return hops <= MAX_TRUST_PROXY_HOPS ? { hops } : { reason: 'OUT_OF_RANGE' };
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

  const otpProvider = checkOtpProvider(config.OTP_PROVIDER, config.NODE_ENV);
  if (otpProvider) problems.push({ variable: 'OTP_PROVIDER', reason: otpProvider });
  // A provider-specific key is checked only for the provider that is selected. For any other
  // provider (or none) it is not read at all.
  if (config.OTP_PROVIDER === 'fake') {
    const allowFake = checkAllowFakeOtp(config.ALLOW_FAKE_OTP);
    if (allowFake) problems.push({ variable: 'ALLOW_FAKE_OTP', reason: allowFake });
    const fakeCode = checkFakeOtpCode(config.FAKE_OTP_CODE);
    if (fakeCode) problems.push({ variable: 'FAKE_OTP_CODE', reason: fakeCode });
  }
  if (config.OTP_PROVIDER === 'twofactor') {
    const apiKey = checkTwoFactorApiKey(config.TWOFACTOR_API_KEY);
    if (apiKey) problems.push({ variable: 'TWOFACTOR_API_KEY', reason: apiKey });
    const template = checkTwoFactorTemplate(config.TWOFACTOR_TEMPLATE);
    if (template) problems.push({ variable: 'TWOFACTOR_TEMPLATE', reason: template });
  }

  const hops = checkTrustProxyHops(config.TRUST_PROXY_HOPS);
  if (hops.reason) problems.push({ variable: 'TRUST_PROXY_HOPS', reason: hops.reason });
  if (problems.length > 0) throw new EnvConfigError(problems);

  return {
    ...config, // keep every other variable available
    DATABASE_URL: config.DATABASE_URL as string,
    PORT: port.port as number,
    NODE_ENV: config.NODE_ENV as NodeEnv,
    OTP_PROVIDER: config.OTP_PROVIDER as OtpProviderName,
    TRUST_PROXY_HOPS: hops.hops as number,
  };
}
