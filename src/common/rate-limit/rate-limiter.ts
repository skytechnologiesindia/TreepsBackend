export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

export interface RateLimitEntry extends RateLimitRule {
  key: string;
}

export interface ConsumeResult {
  allowed: boolean;
  retryAfterMs: number;
}

interface Counter {
  count: number;
  resetAt: number;
}

// Expired counters are removed by a sweep that runs at most this often (no timer is used, so
// nothing keeps the process alive and tests need no real clock).
export const SWEEP_INTERVAL_MS = 60_000;

export function assertRateLimitRule(rule: RateLimitRule, what: string): void {
  if (
    !Number.isSafeInteger(rule.limit) ||
    rule.limit < 1 ||
    !Number.isSafeInteger(rule.windowMs) ||
    rule.windowMs < 1
  ) {
    throw new RangeError(`Invalid rate limit: ${what}`);
  }
}

// A fixed-window counter per key, kept in memory. A client can use up to twice the limit around a
// window edge. The counters live in one process: they reset on restart and are not shared between
// server instances (no Redis exists). `now` is injectable so tests do not sleep.
export class RateLimiter {
  private readonly counters = new Map<string, Counter>();
  private lastSweepAt: number;

  constructor(private readonly now: () => number = Date.now) {
    this.lastSweepAt = now();
  }

  get size(): number {
    return this.counters.size;
  }

  // Checks every entry first and counts only if all of them have room, so a request that is
  // blocked by one rule does not use up the other rules.
  consume(entries: readonly RateLimitEntry[]): ConsumeResult {
    const now = this.now();
    this.sweepIfDue(now);
    let retryAfterMs = 0;
    for (const entry of entries) {
      assertRateLimitRule(entry, entry.key);
      const counter = this.live(entry.key, now);
      if (counter && counter.count >= entry.limit) {
        retryAfterMs = Math.max(retryAfterMs, counter.resetAt - now);
      }
    }
    if (retryAfterMs > 0) return { allowed: false, retryAfterMs };
    for (const entry of entries) {
      const counter = this.live(entry.key, now);
      if (counter) counter.count += 1;
      else this.counters.set(entry.key, { count: 1, resetAt: now + entry.windowMs });
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  // Removes every expired counter and returns how many were removed.
  sweep(): number {
    const now = this.now();
    this.lastSweepAt = now;
    let removed = 0;
    for (const [key, counter] of this.counters) {
      if (counter.resetAt <= now) {
        this.counters.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  private sweepIfDue(now: number): void {
    if (now - this.lastSweepAt >= SWEEP_INTERVAL_MS) this.sweep();
  }

  private live(key: string, now: number): Counter | undefined {
    const counter = this.counters.get(key);
    if (!counter) return undefined;
    if (counter.resetAt <= now) {
      this.counters.delete(key);
      return undefined;
    }
    return counter;
  }
}
