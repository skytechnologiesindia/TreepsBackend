import {
  Email,
  Nested,
  OpaqueToken,
  Optional,
  OptionalNullable,
  PersonName,
  Required,
  Text,
} from '../../../common/validation/fields.js';
import { DeviceDto } from '../../otp/dto/device.dto.js';

// Body of POST /v1/rider/auth/register (docs/api/rider-register.md). Nothing else is accepted: the
// phone number is not sent, the server reads it from the verified session of the registration token.
export class RegisterDto {
  @Required(OpaqueToken()) registrationToken!: string;
  @Required(PersonName()) fullName!: string;
  @Optional(Email()) email?: string;
  // May be omitted or null; "" is TOO_SHORT. The service trims them and stores null if nothing is left.
  @OptionalNullable(Text({ min: 1, max: 100, emptyIsTooShort: true })) registeredCity?: string | null;
  @OptionalNullable(Text({ min: 1, max: 100, emptyIsTooShort: true })) registeredState?: string | null;
  @Required(Nested(() => DeviceDto)) device!: DeviceDto;
}
