import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// Password hashing with scrypt, which is built into Node (no package). In Express terms, what
// bcrypt.hash and bcrypt.compare do. A stored hash reads "scrypt$N$salt$hash" (salt and hash in hex),
// so the cost can be raised later and old hashes still work.
const COST = 16384;
const KEY_BYTES = 64;
export const MIN_PASSWORD_LENGTH = 12;

function derive(password: string, salt: Buffer, cost: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_BYTES, { N: cost, r: 8, p: 1 }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, COST);
  return `scrypt$${COST}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, cost, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !cost || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = await derive(password, Buffer.from(salt, 'hex'), Number(cost));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Checked against when the email is unknown, so an unknown email takes as long as a wrong password.
let dummy: Promise<string> | undefined;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(16).toString('hex'));
  return dummy;
}
