import { Global, Module } from '@nestjs/common';
import { RateLimiter } from './rate-limiter.js';

// One shared in-memory limiter for the whole app. Global, so a route that uses @RateLimit() in any
// module can resolve the guard's dependencies.
@Global()
@Module({
  providers: [{ provide: RateLimiter, useFactory: () => new RateLimiter() }],
  exports: [RateLimiter],
})
export class RateLimitModule {}
