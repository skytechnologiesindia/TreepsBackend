import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CLOCK, systemClock } from '../../common/clock.js';
import type { ValidatedEnv } from '../../config/env.validation.js';
import { createOtpProvider } from './otp/otp-provider.factory.js';
import { OTP_PROVIDER } from './otp/otp-provider.js';
import { RiderAuthController } from './rider-auth.controller.js';
import { RiderAuthService } from './rider-auth.service.js';

@Module({
  controllers: [RiderAuthController],
  providers: [
    RiderAuthService,
    { provide: CLOCK, useValue: systemClock },
    {
      provide: OTP_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<ValidatedEnv, true>) =>
        createOtpProvider(config.get('OTP_PROVIDER', { infer: true }), config.get('FAKE_OTP_CODE', { infer: true })),
    },
  ],
})
export class RiderAuthModule {}
