import type { ValidationError } from 'class-validator';
import { AppException, type ErrorDetail } from '../errors/app.exception.js';
import { reasonFor, reasonRank, type ReasonCode } from './validation-reasons.js';

export const UNKNOWN_NAME_PLACEHOLDER = '$unknown';
export const MAX_DETAILS = 20;
const SAFE_UNKNOWN_NAME = /^[A-Za-z_][A-Za-z0-9_.]{0,63}$/;

interface Collected {
  fields: Map<string, ReasonCode>;
  wholeBody: boolean;
}

function add(fields: Map<string, ReasonCode>, field: string, reason: ReasonCode): void {
  const current = fields.get(field);
  if (current === undefined || reasonRank(reason) < reasonRank(current)) {
    fields.set(field, reason);
  }
}

// Reads ONLY property, children and the constraint KEYS. Never a constraint value,
// value, target or message.
function collect(error: ValidationError, parentPath: string, out: Collected): void {
  if (parentPath === '' && !error.property) {
    out.wholeBody = true; // a root-level error: the body itself is unusable
    return;
  }
  const path = parentPath === '' ? error.property : `${parentPath}.${error.property}`;
  const keys = Object.keys(error.constraints ?? {});
  if (keys.length > 0) {
    const reason = reasonFor(keys);
    const unsafeName = reason === 'UNKNOWN_FIELD' && !SAFE_UNKNOWN_NAME.test(error.property);
    add(out.fields, unsafeName ? UNKNOWN_NAME_PLACEHOLDER : path, reason);
  }
  for (const child of error.children ?? []) collect(child, path, out);
}

export function toAppException(errors: readonly ValidationError[]): AppException {
  const out: Collected = { fields: new Map(), wholeBody: false };
  for (const error of errors) collect(error, '', out);

  if (out.wholeBody || out.fields.size === 0) {
    return new AppException('INVALID_INPUT');
  }

  const details: ErrorDetail[] = [...out.fields.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) // plain code-unit order, not locale
    .slice(0, MAX_DETAILS)
    .map(([field, reason]) => ({ field, reason }));

  const first = details.find((d) => d.field !== UNKNOWN_NAME_PLACEHOLDER);
  return new AppException('INVALID_INPUT', { field: first?.field ?? null, details });
}
