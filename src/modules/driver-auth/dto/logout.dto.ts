import { Required, Text } from '../../../common/validation/fields.js';

// Body of POST /v1/driver/auth/logout (docs/api/driver-logout.md). Any non-empty string is accepted,
// because logout always succeeds, even for a token the server does not know.
export class DriverLogoutDto {
  @Required(Text({ min: 1, max: 512 })) refreshToken!: string;
}
