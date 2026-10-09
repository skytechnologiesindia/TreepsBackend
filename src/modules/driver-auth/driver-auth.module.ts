import { Module } from '@nestjs/common';
import { AccessTokenModule } from '../../common/jwt/access-token.module.js';
import { OtpModule } from '../otp/otp.module.js';
import { DriverAuthController } from './driver-auth.controller.js';
import { DriverSessionService } from './driver-session.service.js';
import { DriverVerifyOtpService } from './driver-verify-otp.service.js';

@Module({
  imports: [OtpModule, AccessTokenModule],
  controllers: [DriverAuthController],
  providers: [DriverVerifyOtpService, DriverSessionService],
})
export class DriverAuthModule {}
