import type { RateLimitRule } from './rate-limiter.js';

export const RATE_LIMIT_METADATA = 'treeps:rateLimit';

export interface RateLimitOptions {
  // Names the counters. Two routes with the same name share their counters.
  name: string;
  ip?: RateLimitRule;
  phone?: RateLimitRule;
}
