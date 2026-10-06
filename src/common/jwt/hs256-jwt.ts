import { createHmac, timingSafeEqual } from 'node:crypto';

// A JWT is three base64url parts joined by dots: header, payload and an HMAC-SHA256 signature of
// the first two parts. This is the whole HS256 algorithm, so it is written here with Node's
// built-in crypto and no library (decision 133: HS256 only). In Express terms it is what
// jsonwebtoken's sign() and verify() do for HS256.
const HEADER = { alg: 'HS256', typ: 'JWT' };

export class JwtError extends Error {
  constructor(reason: string) {
    super(`Invalid token: ${reason}`); // never contains the token or the secret
    this.name = 'JwtError';
  }
}

const encode = (value: object | Buffer): string =>
  (Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value))).toString('base64url');

function signature(signingInput: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(signingInput).digest();
}

export function signHs256Jwt(payload: Record<string, unknown>, secret: string): string {
  const signingInput = `${encode(HEADER)}.${encode(payload)}`;
  return `${signingInput}.${encode(signature(signingInput, secret))}`;
}

// Accepts only HS256 (never "none" or another algorithm), checks the signature in constant time
// and rejects an expired token. `nowSeconds` is passed in so tests do not depend on the clock.
export function verifyHs256Jwt(token: string, secret: string, nowSeconds: number): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('wrong number of parts');
  const [header, payload, sig] = parts;

  let parsedHeader: unknown;
  try {
    parsedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
  } catch {
    throw new JwtError('unreadable header');
  }
  if (typeof parsedHeader !== 'object' || parsedHeader === null || (parsedHeader as { alg?: unknown }).alg !== 'HS256') {
    throw new JwtError('algorithm is not HS256');
  }

  const expected = signature(`${header}.${payload}`, secret);
  const actual = Buffer.from(sig, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new JwtError('bad signature');
  }

  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new JwtError('unreadable payload');
  }
  if (typeof parsedPayload !== 'object' || parsedPayload === null || Array.isArray(parsedPayload)) {
    throw new JwtError('payload is not an object');
  }
  const { exp } = parsedPayload as { exp?: unknown };
  if (typeof exp !== 'number' || exp <= nowSeconds) throw new JwtError('expired');
  return parsedPayload as Record<string, unknown>;
}
