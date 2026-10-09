import { Module } from '@nestjs/common';
import { SessionService } from './session.service.js';

// One SessionService for the rider and driver modules (PrismaModule is global). In Express terms, the
// shared session store both routers require.
@Module({
  providers: [SessionService],
  exports: [SessionService],
})
export class SessionModule {}
