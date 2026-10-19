import { Controller, Get, UseGuards } from '@nestjs/common';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { RateLimit } from '../../common/rate-limit/rate-limit.decorator.js';
import { RATE_LIMITS } from '../../config/rate-limits.js';
import { DriverDocumentService } from './driver-documents.service.js';

@Controller('driver/documents')
export class DriverDocumentsController {
  constructor(private readonly service: DriverDocumentService) {}

  // The session guard runs first (the lower decorator runs first), then the IP limit counts.
  @RateLimit({ name: 'driver-document-requirements', ip: RATE_LIMITS.documentRequirements.ip })
  @UseGuards(SessionAuthGuard)
  @Get('requirements')
  requirements() {
    return this.service.getRequirements();
  }
}
