import { plainToInstance, Transform } from 'class-transformer';
import {
  CalendarDate,
  Nested,
  NestedList,
  Normalize,
  OneOf,
  Optional,
  PersonName,
  Required,
  Text,
} from '../../common/validation/fields.js';
import { ALL_OPTIONS, GENDERS, STEP_KEYS } from './onboarding-rules.js';

// A date that many years from today, at midnight UTC. Read each time a request is checked.
function yearsFromToday(years: number): Date {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date;
}

// One step of the application. Every typed field is optional here: which ones a step needs is the
// rule of that step (onboarding-rules.ts), checked by the service. Anything not listed is refused.
export class OnboardingStepDto {
  @Required(OneOf(STEP_KEYS)) key!: string;
  @Optional(OneOf(ALL_OPTIONS)) option?: string;
  @Normalize({ blank: 'keep-empty' }) @Optional(PersonName()) fullName?: string;
  @Optional(CalendarDate({ min: () => yearsFromToday(-80), max: () => yearsFromToday(-18) })) dateOfBirth?: string;
  @Optional(OneOf(GENDERS)) gender?: string;
  @Optional(Text({ min: 1, max: 30 })) number?: string;
  @Optional(CalendarDate({ min: () => yearsFromToday(0), max: () => yearsFromToday(50) })) expiryDate?: string;
}

export class OnboardingDataDto {
  @Required(NestedList(() => OnboardingStepDto, { min: 1, max: STEP_KEYS.length })) steps!: OnboardingStepDto[];
}

// The "data" part arrives as JSON text. It is turned into the class here so the nested checks run;
// text that is not JSON is left as it is and fails as WRONG_TYPE.
function readData(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return parsed;
  return plainToInstance(OnboardingDataDto, parsed);
}

// The text part of POST /v1/driver/onboarding. The photos are separate file parts.
export class OnboardingBodyDto {
  @Transform(({ value }) => readData(value))
  @Required(Nested(() => OnboardingDataDto))
  data!: OnboardingDataDto;
}
