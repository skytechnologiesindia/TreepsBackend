import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { FirebaseService } from './firebase.service.js';


@Module({
  controllers: [AuthController],
  providers: [AuthService, FirebaseService],
})
export class AuthModule {}