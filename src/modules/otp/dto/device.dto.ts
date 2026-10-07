import { AppVersion, DeviceId, OneOf, Optional, Required, Text } from '../../../common/validation/fields.js';

export const DEVICE_PLATFORMS = ['ANDROID', 'IOS'] as const;
export type DevicePlatformName = (typeof DEVICE_PLATFORMS)[number];

// The device the app runs on. The same shape is used by verify-otp and register.
export class DeviceDto {
  @Required(DeviceId()) deviceId!: string;
  @Required(OneOf(DEVICE_PLATFORMS)) platform!: DevicePlatformName;
  @Required(AppVersion()) appVersion!: string;
  @Optional(Text({ min: 1, max: 512 })) fcmToken?: string;
}
