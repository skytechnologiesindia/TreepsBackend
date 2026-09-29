export const REASON_CODES = [
  'REQUIRED',
  'UNKNOWN_FIELD',
  'WRONG_TYPE',
  'INVALID_FORMAT',
  'OUT_OF_RANGE',
  'NOT_ALLOWED',
  'TOO_SHORT',
  'TOO_LONG',
  'INVALID_VALUE',
] as const; // this order IS the priority order

export type ReasonCode = (typeof REASON_CODES)[number];

// Constraint keys of our own checks (fields.ts): one failure gives one key.
export const CHECK_KEYS = {
  required: 'treepsRequired',
  wrongType: 'treepsWrongType',
  invalidFormat: 'treepsInvalidFormat',
  outOfRange: 'treepsOutOfRange',
  notAllowed: 'treepsNotAllowed',
  tooShort: 'treepsTooShort',
  tooLong: 'treepsTooLong',
} as const;

export type CheckKey = (typeof CHECK_KEYS)[keyof typeof CHECK_KEYS];

const KEY_TO_REASON: Readonly<Record<string, ReasonCode>> = {
  [CHECK_KEYS.required]: 'REQUIRED',
  [CHECK_KEYS.wrongType]: 'WRONG_TYPE',
  [CHECK_KEYS.invalidFormat]: 'INVALID_FORMAT',
  [CHECK_KEYS.outOfRange]: 'OUT_OF_RANGE',
  [CHECK_KEYS.notAllowed]: 'NOT_ALLOWED',
  [CHECK_KEYS.tooShort]: 'TOO_SHORT',
  [CHECK_KEYS.tooLong]: 'TOO_LONG',
  // class-validator keys that can still appear
  isDefined: 'REQUIRED',
  whitelistValidation: 'UNKNOWN_FIELD',
  nestedValidation: 'WRONG_TYPE',
};

export function reasonRank(reason: ReasonCode): number {
  return REASON_CODES.indexOf(reason);
}

export function reasonFor(constraintKeys: readonly string[]): ReasonCode {
  let best: ReasonCode = 'INVALID_VALUE';
  for (const key of constraintKeys) {
    const reason = Object.hasOwn(KEY_TO_REASON, key) ? KEY_TO_REASON[key] : 'INVALID_VALUE';
    if (reasonRank(reason) < reasonRank(best)) best = reason;
  }
  return best;
}
