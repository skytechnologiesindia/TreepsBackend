import { Inject, Injectable, Logger } from '@nestjs/common';
import type { DriverStatus } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception.js';
import { FILE_STORAGE, type FileStorage } from '../../common/storage/file-storage.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { STEP_KEYS, type StepKey } from '../driver-documents/onboarding-rules.js';
import { SUBMISSION_STATUSES } from './admin-driver-submissions.dto.js';

const DEFAULT_PAGE_SIZE = 20;
const CONTENT_TYPES: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png' };

export interface InlinePhoto {
  contentType: string;
  data: string; // base64
}

// docs/api/admin/admin-driver-submissions.md. Read-only. A submission is a driver whose submittedAt is
// set; a deleted driver is left out everywhere.
@Injectable()
export class AdminDriverSubmissionsService {
  private readonly logger = new Logger(AdminDriverSubmissionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  async list(query: { status?: string; page?: number; pageSize?: number }) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const submitted = { submittedAt: { not: null }, status: { not: 'DELETED' as DriverStatus } };
    const where = query.status === undefined ? submitted : { submittedAt: { not: null }, status: query.status as DriverStatus };

    const [grouped, filteredTotal, rows] = await Promise.all([
      this.prisma.driver.groupBy({ by: ['status'], where: submitted, _count: { _all: true } }),
      this.prisma.driver.count({ where }),
      this.prisma.driver.findMany({
        where,
        orderBy: [{ submittedAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: { id: true, phoneNumber: true, fullName: true, status: true, submittedAt: true, documents: { select: { status: true } } },
      }),
    ]);

    const counts: Record<string, number> = { total: 0 };
    for (const status of SUBMISSION_STATUSES) counts[status] = 0;
    for (const group of grouped) {
      counts[group.status] = group._count._all;
      counts.total += group._count._all;
    }

    return {
      counts,
      page,
      pageSize,
      total: filteredTotal,
      items: rows.map((row) => ({
        driverId: row.id,
        phoneNumber: row.phoneNumber,
        fullName: row.fullName,
        status: row.status,
        submittedAt: row.submittedAt,
        documents: {
          total: row.documents.length,
          pending: row.documents.filter((d) => d.status === 'PENDING').length,
          approved: row.documents.filter((d) => d.status === 'APPROVED').length,
          rejected: row.documents.filter((d) => d.status === 'REJECTED').length,
        },
      })),
    };
  }

  async detail(adminId: string, driverId: string) {
    const driver = await this.prisma.driver.findFirst({
      where: { id: driverId, submittedAt: { not: null }, status: { not: 'DELETED' } },
      select: {
        id: true,
        phoneNumber: true,
        status: true,
        submittedAt: true,
        fullName: true,
        dateOfBirth: true,
        gender: true,
        profilePhotoPath: true,
        documents: true,
      },
    });
    if (!driver) throw new AppException('NOT_FOUND');
    // An audit line: who looked at whose application. No name, number, photo or token in it.
    this.logger.log(`admin-viewed-submission adminId=${adminId} driverId=${driverId}`);

    const documents = [...driver.documents].sort((a, b) => STEP_KEYS.indexOf(a.key as StepKey) - STEP_KEYS.indexOf(b.key as StepKey));
    return {
      driverId: driver.id,
      phoneNumber: driver.phoneNumber,
      status: driver.status,
      submittedAt: driver.submittedAt,
      profile: {
        fullName: driver.fullName,
        dateOfBirth: driver.dateOfBirth === null ? null : driver.dateOfBirth.toISOString().slice(0, 10),
        gender: driver.gender,
        photo: await this.photo(driver.profilePhotoPath),
      },
      documents: await Promise.all(
        documents.map(async (doc) => ({
          key: doc.key,
          option: doc.option,
          number: doc.number,
          expiryDate: doc.expiryDate === null ? null : doc.expiryDate.toISOString().slice(0, 10),
          status: doc.status,
          reviewNote: doc.reviewNote,
          front: await this.photo(doc.frontPath),
          back: await this.photo(doc.backPath),
        })),
      ),
    };
  }

  // null when the step has no such photo, or the file is gone (that is logged, and does not fail the reply).
  private async photo(path: string | null): Promise<InlinePhoto | null> {
    if (path === null) return null;
    const bytes = await this.storage.read(path);
    if (bytes === null) {
      this.logger.warn(`submission photo file missing path=${path}`);
      return null;
    }
    const contentType = CONTENT_TYPES[path.slice(path.lastIndexOf('.') + 1)] ?? 'application/octet-stream';
    return { contentType, data: bytes.toString('base64') };
  }
}
