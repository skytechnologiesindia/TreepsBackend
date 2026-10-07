import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { OtpPurpose } from '@prisma/client';
import { RateLimit } from '../../common/rate-limit/rate-limit.decorator.js';
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
  ) {}

  // Public route (no login). 20 requests per IP per hour; the per-phone limits are in the service.
  // The purpose is fixed here, never read from the request.
  @RateLimit({ name: 'send-otp', ip: RATE_LIMITS.sendOtp.ip })
  @HttpCode(200)
  @Post('send-otp')
  sendOtp(@Body() dto: SendOtpDto) {
    return this.sendOtpService.sendOtp(OtpPurpose.RIDER_AUTH, dto.phoneNumber);
  }

  // Public route (no login). Login for an ACTIVE rider, or a registration token for a new phone.
  // The limit is per phone (10 attempts an hour, counted from OtpSession.attempts in the service);
  // there is no per-IP limit on this route in the MVP (decision 121).
  @HttpCode(200)
  @Post('verify-otp')
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.verifyOtpService.verifyOtp(dto);
  }

  // Public route (no login): the one-time registration token from verify-otp is the credential.
  // 10 requests per IP per hour. 201 because a Rider is created.
  @RateLimit({ name: 'register', ip: RATE_LIMITS.register.ip })
  @HttpCode(201)
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.registerService.register(dto);
  }
}
