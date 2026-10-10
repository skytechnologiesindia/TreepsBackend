import { Address, Email, Normalize, OneOf, Optional, OptionalNullable, PersonName, Text } from '../../../common/validation/fields.js';

export const GENDERS = ['MALE', 'FEMALE', 'OTHER'] as const;
export type GenderName = (typeof GENDERS)[number];

// Body of POST /v1/rider/auth/register (docs/api/rider-register.md). Nothing else is accepted: the
// rider id and the device id come from the session, and the terms proof (termsAcceptedAt,
// termsVersion) is set by the server, never taken from the body.
//
// fullName and gender are required while the profile is PROFILE_PENDING and optional afterwards. The
// DTO cannot know the state, so both are Optional here and RegisterService enforces "required".
// Text fields are cleaned by Normalize() before the checks (NFC, spaces, case); see fields.ts.
export class RegisterDto {
  @Normalize({ blank: 'keep-empty' }) @Optional(PersonName()) fullName?: string;
  @Optional(OneOf(GENDERS)) gender?: GenderName;
  // A blank string counts as not sent (it is never stored as ""). Not nullable: null is WRONG_TYPE.
  @Normalize({ lower: true, blank: 'unset' }) @Optional(Email()) email?: string;
  // Title Case, at most 60. null or whitespace only counts as not sent; "" is still TOO_SHORT.
  @Normalize({ title: true, blank: 'unset' }) @OptionalNullable(Text({ min: 1, max: 60, emptyIsTooShort: true })) registeredCity?: string | null;
  @Normalize({ title: true, blank: 'unset' }) @OptionalNullable(Text({ min: 1, max: 60, emptyIsTooShort: true })) registeredState?: string | null;
  @Normalize({ blank: 'unset' }) @Optional(Address()) registeredAddress?: string;
}
