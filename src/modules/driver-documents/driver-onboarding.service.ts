import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Gender, Prisma } from '@prisma/client';
import { CLOCK, type Clock } from '../../common/clock.js';
import { AppException, type ErrorDetail } from '../../common/errors/app.exception.js';
import { FILE_STORAGE, type FileStorage } from '../../common/storage/file-storage.js';
import { detectImageType } from '../../common/storage/image-type.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { OnboardingDataDto, OnboardingStepDto } from './driver-onboarding.dto.js';
import { photoPartName, STEP_RULES, type Side, type StepKey } from './onboarding-rules.js';

// What the service needs from an uploaded file (a multer file has more).
export interface UploadedPhoto {
  buffer: Buffer;
}
export type UploadedPhotos = Record<string, UploadedPhoto[] | undefined>;

const MAX_DETAILS = 20;

interface PlannedPhoto {
  key: StepKey;
  side: Side;
  part: string;
  file: UploadedPhoto;
  path: string;
}

function asDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

// The work of POST /v1/driver/onboarding (docs/api/driver/driver-onboarding-submit.md). In Express
// terms: the handler body that checks the form, saves the files, saves the rows and replies.
// Order matters: check everything first, then store the photos, then save the rows in one
// transaction. A failure after the photos are stored deletes them again, so no photo is left behind.
@Injectable()
export class DriverOnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async submit(driverId: string, data: OnboardingDataDto, files: UploadedPhotos): Promise<{ status: 'UNDER_REVIEW' }> {
    const driver = await this.prisma.driver.findUnique({
      where: { id: driverId },
      select: { status: true, fullName: true, profilePhotoPath: true },
    });
    if (!driver) throw new AppException('UNAUTHORIZED');
    if (driver.status !== 'DOCUMENTS_PENDING') throw new AppException('CONFLICT');

    const requirements = await this.prisma.documentRequirement.findMany({
      where: { enabled: true },
      select: { type: true, required: true, options: true },
    });
    const existing = await this.prisma.driverDocument.findMany({
      where: { driverId },
      select: { key: true, status: true, frontPath: true, backPath: true },
    });

    // The photos this submit will replace, written down now, before anything is saved.
    const sent = new Set<string>(data.steps.map((step) => step.key));
    const replaced = [
      ...existing.filter((row) => sent.has(row.key)).flatMap((row) => [row.frontPath, row.backPath]),
      sent.has('PERSONAL_INFO') ? driver.profilePhotoPath : null,
    ].filter((path): path is string => path !== null);

    const planned = this.check(driverId, data, files, requirements, existing, driver.fullName !== null);
    const stored: string[] = [];
    try {
      for (const photo of planned) {
        await this.storage.save(photo.path, photo.file.buffer);
        stored.push(photo.path);
      }
      await this.save(driverId, data.steps, planned);
    } catch (error) {
      await Promise.allSettled(stored.map((path) => this.storage.delete(path)));
      throw error;
    }

    // The replaced photos are not needed any more. A failure here is not the driver's problem.
    await Promise.allSettled(replaced.map((path) => this.storage.delete(path)));

