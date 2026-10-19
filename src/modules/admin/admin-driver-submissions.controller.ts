import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { RateLimit } from '../../common/rate-limit/rate-limit.decorator.js';
import { RATE_LIMITS } from '../../config/rate-limits.js';
import { AdminSessionGuard, AdminUser, type AdminClaims } from './admin-session.guard.js';
import { ListSubmissionsQueryDto, SubmissionParamsDto } from './admin-driver-submissions.dto.js';
import { AdminDriverSubmissionsService } from './admin-driver-submissions.service.js';

// Protected by the admin token. Read-only (docs/api/admin/admin-driver-submissions.md).
@Controller('admin/driver-submissions')
@UseGuards(AdminSessionGuard)
export class AdminDriverSubmissionsController {
  constructor(private readonly service: AdminDriverSubmissionsService) {}

  @RateLimit({ name: 'admin-driver-submissions', ip: RATE_LIMITS.adminDriverSubmissions.ip })
  @Get()
  list(@Query() query: ListSubmissionsQueryDto) {
    return this.service.list(query);
  }

  @RateLimit({ name: 'admin-driver-submissions', ip: RATE_LIMITS.adminDriverSubmissions.ip })
  @Get(':driverId')
  detail(@AdminUser() admin: AdminClaims, @Param() params: SubmissionParamsDto) {
    return this.service.detail(admin.adminId, params.driverId);
  }
}
