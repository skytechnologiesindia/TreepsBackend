import { dummyHash, hashPassword, verifyPassword } from './password.js';

describe('admin password hashing', () => {
  it('accepts the right password and refuses a wrong one', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('correct horse batterz', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('never stores the password, and two hashes of one password differ (random salt)', async () => {
    const a = await hashPassword('same password 123');
    const b = await hashPassword('same password 123');
    expect(a).not.toContain('same password 123');
    expect(a).not.toBe(b);
    expect(a.startsWith('scrypt$')).toBe(true);
  });

  it('refuses a stored value that is not a scrypt hash, without throwing', async () => {
    for (const stored of ['', 'plain', 'bcrypt$1$aa$bb', 'scrypt$16384$only-salt']) {
      expect(await verifyPassword('anything', stored)).toBe(false);
    }
  });

  it('gives a dummy hash that no real password matches', async () => {
    expect(await verifyPassword('anything at all', await dummyHash())).toBe(false);
  });
});
