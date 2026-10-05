import { RateLimiter, SWEEP_INTERVAL_MS, type RateLimitEntry } from './rate-limiter.js';

const MINUTE = 60_000;

function setup() {
  let now = 1_000_000;
  const limiter = new RateLimiter(() => now);
  return {
    limiter,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const entry = (key: string, limit = 3, windowMs = MINUTE): RateLimitEntry => ({ key, limit, windowMs });

describe('RateLimiter', () => {
  it('lets requests through while under the limit', () => {
    const { limiter } = setup();
    for (let i = 0; i < 3; i++) expect(limiter.consume([entry('a')])).toEqual({ allowed: true, retryAfterMs: 0 });
  });

  it('blocks the request after the limit, and says how long until the window ends', () => {
    const { limiter, advance } = setup();
    for (let i = 0; i < 3; i++) limiter.consume([entry('a')]);
    advance(10_000);
    expect(limiter.consume([entry('a')])).toEqual({ allowed: false, retryAfterMs: MINUTE - 10_000 });
  });

  it('does not count a blocked request, so the window still ends on time', () => {
    const { limiter, advance } = setup();
    for (let i = 0; i < 3; i++) limiter.consume([entry('a')]);
    for (let i = 0; i < 50; i++) limiter.consume([entry('a')]);
    advance(MINUTE);
    expect(limiter.consume([entry('a')]).allowed).toBe(true);
  });

  it('starts a fresh window after the old one ends, without sleeping', () => {
    const { limiter, advance } = setup();
    for (let i = 0; i < 3; i++) limiter.consume([entry('a')]);
    expect(limiter.consume([entry('a')]).allowed).toBe(false);
    advance(MINUTE - 1);
    expect(limiter.consume([entry('a')]).allowed).toBe(false);
    advance(1);
    for (let i = 0; i < 3; i++) expect(limiter.consume([entry('a')]).allowed).toBe(true);
    expect(limiter.consume([entry('a')]).allowed).toBe(false);
  });

  it('keeps separate keys apart', () => {
    const { limiter } = setup();
    for (let i = 0; i < 3; i++) limiter.consume([entry('a')]);
    expect(limiter.consume([entry('a')]).allowed).toBe(false);
    expect(limiter.consume([entry('b')]).allowed).toBe(true);
    expect(limiter.consume([entry('a|ip|1')]).allowed).toBe(true);
  });

  it('each entry has its own limit and window', () => {
    const { limiter, advance } = setup();
    limiter.consume([entry('short', 1, 1000)]);
    expect(limiter.consume([entry('short', 1, 1000)]).allowed).toBe(false);
    advance(1000);
    expect(limiter.consume([entry('short', 1, 1000)]).allowed).toBe(true);
  });

  it('with several entries, one full entry blocks the request and none of the others is counted', () => {
    const { limiter } = setup();
    limiter.consume([entry('phone', 1)]);
    // 'ip' has room but 'phone' is full: blocked, and 'ip' must not be used up
    expect(limiter.consume([entry('ip', 2), entry('phone', 1)]).allowed).toBe(false);
    expect(limiter.consume([entry('ip', 2)]).allowed).toBe(true);
    expect(limiter.consume([entry('ip', 2)]).allowed).toBe(true);
    expect(limiter.consume([entry('ip', 2)]).allowed).toBe(false);
  });

  it('reports the longest wait when several entries are full', () => {
    const { limiter } = setup();
    limiter.consume([entry('x', 1, 1000), entry('y', 1, 5000)]);
    expect(limiter.consume([entry('x', 1, 1000), entry('y', 1, 5000)])).toEqual({ allowed: false, retryAfterMs: 5000 });
  });

  it('an empty list of entries is always allowed', () => {
    expect(setup().limiter.consume([])).toEqual({ allowed: true, retryAfterMs: 0 });
  });

  it.each([[0, MINUTE], [-1, MINUTE], [1.5, MINUTE], [3, 0], [3, -5], [3, 0.5], [NaN, MINUTE]])(
    'refuses a broken rule (limit %j, window %j)',
    (limit, windowMs) => {
      expect(() => setup().limiter.consume([{ key: 'a', limit, windowMs }])).toThrow(RangeError);
    },
  );

  describe('cleanup', () => {
    it('sweep removes expired counters and keeps live ones', () => {
      const { limiter, advance } = setup();
      limiter.consume([entry('old', 3, 1000), entry('live', 3, 10 * MINUTE)]);
      expect(limiter.size).toBe(2);
      advance(2000);
      expect(limiter.sweep()).toBe(1);
      expect(limiter.size).toBe(1);
    });

    it('sweeps by itself when a request comes after the sweep interval, so the map cannot grow forever', () => {
      const { limiter, advance } = setup();
      for (let i = 0; i < 1000; i++) limiter.consume([entry(`ip-${i}`, 3, MINUTE)]);
      expect(limiter.size).toBe(1000);
      advance(SWEEP_INTERVAL_MS + MINUTE);
      limiter.consume([entry('fresh')]);
      expect(limiter.size).toBe(1); // only the fresh key is left
    });

    it('does not sweep before the interval has passed', () => {
      const { limiter, advance } = setup();
      limiter.consume([entry('a', 3, 1000)]);
      advance(2000); // expired, but the sweep is not due
      limiter.consume([entry('b')]);
      expect(limiter.size).toBe(2);
    });

    it('an expired counter is replaced by a new one even before any sweep', () => {
      const { limiter, advance } = setup();
      limiter.consume([entry('a', 1, 1000)]);
      advance(1000);
      expect(limiter.consume([entry('a', 1, 1000)]).allowed).toBe(true);
      expect(limiter.size).toBe(1);
    });
  });
});
