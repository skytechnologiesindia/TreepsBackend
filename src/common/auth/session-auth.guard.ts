import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { DRIVER_ROLE, RIDER_ROLE } from '../../config/tokens.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CLOCK, type Clock } from '../clock.js';
import { AppException } from '../errors/app.exception.js';
import { SessionService } from '../session/session.service.js';
import type { AuthClaims, Session } from '../session/session.types.js';

// Where the guard leaves the caller (read it with @AuthUser()).
export const AUTH_REQUEST_KEY = 'auth';
export type AuthenticatedRequest = Request & { [AUTH_REQUEST_KEY]?: AuthClaims };

const BANNED = new Set(['SUSPENDED', 'BLOCKED', 'DELETED']);

// /v1/rider/* needs a RIDER session and /v1/driver/* needs a DRIVER session. A path in neither
// domain only needs a valid session.
function roleForPath(path: string): AuthClaims['role'] | undefined {
  if (path === '/v1/rider' || path.startsWith('/v1/rider/')) return RIDER_ROLE;
  if (path === '/v1/driver' || path.startsWith('/v1/driver/')) return DRIVER_ROLE;
  return undefined;
}

// A Nest guard is like Express middleware that runs before the handler and can refuse: here, the
// equivalent of an express-session check plus a role check (decision 176). Every failure to prove who
// the caller is gives the same UNAUTHORIZED, so a reply never says whether the token was missing,
// unknown or expired. A good session for the wrong domain is FORBIDDEN. A banned account loses all its
// sessions on the spot, which is what makes a ban take effect at once.
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const match = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? '');
    if (!match) throw new AppException('UNAUTHORIZED');

    const now = this.clock();
    const session = await this.sessions.findByToken(match[1], now);
    if (!session) throw new AppException('UNAUTHORIZED');

    const required = roleForPath(request.path);
    if (required !== undefined && session.role !== required) throw new AppException('FORBIDDEN');

    const status = await this.accountStatus(session);
    if (status === null) {
      await this.sessions.deleteAllForAccount(session.role, session.accountId); // the account is gone
      throw new AppException('UNAUTHORIZED');
    }
    if (BANNED.has(status)) {
      await this.sessions.deleteAllForAccount(session.role, session.accountId);
      throw new AppException('ACCOUNT_BANNED');
    }

    await this.sessions.touch(session, now);
    request[AUTH_REQUEST_KEY] = { userId: session.accountId, role: session.role, deviceId: session.deviceId };
    return true;
  }

  // null when the account no longer exists.
  private async accountStatus(session: Session): Promise<string | null> {
    const account =
      session.role === RIDER_ROLE
        ? await this.prisma.rider.findUnique({ where: { id: session.accountId }, select: { status: true } })
        : await this.prisma.driver.findUnique({ where: { id: session.accountId }, select: { status: true } });
    return account ? account.status : null;
  }
}
