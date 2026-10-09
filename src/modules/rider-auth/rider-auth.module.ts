import { Module } from '@nestjs/common';
import { OtpModule } from '../otp/otp.module.js';
import { SessionModule } from '../../common/session/session.module.js';
import { RegisterService } from './register.service.js';
import { RiderAuthController } from './rider-auth.controller.js';
import { VerifyOtpService } from './verify-otp.service.js';

@Module({
  imports: [OtpModule, SessionModule],
  controllers: [RiderAuthController],
  providers: [VerifyOtpService, RegisterService],
})
export class RiderAuthModule {}
