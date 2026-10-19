import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { validateEnv } from './config/env.validation.js';
import { RidesModule } from './modules/rides/rides.module.js';
import { RateLimitModule } from './common/rate-limit/rate-limit.module.js';
import { RiderAuthModule } from './modules/rider-auth/rider-auth.module.js';
import { DriverAuthModule } from './modules/driver-auth/driver-auth.module.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { DriverDocumentModule } from './modules/driver-documents/driver-documents.module.js';

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
    DriverAuthModule,
    DriverDocumentModule,
    AdminModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}