    return { status: 'UNDER_REVIEW' };
  }

  // Everything that can be wrong with the form, found before anything is stored. Returns the photos to store.
  private check(
    driverId: string,
    data: OnboardingDataDto,
    files: UploadedPhotos,
    requirements: Array<{ type: string; required: boolean; options: string[] }>,
    existing: Array<{ key: string; status: string }>,
    hasProfile: boolean,
  ): PlannedPhoto[] {
    const problems = new Map<string, string>();
    const problem = (field: string, reason: string) => {
      if (!problems.has(field)) problems.set(field, reason);
    };
    const switchedOn = new Map(requirements.map((row) => [row.type, row]));
    const seen = new Set<string>();
    const planned: PlannedPhoto[] = [];
    const expectedParts = new Set<string>();

    data.steps.forEach((step: OnboardingStepDto, index) => {
      const at = (field: string) => `data.steps.${index}.${field}`;
      const key = step.key as StepKey;
      if (seen.has(key)) return problem(at('key'), 'INVALID_VALUE');
      seen.add(key);
      const row = switchedOn.get(key);
      if (!row) return problem(at('key'), 'NOT_ALLOWED'); // switched off, or not a step today
      const rule = STEP_RULES[key];

      if (rule.options) {
        if (step.option === undefined) problem(at('option'), 'REQUIRED');
        else if (!rule.options.includes(step.option) || !row.options.includes(step.option)) problem(at('option'), 'NOT_ALLOWED');
      } else if (step.option !== undefined) problem(at('option'), 'UNKNOWN_FIELD');

      const profileFields = { fullName: step.fullName, dateOfBirth: step.dateOfBirth, gender: step.gender };
      for (const [name, value] of Object.entries(profileFields)) {
        if (rule.profile && value === undefined) problem(at(name), 'REQUIRED');
        if (!rule.profile && value !== undefined) problem(at(name), 'UNKNOWN_FIELD');
      }
      if (rule.number && step.number === undefined) problem(at('number'), 'REQUIRED');
      if (!rule.number && step.number !== undefined) problem(at('number'), 'UNKNOWN_FIELD');
      if (rule.expiry && step.expiryDate === undefined) problem(at('expiryDate'), 'REQUIRED');
      if (!rule.expiry && step.expiryDate !== undefined) problem(at('expiryDate'), 'UNKNOWN_FIELD');

      for (const side of rule.photos) {
        const part = photoPartName(key, side);
        expectedParts.add(part);
        const file = files[part]?.[0];
        if (!file) problem(part, 'REQUIRED');
        else {
          const type = detectImageType(file.buffer);
          if (!type) problem(part, 'INVALID_FORMAT');
          else {
            const label = key === 'PERSONAL_INFO' ? 'photo' : side.toLowerCase();
            planned.push({ key, side, part, file, path: `drivers/${driverId}/${key.toLowerCase()}-${label}-${randomUUID()}.${type}` });
          }
        }
      }
    });

    for (const part of Object.keys(files)) {
      if ((files[part]?.length ?? 0) > 0 && !expectedParts.has(part)) problem(part, 'UNKNOWN_FIELD');
    }

    // A required step must be in this request, or already sent before and not rejected.
    for (const row of requirements) {
      if (!row.required || seen.has(row.type)) continue;
      const done =
        row.type === 'PERSONAL_INFO'
          ? hasProfile
          : existing.some((doc) => doc.key === row.type && doc.status !== 'REJECTED');
      if (!done) problem(`data.steps.${row.type}`, 'REQUIRED');
    }

    if (problems.size > 0) {
      const details: ErrorDetail[] = [...problems.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .slice(0, MAX_DETAILS)
        .map(([field, reason]) => ({ field, reason }));
      throw new AppException('INVALID_INPUT', { field: details[0].field, details });
    }
    return planned;
  }

  // One transaction: the driver first, then the document rows. Nothing is half saved.
  private async save(driverId: string, steps: OnboardingStepDto[], planned: PlannedPhoto[]): Promise<void> {
    const pathOf = (key: StepKey, side: Side) => planned.find((p) => p.key === key && p.side === side)?.path ?? null;
    const now = this.clock();

    let profile: { fullName?: string; dateOfBirth?: Date; gender?: Gender; profilePhotoPath?: string | null } = {};
    const documents: Array<{ key: StepKey; values: Omit<Prisma.DriverDocumentUncheckedCreateInput, 'driverId' | 'key'> }> = [];
    for (const step of steps) {
      const key = step.key as StepKey;
      if (key === 'PERSONAL_INFO') {
        profile = {
          fullName: step.fullName,
          dateOfBirth: asDate(step.dateOfBirth as string),
          gender: step.gender as Gender,
          profilePhotoPath: pathOf(key, 'FRONT'),
        };
        continue;
      }
      documents.push({
        key,
        values: {
          option: step.option ?? null,
          number: step.number ?? null,
          expiryDate: step.expiryDate === undefined ? null : asDate(step.expiryDate),
          frontPath: pathOf(key, 'FRONT'),
          backPath: pathOf(key, 'BACK'),
          status: 'PENDING' as const,
          reviewNote: null,
        },
      });
    }

    await this.prisma.$transaction(async (tx) => {
      // The status moves only if the driver is still DOCUMENTS_PENDING. This also locks the driver's row,
      // so a second submit at the same moment waits here and then gets CONFLICT, before it writes anything.
      const moved = await tx.driver.updateMany({
        where: { id: driverId, status: 'DOCUMENTS_PENDING' },
        data: { ...profile, status: 'UNDER_REVIEW', submittedAt: now },
      });
      if (moved.count === 0) throw new AppException('CONFLICT');
      for (const { key, values } of documents) {
        await tx.driverDocument.upsert({
          where: { driverId_key: { driverId, key } },
          create: { driverId, key, ...values },
          update: values,
        });
      }
    });
  }
}
