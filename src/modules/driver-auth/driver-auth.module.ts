import { Module } from '@nestjs/common';
import { OtpModule } from '../otp/otp.module.js';
import { DriverAuthController } from './driver-auth.controller.js';

@Module({
  imports: [OtpModule],
  controllers: [DriverAuthController],
})
export class DriverAuthModule {}
