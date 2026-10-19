import { Injectable } from '@nestjs/common';
import type { Driver } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { STEP_KEYS, type StepKey } from '../driver-documents/onboarding-rules.js';
import { driverView } from './driver-verify-otp.service.js';

export type NextStep = 'SUBMIT_DOCUMENTS' | 'FIX_DOCUMENTS' | 'WAIT_FOR_REVIEW' | 'READY' | 'REJECTED';

// Which screen the app shows (docs/api/driver/driver-me.md). Banned drivers never get here: the
// session guard refuses them first.
export function nextStepOf(driver: Pick<Driver, 'status' | 'submittedAt'>): NextStep {
  if (driver.status === 'APPROVED') return 'READY';
  if (driver.status === 'REJECTED') return 'REJECTED';
  if (driver.status === 'UNDER_REVIEW') return 'WAIT_FOR_REVIEW';
  return driver.submittedAt === null ? 'SUBMIT_DOCUMENTS' : 'FIX_DOCUMENTS';
}

// GET /v1/driver/me. In Express terms, the usual `GET /me` that returns req.user's current record.
@Injectable()
export class DriverMeService {
  constructor(private readonly prisma: PrismaService) {}

  async me(driverId: string) {
    const driver = await this.prisma.driver.findUnique({
      where: { id: driverId },
      include: { documents: { select: { key: true, status: true, reviewNote: true } } },
    });
    if (!driver) throw new AppException('UNAUTHORIZED');
    // Built field by field, so a document number or photo path can never reach the app.
    const documents = [...driver.documents]
      .sort((a, b) => STEP_KEYS.indexOf(a.key as StepKey) - STEP_KEYS.indexOf(b.key as StepKey))
      .map((doc) => ({ key: doc.key, status: doc.status, reviewNote: doc.reviewNote }));
    return { driver: driverView(driver), nextStep: nextStepOf(driver), documents };
  }
}
