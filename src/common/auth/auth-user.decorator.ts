import { createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { AuthClaims } from '../session/session.types.js';
import { AUTH_REQUEST_KEY, type AuthenticatedRequest } from './session-auth.guard.js';

// Hands a handler the caller the guard verified: { userId, role, deviceId }. In Express terms,
// `req.user`. Only valid on a route behind SessionAuthGuard.
export const AuthUser = createParamDecorator((_data: unknown, context: ExecutionContext): AuthClaims => {
  const claims = context.switchToHttp().getRequest<AuthenticatedRequest>()[AUTH_REQUEST_KEY];
  if (!claims) throw new Error('AuthUser used on a route without SessionAuthGuard');
  return claims;
});
