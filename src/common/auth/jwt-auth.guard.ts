import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { DRIVER_ROLE, RIDER_ROLE } from '../../config/tokens.js';
import { CLOCK, type Clock } from '../clock.js';
import { AppException } from '../errors/app.exception.js';
import { AccessTokenService, type AccessTokenClaims } from '../jwt/access-token.service.js';
import { JwtError } from '../jwt/hs256-jwt.js';

// Where the guard leaves the verified claims (read them with @AuthUser()).
export const AUTH_REQUEST_KEY = 'auth';
export type AuthenticatedRequest = Request & { [AUTH_REQUEST_KEY]?: AccessTokenClaims };

// /v1/rider/* needs a RIDER token and /v1/driver/* needs a DRIVER token. A path in neither domain
// only needs a valid token.
function roleForPath(path: string): AccessTokenClaims['role'] | undefined {
  if (path === '/v1/rider' || path.startsWith('/v1/rider/')) return RIDER_ROLE;
  if (path === '/v1/driver' || path.startsWith('/v1/driver/')) return DRIVER_ROLE;
  return undefined;
}

// A Nest guard is like Express middleware that runs before the handler and can refuse: here, the
// equivalent of express-jwt plus a role check. Every failure to prove who the caller is gives the
// same UNAUTHORIZED, so a reply never says whether the token was missing, malformed, expired or
// signed with another key. A good token for the wrong domain is FORBIDDEN.
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly accessTokens: AccessTokenService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const match = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? '');
    if (!match) throw new AppException('UNAUTHORIZED');

    let claims: AccessTokenClaims;
    try {
      claims = this.accessTokens.verify(match[1], this.clock());
    } catch (error) {
      if (error instanceof JwtError) throw new AppException('UNAUTHORIZED');
      throw error;
    }

    const required = roleForPath(request.path);
    if (required !== undefined && claims.role !== required) throw new AppException('FORBIDDEN');

    request[AUTH_REQUEST_KEY] = claims;
    return true;
  }
}
