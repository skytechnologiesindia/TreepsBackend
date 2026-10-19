import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { RateLimit } from '../../common/rate-limit/rate-limit.decorator.js';
import { RATE_LIMITS } from '../../config/rate-limits.js';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminLoginDto } from './admin-login.dto.js';

// Public route (no token): it is how an admin gets one. The /v1 prefix is added by setupApp.
@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly service: AdminAuthService) {}

  @RateLimit({ name: 'admin-login', ip: RATE_LIMITS.adminLogin.ip })
  @HttpCode(200)
  @Post('login')
  login(@Body() dto: AdminLoginDto) {
    return this.service.login(dto.email, dto.password);
  }
}
