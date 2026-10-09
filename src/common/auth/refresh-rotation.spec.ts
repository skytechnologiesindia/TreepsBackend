import { classifyRefreshToken } from './refresh-rotation.js';

const NOW = new Date('2026-10-09T10:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const future = new Date(NOW.getTime() + 86_400_000);

describe('classifyRefreshToken', () => {
  it('a fresh token is USABLE', () => expect(classifyRefreshToken({ expiresAt: future, revokedAt: null }, NOW)).toBe('USABLE'));
  it('an expired token is EXPIRED, also at the exact expiry instant', () => {
    expect(classifyRefreshToken({ expiresAt: ago(1), revokedAt: null }, NOW)).toBe('EXPIRED');
    expect(classifyRefreshToken({ expiresAt: NOW, revokedAt: null }, NOW)).toBe('EXPIRED');
  });
  it('rotated 1 s and exactly 10 s ago is ROTATED_RECENTLY', () => {
    expect(classifyRefreshToken({ expiresAt: future, revokedAt: ago(1000) }, NOW)).toBe('ROTATED_RECENTLY');
    expect(classifyRefreshToken({ expiresAt: future, revokedAt: ago(10_000) }, NOW)).toBe('ROTATED_RECENTLY');
  });
  it('rotated more than 10 s ago is REUSED', () => {
    expect(classifyRefreshToken({ expiresAt: future, revokedAt: ago(10_001) }, NOW)).toBe('REUSED');
  });
  it('a rotated token that has also expired is still judged by when it was rotated', () => {
    expect(classifyRefreshToken({ expiresAt: ago(5000), revokedAt: ago(60_000) }, NOW)).toBe('REUSED');
  });
});
