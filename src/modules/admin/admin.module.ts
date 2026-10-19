import { Module } from '@nestjs/common';
import { SessionModule } from '../../common/session/session.module.js';
import { StorageModule } from '../../common/storage/storage.module.js';
import { OtpModule } from '../otp/otp.module.js';
import { AdminAuthController } from './admin-auth.controller.js';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminDriverSubmissionsController } from './admin-driver-submissions.controller.js';
import { AdminDriverSubmissionsService } from './admin-driver-submissions.service.js';
import { AdminSessionGuard } from './admin-session.guard.js';
import { AdminSessionService } from './admin-session.service.js';

// OtpModule is imported only for the shared clock (CLOCK).
@Module({
  imports: [OtpModule, SessionModule, StorageModule],
  controllers: [AdminAuthController, AdminDriverSubmissionsController],
  providers: [AdminAuthService, AdminSessionService, AdminSessionGuard, AdminDriverSubmissionsService],
})
export class AdminModule {}
