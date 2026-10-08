import { Email, Optional, OptionalNullable, PersonName, Required, Text } from '../../../common/validation/fields.js';

// Body of POST /v1/rider/auth/register (docs/api/rider-register.md). Nothing else is accepted: the
// rider id and the device id come from the access token, never from the body.
export class RegisterDto {
  @Required(PersonName()) fullName!: string;
  @Optional(Email()) email?: string;
  // May be omitted or null; "" is TOO_SHORT. The service trims them and stores null if nothing is left.
  @OptionalNullable(Text({ min: 1, max: 100, emptyIsTooShort: true })) registeredCity?: string | null;
  @OptionalNullable(Text({ min: 1, max: 100, emptyIsTooShort: true })) registeredState?: string | null;
}
