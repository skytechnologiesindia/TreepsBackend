import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { validateEnv } from './config/env.validation.js';
import { RidesModule } from './modules/rides/rides.module.js';
import { RateLimitModule } from './common/rate-limit/rate-limit.module.js';
import { RiderAuthModule } from './modules/rider-auth/rider-auth.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env', // Explicitly point to .env file
      validate: validateEnv,
    }),
    PrismaModule,
    RidesModule,
    RateLimitModule,
    RiderAuthModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}