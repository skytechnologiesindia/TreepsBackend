import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { ValidatedEnv } from '../../config/env.validation.js';
import { AppException } from '../errors/app.exception.js';
import { INDIAN_MOBILE_PATTERN } from '../validation/fields.js';
import { clientIp } from './client-ip.js';
import { RATE_LIMIT_METADATA, type RateLimitOptions } from './rate-limit.options.js';
import { RateLimiter, type RateLimitEntry } from './rate-limiter.js';

// A Nest guard is like Express middleware that runs before the handler and can refuse.
// Guards run BEFORE the validation pipe, so the body here is not validated yet. The phone is
// used only if it is a string in the exact IndianMobile shape; anything else is skipped for the
// per-phone counter and the pipe then rejects the request as INVALID_INPUT.
function phoneOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as { phoneNumber?: unknown }).phoneNumber;
  return typeof value === 'string' && INDIAN_MOBILE_PATTERN.test(value) ? value : undefined;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService<ValidatedEnv, true>,
    private readonly limiter: RateLimiter,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const options = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(
      RATE_LIMIT_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (!options) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const entries: RateLimitEntry[] = [];
    if (options.ip) {
      const hops = this.config.get('TRUST_PROXY_HOPS', { infer: true });
      const ip = clientIp(request.socket?.remoteAddress, request.headers['x-forwarded-for'], hops);
      entries.push({ key: `${options.name}|ip|${ip}`, ...options.ip });
    }
    if (options.phone) {
      const phone = phoneOf(request.body);
      if (phone) entries.push({ key: `${options.name}|phone|${phone}`, ...options.phone });
    }

    // The standard RATE_LIMITED reply comes from the error registry and the global filter.
    // No Retry-After header: the docs do not say to send one (TO DECIDE).
    if (!this.limiter.consume(entries).allowed) throw new AppException('RATE_LIMITED');
    return true;
  }
}
