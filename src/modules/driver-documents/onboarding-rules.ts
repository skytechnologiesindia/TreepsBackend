// What each onboarding step takes (docs/api/driver/driver-onboarding-submit.md). One list, used by the
// request check, the service and the file upload limits. The app has its own screen for each key.
export type Side = 'FRONT' | 'BACK';

export interface StepRule {
  options?: readonly string[]; // the driver must pick one of these
  profile?: true; // PERSONAL_INFO: fullName, dateOfBirth, gender; its one photo is the profile photo
  number?: true;
  expiry?: true;
  photos: readonly Side[];
}

const RULES = {
  VEHICLE: { options: ['CAR', 'BIKE', 'AUTO'], photos: [] },
  PERSONAL_INFO: { profile: true, photos: ['FRONT'] },
  PERSONAL_IDENTITY: { options: ['AADHAAR', 'PAN_CARD'], number: true, photos: ['FRONT'] },
  DRIVING_LICENCE: { number: true, expiry: true, photos: ['FRONT', 'BACK'] },
  VEHICLE_NUMBER: { options: ['VEHICLE_RC', 'ROAD_TAX'], number: true, photos: ['FRONT', 'BACK'] },
  PERMIT: { number: true, expiry: true, photos: ['FRONT', 'BACK'] },
  CAB_INSURANCE: { number: true, expiry: true, photos: ['FRONT'] },
  FITNESS: { number: true, expiry: true, photos: ['FRONT'] },
} satisfies Record<string, StepRule>;

export type StepKey = keyof typeof RULES;
export const STEP_RULES: Record<StepKey, StepRule> = RULES;
export const STEP_KEYS = Object.keys(RULES) as StepKey[];
export const ALL_OPTIONS: readonly string[] = [
  ...new Set(STEP_KEYS.flatMap((key) => STEP_RULES[key].options ?? [])),
];
export const GENDERS = ['MALE', 'FEMALE', 'OTHER'] as const;

// The name of the file part that carries one photo: DRIVING_LICENCE_FRONT, DRIVING_LICENCE_BACK, and
// PERSONAL_INFO_PHOTO for the profile photo.
export function photoPartName(key: StepKey, side: Side): string {
  return key === 'PERSONAL_INFO' ? 'PERSONAL_INFO_PHOTO' : `${key}_${side}`;
}

export const PHOTO_PART_NAMES: readonly string[] = STEP_KEYS.flatMap((key) =>
  STEP_RULES[key].photos.map((side) => photoPartName(key, side)),
);

export const PHOTO_MAX_BYTES = 2 * 1024 * 1024; // 2 MB each
