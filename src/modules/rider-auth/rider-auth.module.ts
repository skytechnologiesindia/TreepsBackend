import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ValidatedEnv } from '../../config/env.validation.js';
import { OtpModule } from '../otp/otp.module.js';
import { AccessTokenService } from './access-token.service.js';
import { RiderAuthController } from './rider-auth.controller.js';
import { VerifyOtpService } from './verify-otp.service.js';

@Module({
  imports: [OtpModule],
  controllers: [RiderAuthController],
  providers: [
    VerifyOtpService,
    {
      provide: AccessTokenService,
      inject: [ConfigService],
      useFactory: (config: ConfigService<ValidatedEnv, true>) =>
        new AccessTokenService(config.get('JWT_ACCESS_SECRET', { infer: true })),
    },
  ],
})
export class RiderAuthModule {}
