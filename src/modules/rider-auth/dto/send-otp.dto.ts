import { IndianMobile, Required } from '../../../common/validation/fields.js';

// The only field of POST /v1/rider/auth/send-otp. The purpose is never sent by the client.
export class SendOtpDto {
  @Required(IndianMobile()) phoneNumber!: string;
}
