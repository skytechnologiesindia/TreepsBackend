import { Body, Controller, HttpCode, Post, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { AuthUser } from '../../common/auth/auth-user.decorator.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { RateLimit } from '../../common/rate-limit/rate-limit.decorator.js';
import type { AuthClaims } from '../../common/session/session.types.js';
import { RATE_LIMITS } from '../../config/rate-limits.js';
import { OnboardingBodyDto } from './driver-onboarding.dto.js';
import { DriverOnboardingService, type UploadedPhotos } from './driver-onboarding.service.js';
import { PHOTO_MAX_BYTES, PHOTO_PART_NAMES } from './onboarding-rules.js';

// The /v1 prefix is added by setupApp; never write it here (api-standard.md section 8).
// Protected route. The guard runs first, so nobody without a driver session can upload anything.
// The upload step (multer, like Express multer.fields) reads the photo parts into memory with a size
// limit; a part with an unknown name, a photo that is too big or a second text part is refused.
@Controller('driver/onboarding')
export class DriverOnboardingController {
  constructor(private readonly service: DriverOnboardingService) {}

  @RateLimit({ name: 'driver-onboarding', ip: RATE_LIMITS.onboardingSubmit.ip })
  @UseGuards(SessionAuthGuard)
  @UseInterceptors(
    FileFieldsInterceptor(
      PHOTO_PART_NAMES.map((name) => ({ name, maxCount: 1 })),
      { limits: { fileSize: PHOTO_MAX_BYTES, files: PHOTO_PART_NAMES.length, fields: 1 } },
    ),
  )
  @HttpCode(200)
  @Post()
  submit(@AuthUser() user: AuthClaims, @Body() body: OnboardingBodyDto, @UploadedFiles() files: UploadedPhotos) {
    return this.service.submit(user.userId, body.data, files ?? {});
  }
}
