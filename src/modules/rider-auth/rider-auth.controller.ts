import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { RateLimit } from '../../common/rate-limit/rate-limit.decorator.js';
import { RATE_LIMITS } from '../../config/rate-limits.js';
import { SendOtpDto } from './dto/send-otp.dto.js';
import { RiderAuthService } from './rider-auth.service.js';

// The /v1 prefix is added by setupApp; never write it here (api-standard.md section 8).
@Controller('rider/auth')
export class RiderAuthController {
  constructor(private readonly riderAuthService: RiderAuthService) {}

  // Public route (no login). 20 requests per IP per hour; the per-phone limits are in the service.
  @RateLimit({ name: 'send-otp', ip: RATE_LIMITS.sendOtp.ip })
  @HttpCode(200)
  @Post('send-otp')
  sendOtp(@Body() dto: SendOtpDto) {
    return this.riderAuthService.sendOtp(dto.phoneNumber);
  }
}
