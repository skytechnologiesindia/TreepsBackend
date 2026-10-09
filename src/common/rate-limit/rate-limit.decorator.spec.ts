import { RateLimit } from './rate-limit.decorator.js';
import { RATE_LIMITS } from '../../config/rate-limits.js';

describe('@RateLimit options', () => {
  it('accepts an ip rule, a phone rule, or both', () => {
    expect(() => RateLimit({ name: 'a', ip: { limit: 1, windowMs: 1000 } })).not.toThrow();
    expect(() => RateLimit({ name: 'a', phone: { limit: 1, windowMs: 1000 } })).not.toThrow();
    expect(() => RateLimit({ name: 'a', ip: { limit: 1, windowMs: 1000 }, phone: { limit: 2, windowMs: 1000 } })).not.toThrow();
  });

  it('stops at definition time when the name is empty, there is no rule, or a rule is broken', () => {
    expect(() => RateLimit({ name: '', ip: { limit: 1, windowMs: 1000 } })).toThrow(RangeError);
    expect(() => RateLimit({ name: 'a' })).toThrow(RangeError);
    expect(() => RateLimit({ name: 'a', ip: { limit: 0, windowMs: 1000 } })).toThrow(RangeError);
    expect(() => RateLimit({ name: 'a', phone: { limit: 1, windowMs: 0 } })).toThrow(RangeError);
  });
});

describe('RATE_LIMITS (the numbers of the approved docs)', () => {
  const HOUR = 3_600_000;
  it('matches rider-send-otp, verify-otp, register, refresh and logout', () => {
    expect(RATE_LIMITS.sendOtp.ip).toEqual({ limit: 20, windowMs: HOUR });
    expect(RATE_LIMITS.sendOtp.phone).toEqual({ limit: 5, windowMs: HOUR });
    expect(RATE_LIMITS.sendOtp.resendCooldownMs).toBe(30_000);
    expect(RATE_LIMITS.verifyOtp.phone).toEqual({ limit: 10, windowMs: HOUR });
    expect(RATE_LIMITS.register.ip).toEqual({ limit: 10, windowMs: HOUR });
    expect(RATE_LIMITS.logout.ip).toEqual({ limit: 120, windowMs: HOUR });
    expect('ip' in RATE_LIMITS.verifyOtp).toBe(false); // no per-IP limit on verify-otp in the MVP
  });

  it('every number is accepted by the decorator', () => {
    for (const rule of [RATE_LIMITS.sendOtp.ip, RATE_LIMITS.sendOtp.phone, RATE_LIMITS.verifyOtp.phone, RATE_LIMITS.register.ip, RATE_LIMITS.logout.ip]) {
      expect(() => RateLimit({ name: 'x', ip: rule })).not.toThrow();
    }
  });
});
