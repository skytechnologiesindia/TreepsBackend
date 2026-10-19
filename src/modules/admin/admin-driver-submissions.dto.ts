import { OneOf, Optional, Page, PageSize, Required, ToInt, Uuid } from '../../common/validation/fields.js';

export const SUBMISSION_STATUSES = ['UNDER_REVIEW', 'APPROVED', 'REJECTED', 'DOCUMENTS_PENDING', 'SUSPENDED', 'BLOCKED'] as const;

// Query values arrive as text; ToInt turns "2" into 2 (and leaves "2x" to fail). The defaults
// (page 1, 20 per page) are applied by the service, never here.
export class ListSubmissionsQueryDto {
  @Optional(OneOf(SUBMISSION_STATUSES)) status?: string;
  @ToInt() @Optional(Page({ max: 1_000_000 })) page?: number;
  @ToInt() @Optional(PageSize({ max: 100 })) pageSize?: number;
}

export class SubmissionParamsDto {
  @Required(Uuid({ versions: 'all' })) driverId!: string;
}
