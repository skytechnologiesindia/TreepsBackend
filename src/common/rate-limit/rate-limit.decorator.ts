import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { RATE_LIMIT_METADATA, type RateLimitOptions } from './rate-limit.options.js';
import { RateLimitGuard } from './rate-limit.guard.js';
import { assertRateLimitRule } from './rate-limiter.js';

// Each route declares its own limits, for example:
//   @RateLimit({ name: 'register', ...RATE_LIMITS.register })
// It also attaches the guard, so no global guard registration is needed. A broken option stops
// the server when the class is loaded, not during a request.
export function RateLimit(options: RateLimitOptions): MethodDecorator & ClassDecorator {
  if (!options.name) throw new RangeError('Invalid rate limit: name is empty');
  if (!options.ip && !options.phone) {
    throw new RangeError(`Invalid rate limit: ${options.name} has no rule`);
  }
  if (options.ip) assertRateLimitRule(options.ip, `${options.name} ip`);
  if (options.phone) assertRateLimitRule(options.phone, `${options.name} phone`);
  return applyDecorators(SetMetadata(RATE_LIMIT_METADATA, options), UseGuards(RateLimitGuard));
}
