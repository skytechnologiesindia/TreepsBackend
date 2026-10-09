import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { OtpPurpose } from '@prisma/client';
import { AuthUser } from '../../common/auth/auth-user.decorator.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { RateLimit } from '../../common/rate-limit/rate-limit.decorator.js';
import { SessionService } from '../../common/session/session.service.js';
import type { AuthClaims } from '../../common/session/session.types.js';
import { RATE_LIMITS } from '../../config/rate-limits.js';
import { SendOtpDto } from '../otp/dto/send-otp.dto.js';
import { SendOtpService } from '../otp/send-otp.service.js';
import { RegisterDto } from './dto/register.dto.js';
import { VerifyOtpDto } from '../otp/dto/verify-otp.dto.js';
import { RegisterService } from './register.service.js';
import { VerifyOtpService } from './verify-otp.service.js';

// The /v1 prefix is added by setupApp; never write it here (api-standard.md section 8).
@Controller('rider/auth')
export class RiderAuthController {
  constructor(
    private readonly sendOtpService: SendOtpService,
    private readonly verifyOtpService: VerifyOtpService,
    private readonly registerService: RegisterService,
    private readonly sessions: SessionService,
  ) {}

  // Public route (no login). 20 requests per IP per hour; the per-phone limits are in the service.
  // The purpose is fixed here, never read from the request.
  @RateLimit({ name: 'send-otp', ip: RATE_LIMITS.sendOtp.ip })
  @HttpCode(200)
  @Post('send-otp')
  sendOtp(@Body() dto: SendOtpDto) {
    return this.sendOtpService.sendOtp(OtpPurpose.RIDER_AUTH, dto.phoneNumber);
  }

  // Public route (no login). Login, or the account is created for a new phone (PROFILE_PENDING), and a
  // session is created. The limit is per phone (10 attempts an hour, counted from OtpSession.attempts
  // in the service); there is no per-IP limit on this route in the MVP (decision 121).
  @HttpCode(200)
  @Post('verify-otp')
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.verifyOtpService.verifyOtp(dto);
  }

  // Protected route: the session token from verify-otp is the credential. Completes the profile of the
  // rider in the session; calling it again saves the new values. 200 because nothing is created.
  // Guard order is SessionAuthGuard, then the IP limit (10 an hour): Nest runs the lower decorator first.
  @RateLimit({ name: 'register', ip: RATE_LIMITS.register.ip })
  @UseGuards(SessionAuthGuard)
  @HttpCode(200)
  @Post('register')
  register(@AuthUser() user: AuthClaims, @Body() dto: RegisterDto) {
    return this.registerService.completeProfile(user.userId, dto);
  }

  // Protected route: deletes this device's session. The token is dead at once. A token that is already
  // unknown is 401 from the guard, like any guarded route (docs/api/rider-logout.md).
  @RateLimit({ name: 'rider-logout', ip: RATE_LIMITS.logout.ip })
  @UseGuards(SessionAuthGuard)
  @HttpCode(200)
  @Post('logout')
  async logout(@AuthUser() user: AuthClaims) {
    await this.sessions.deleteForDevice(user.role, user.userId, user.deviceId);
    return { loggedOut: true };
  }
}
