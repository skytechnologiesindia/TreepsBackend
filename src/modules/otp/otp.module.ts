import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CLOCK, systemClock } from '../../common/clock.js';
import type { ValidatedEnv } from '../../config/env.validation.js';
import { createOtpProvider } from './provider/otp-provider.factory.js';
import { OTP_PROVIDER } from './provider/otp-provider.js';
import { SendOtpService } from './send-otp.service.js';

// The OTP pieces shared by the rider and driver auth modules: the chosen provider (decided once at
// startup from OTP_PROVIDER), the clock, and the send-otp logic. In Express terms, a shared
// service file that both routers require.
@Module({
  providers: [
    { provide: CLOCK, useValue: systemClock },
    {
      provide: OTP_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<ValidatedEnv, true>) =>
        createOtpProvider(config.get('OTP_PROVIDER', { infer: true }), config.get('FAKE_OTP_CODE', { infer: true })),
    },
    SendOtpService,
  ],
  exports: [CLOCK, OTP_PROVIDER, SendOtpService],
})
export class OtpModule {}
