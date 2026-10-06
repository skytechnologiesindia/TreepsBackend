import { createHash, randomBytes } from 'node:crypto';

// An opaque token is 32 random bytes from the operating system, shown to the app once as 43
// base64url characters. Only its SHA-256 hash is stored, so a copy of the database cannot be used
// to log in. A plain SHA-256 is enough because the token is long and random (not a password).
export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
