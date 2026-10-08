import { createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { AccessTokenClaims } from '../jwt/access-token.service.js';
import { AUTH_REQUEST_KEY, type AuthenticatedRequest } from './jwt-auth.guard.js';

// Hands a handler the claims JwtAuthGuard verified: { userId, role, deviceId }. In Express terms,
// `req.user`. Only valid on a route behind JwtAuthGuard.
export const AuthUser = createParamDecorator((_data: unknown, context: ExecutionContext): AccessTokenClaims => {
  const claims = context.switchToHttp().getRequest<AuthenticatedRequest>()[AUTH_REQUEST_KEY];
  if (!claims) throw new Error('AuthUser used on a route without JwtAuthGuard');
  return claims;
});
