import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ValidatedEnv } from '../../config/env.validation.js';
import { AccessTokenService } from './access-token.service.js';

// One AccessTokenService for the rider and driver modules, built once from JWT_ACCESS_SECRET. In
// Express terms, a shared `signToken` helper that both routers require.
@Module({
  providers: [
    {
      provide: AccessTokenService,
      inject: [ConfigService],
      useFactory: (config: ConfigService<ValidatedEnv, true>) =>
        new AccessTokenService(config.get('JWT_ACCESS_SECRET', { infer: true })),
    },
  ],
  exports: [AccessTokenService],
})
export class AccessTokenModule {}
