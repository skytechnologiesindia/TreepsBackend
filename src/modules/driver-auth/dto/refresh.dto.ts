import { DeviceId, Required, Text } from '../../../common/validation/fields.js';

// Body of POST /v1/driver/auth/refresh (docs/api/driver-refresh.md). The token is checked as a plain
// non-empty string on purpose: a malformed token must get the same single REFRESH_TOKEN_INVALID as an
// unknown one, so a reply never says which kind of wrong it was.
export class DriverRefreshDto {
  @Required(Text({ min: 1, max: 512 })) refreshToken!: string;
  @Required(DeviceId()) deviceId!: string;
}
