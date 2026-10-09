import { Module } from '@nestjs/common';
import { SessionModule } from '../../common/session/session.module.js';
import { OtpModule } from '../otp/otp.module.js';
import { DriverAuthController } from './driver-auth.controller.js';
import { DriverVerifyOtpService } from './driver-verify-otp.service.js';

@Module({
  imports: [OtpModule, SessionModule],
  controllers: [DriverAuthController],
  providers: [DriverVerifyOtpService],
})
export class DriverAuthModule {}
