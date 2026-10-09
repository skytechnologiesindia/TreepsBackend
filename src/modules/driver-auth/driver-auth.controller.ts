import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { OtpPurpose } from '@prisma/client';
import { AuthUser } from '../../common/auth/auth-user.decorator.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { RateLimit } from '../../common/rate-limit/rate-limit.decorator.js';
import { SessionService } from '../../common/session/session.service.js';
import type { AuthClaims } from '../../common/session/session.types.js';
import { RATE_LIMITS } from '../../config/rate-limits.js';
import { VerifyOtpDto } from '../otp/dto/verify-otp.dto.js';
import { SendOtpDto } from '../otp/dto/send-otp.dto.js';
import { SendOtpService } from '../otp/send-otp.service.js';
import { DriverVerifyOtpService } from './driver-verify-otp.service.js';

// The /v1 prefix is added by setupApp; never write it here (api-standard.md section 8).
// send-otp (docs/api/driver-send-otp.md), verify-otp (driver-verify-otp.md), logout (driver-logout.md).
@Controller('driver/auth')
export class DriverAuthController {
  constructor(
    private readonly sendOtpService: SendOtpService,
    private readonly driverVerifyOtpService: DriverVerifyOtpService,
    private readonly sessions: SessionService,
  ) {}

  // Public route (no login). Same body, validation, limits and errors as the rider route. The
  // purpose is fixed by this route and is never read from the request. The IP counters have their
  // own name, so riders and drivers do not use up each other's 20 requests per hour.
  @RateLimit({ name: 'driver-send-otp', ip: RATE_LIMITS.sendOtp.ip })
  @HttpCode(200)
  @Post('send-otp')
  sendOtp(@Body() dto: SendOtpDto) {
    return this.sendOtpService.sendOtp(OtpPurpose.DRIVER_AUTH, dto.phoneNumber);
  }

  // Public route (no login). Logs in an existing driver, or creates the account for a new phone, and
  // creates the session (every other session of this driver is deleted: one active session). Like the
  // rider route: no per-IP limit; the per-phone limit (10 attempts an hour) is counted in the shared
  // code check from OtpSession.attempts. HTTP 200 for both cases; the app switches on isNewDriver.
  @HttpCode(200)
  @Post('verify-otp')
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.driverVerifyOtpService.verifyOtp(dto);
  }

  // Protected route: deletes this device's session. The token is dead at once. A token that is already
  // unknown is 401 from the guard, like any guarded route (docs/api/driver-logout.md).
  @RateLimit({ name: 'driver-logout', ip: RATE_LIMITS.logout.ip })
  @UseGuards(SessionAuthGuard)
  @HttpCode(200)
  @Post('logout')
  async logout(@AuthUser() user: AuthClaims) {
    await this.sessions.deleteForDevice(user.role, user.userId, user.deviceId);
    return { loggedOut: true };
  }
}
