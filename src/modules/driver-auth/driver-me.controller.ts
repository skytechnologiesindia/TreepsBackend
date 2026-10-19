import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthUser } from '../../common/auth/auth-user.decorator.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { RateLimit } from '../../common/rate-limit/rate-limit.decorator.js';
import type { AuthClaims } from '../../common/session/session.types.js';
import { RATE_LIMITS } from '../../config/rate-limits.js';
import { DriverMeService } from './driver-me.service.js';

// Protected route (driver session). The /v1 prefix is added by setupApp (docs/api/driver/driver-me.md).
@Controller('driver')
export class DriverMeController {
  constructor(private readonly service: DriverMeService) {}

  @RateLimit({ name: 'driver-me', ip: RATE_LIMITS.driverMe.ip })
  @UseGuards(SessionAuthGuard)
  @Get('me')
  me(@AuthUser() user: AuthClaims) {
    return this.service.me(user.userId);
  }
}
