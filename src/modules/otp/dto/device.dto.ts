import { Transform } from 'class-transformer';
import { AppVersion, DeviceId, FcmToken, OneOf, OptionalNullable, Required } from '../../../common/validation/fields.js';

export const DEVICE_PLATFORMS = ['ANDROID', 'IOS'] as const;
export type DevicePlatformName = (typeof DEVICE_PLATFORMS)[number];

// The device the app runs on, inside the verify-otp body (rider and driver share this one class).
// Saved on the device row (Device / DriverDevice) and refreshed on every successful verify-otp.
export class DeviceDto {
  @Required(DeviceId()) deviceId!: string;
  @Required(OneOf(DEVICE_PLATFORMS)) platform!: DevicePlatformName;
  @Required(AppVersion()) appVersion!: string;
  // Optional: the user may have denied the notification permission. null, omitted and "" all count as
  // not sent, so a push-token problem never fails login and a later login without a token never wipes
  // the stored one. Sensitive: never logged or returned.
  @Transform(({ value }) => (value === '' ? undefined : value))
  @OptionalNullable(FcmToken()) fcmToken?: string | null;
}
