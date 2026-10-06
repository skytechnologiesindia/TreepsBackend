import { createHmac } from 'node:crypto';
import { JwtError, signHs256Jwt, verifyHs256Jwt } from './hs256-jwt.js';

// The well-known HS256 example from jwt.io, so the signer is checked against an outside reference.
const EXAMPLE_SECRET = 'your-256-bit-secret';
const EXAMPLE_PAYLOAD = { sub: '1234567890', name: 'John Doe', iat: 1516239022 };
const EXAMPLE_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

const SECRET = 'placeholder-jwt-secret-0123456789abcdef';
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('signHs256Jwt', () => {
  it('produces the reference token for the jwt.io example', () => {
    expect(signHs256Jwt(EXAMPLE_PAYLOAD, EXAMPLE_SECRET)).toBe(EXAMPLE_TOKEN);
  });

  it('has three base64url parts and an HS256 header', () => {
    const token = signHs256Jwt({ sub: 'x', exp: 2_000_000_000 }, SECRET);
    const [header] = token.split('.');
    expect(token.split('.')).toHaveLength(3);
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });
});

describe('verifyHs256Jwt', () => {
  const payload = { iss: 'treeps', sub: 'rider-1', role: 'RIDER', deviceId: 'd1', iat: 1000, exp: 2000 };
  const token = signHs256Jwt(payload, SECRET);

  it('returns the payload of a good token', () => {
    expect(verifyHs256Jwt(token, SECRET, 1500)).toEqual(payload);
  });

  it('rejects an expired token (exp is exclusive)', () => {
    expect(() => verifyHs256Jwt(token, SECRET, 2000)).toThrow(/expired/);
    expect(() => verifyHs256Jwt(token, SECRET, 5000)).toThrow(JwtError);
  });

  it('rejects a wrong secret', () => {
    expect(() => verifyHs256Jwt(token, 'another-secret-another-secret-123456', 1500)).toThrow(/bad signature/);
  });

  it('rejects a changed payload with the old signature', () => {
    const [h, , s] = token.split('.');
    const forged = `${h}.${b64({ ...payload, role: 'ADMIN' })}.${s}`;
    expect(() => verifyHs256Jwt(forged, SECRET, 1500)).toThrow(/bad signature/);
  });

  it('rejects alg "none" and any algorithm other than HS256, even with a valid HMAC', () => {
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.`;
    expect(() => verifyHs256Jwt(none, SECRET, 1500)).toThrow(/not HS256/);
    const hs512Header = b64({ alg: 'HS512', typ: 'JWT' });
    const input = `${hs512Header}.${b64(payload)}`;
    const sig = createHmac('sha256', SECRET).update(input).digest('base64url');
    expect(() => verifyHs256Jwt(`${input}.${sig}`, SECRET, 1500)).toThrow(/not HS256/);
  });

  it.each([[''], ['a.b'], ['a.b.c.d'], ['not a token']])('rejects the malformed token %j', (bad) => {
    expect(() => verifyHs256Jwt(bad, SECRET, 1500)).toThrow(JwtError);
  });

  it('rejects a token with no exp', () => {
    expect(() => verifyHs256Jwt(signHs256Jwt({ sub: 'x' }, SECRET), SECRET, 1500)).toThrow(/expired/);
  });

  it('never puts the token or the secret in the error message', () => {
    try {
      verifyHs256Jwt(token, 'wrong-secret-wrong-secret-wrong-secret', 1500);
    } catch (error) {
      expect((error as Error).message).not.toContain(token);
      expect((error as Error).message).not.toContain('wrong-secret');
    }
  });
});
