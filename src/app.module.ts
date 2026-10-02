import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from './auth/auth.module.js';
import { validateEnv } from './config/env.validation.js';
import { RidesModule } from './modules/rides/rides.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env', // Explicitly point to .env file
      validate: validateEnv,
    }),
    PrismaModule,
    AuthModule,
    RidesModule
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}