import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { OtpPurpose } from '@prisma/client';
import { RateLimit } from '../../common/rate-limit/rate-limit.decorator.js';
import { RATE_LIMITS } from '../../config/rate-limits.js';
import { SendOtpDto } from '../otp/dto/send-otp.dto.js';
import { SendOtpService } from '../otp/send-otp.service.js';

// The /v1 prefix is added by setupApp; never write it here (api-standard.md section 8).
// Only send-otp exists for drivers so far (docs/api/driver-send-otp.md).
@Controller('driver/auth')
export class DriverAuthController {
  constructor(private readonly sendOtpService: SendOtpService) {}

  // Public route (no login). Same body, validation, limits and errors as the rider route. The
  // purpose is fixed by this route and is never read from the request. The IP counters have their
  // own name, so riders and drivers do not use up each other's 20 requests per hour.
  @RateLimit({ name: 'driver-send-otp', ip: RATE_LIMITS.sendOtp.ip })
  @HttpCode(200)
  @Post('send-otp')
  sendOtp(@Body() dto: SendOtpDto) {
    return this.sendOtpService.sendOtp(OtpPurpose.DRIVER_AUTH, dto.phoneNumber);
  }
}
