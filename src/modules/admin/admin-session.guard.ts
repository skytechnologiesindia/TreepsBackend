import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import { AppException } from '../../common/errors/app.exception.js';
import { SessionService } from '../../common/session/session.service.js';
import { CLOCK, type Clock } from '../../common/clock.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AdminSessionService } from './admin-session.service.js';

export const ADMIN_REQUEST_KEY = 'admin';
export interface AdminClaims {
  adminId: string;
}
type AdminRequest = Request & { [ADMIN_REQUEST_KEY]?: AdminClaims };

// The admin routes' guard (in Express terms, a middleware that checks the admin token). No token or an
// unknown token is UNAUTHORIZED. A good rider or driver token is FORBIDDEN: it is a real login, just
// not an admin one. An admin who is switched off loses the session at once.
@Injectable()
export class AdminSessionGuard implements CanActivate {
  constructor(
    private readonly adminSessions: AdminSessionService,
    private readonly appSessions: SessionService,
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    const match = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? '');
    if (!match) throw new AppException('UNAUTHORIZED');

    const session = await this.adminSessions.findByToken(match[1]);
    if (!session) {
      const other = await this.appSessions.findByToken(match[1], this.clock());
      throw new AppException(other ? 'FORBIDDEN' : 'UNAUTHORIZED');
    }
    const admin = await this.prisma.admin.findUnique({ where: { id: session.adminId }, select: { isActive: true } });
    if (!admin || !admin.isActive) {
      await this.adminSessions.deleteAll(session.adminId);
      throw new AppException('UNAUTHORIZED');
    }
    await this.adminSessions.touch(session);
    request[ADMIN_REQUEST_KEY] = { adminId: session.adminId };
    return true;
  }
}

// Hands a handler the admin the guard verified. In Express terms, `req.admin`.
export const AdminUser = createParamDecorator((_data: unknown, context: ExecutionContext): AdminClaims => {
  const claims = context.switchToHttp().getRequest<AdminRequest>()[ADMIN_REQUEST_KEY];
  if (!claims) throw new Error('AdminUser used on a route without AdminSessionGuard');
  return claims;
});
