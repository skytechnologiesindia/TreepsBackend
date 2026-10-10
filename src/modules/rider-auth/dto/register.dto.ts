import { Address, Email, Normalize, Optional, OptionalNullable, PersonName, Text } from '../../../common/validation/fields.js';

// Body of POST /v1/rider/auth/register (docs/api/rider-register.md). Nothing else is accepted: the
// rider id and the device id come from the session, and the terms proof (termsAcceptedAt,
// termsVersion) is set by the server, never taken from the body.
//
// fullName is required while the profile is PROFILE_PENDING and optional afterwards. The DTO cannot
// know the state, so it is Optional here and RegisterService enforces "required". There is no gender
// field (decision 184): sending one is UNKNOWN_FIELD; the Rider.gender column is kept but unused.
// Text fields are cleaned by Normalize() before the checks (NFC, spaces, case); see fields.ts.
export class RegisterDto {
  @Normalize({ blank: 'keep-empty' }) @Optional(PersonName()) fullName?: string;
  // A blank string counts as not sent (it is never stored as ""). Not nullable: null is WRONG_TYPE.
  @Normalize({ lower: true, blank: 'unset' }) @Optional(Email()) email?: string;
  // Title Case, at most 60. null or whitespace only counts as not sent; "" is still TOO_SHORT.
  @Normalize({ title: true, blank: 'unset' }) @OptionalNullable(Text({ min: 1, max: 60, emptyIsTooShort: true })) registeredCity?: string | null;
  @Normalize({ title: true, blank: 'unset' }) @OptionalNullable(Text({ min: 1, max: 60, emptyIsTooShort: true })) registeredState?: string | null;
  @Normalize({ blank: 'unset' }) @Optional(Address()) registeredAddress?: string;
}
