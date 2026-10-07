import { IndianMobile, Nested, OtpCode, Required } from '../../../common/validation/fields.js';
import { DeviceDto } from './device.dto.js';

// Body of POST /v1/rider/auth/verify-otp and POST /v1/driver/auth/verify-otp. Nothing else is accepted.
export class VerifyOtpDto {
  @Required(IndianMobile()) phoneNumber!: string;
  @Required(OtpCode()) otp!: string;
  @Required(Nested(() => DeviceDto)) device!: DeviceDto;
}
