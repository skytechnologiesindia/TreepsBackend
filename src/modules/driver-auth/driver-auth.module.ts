import { Module } from '@nestjs/common';
import { SessionModule } from '../../common/session/session.module.js';
import { OtpModule } from '../otp/otp.module.js';
import { DriverAuthController } from './driver-auth.controller.js';
import { DriverMeController } from './driver-me.controller.js';
import { DriverMeService } from './driver-me.service.js';
import { DriverVerifyOtpService } from './driver-verify-otp.service.js';

@Module({
  imports: [OtpModule, SessionModule],
  controllers: [DriverAuthController, DriverMeController],
  providers: [DriverVerifyOtpService, DriverMeService],
})
export class DriverAuthModule {}
