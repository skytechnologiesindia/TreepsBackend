import { Injectable } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

// A full ISO date-time: date, time, and a zone (Z or an offset). A date-only "2026-10-07" and a
// time without a zone do not match, so they get no twin.
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // Asia/Kolkata is UTC+05:30 all year (no daylight saving)
const pad = (n: number) => String(n).padStart(2, '0');

// "07-10-2026 19:23:10" for 2026-10-07T13:53:10.203Z. Seconds are cut, not rounded.
function formatIst(date: Date): string {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  return (
    `${pad(ist.getUTCDate())}-${pad(ist.getUTCMonth() + 1)}-${ist.getUTCFullYear()} ` +
    `${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())}`
  );
}

// The Date a string stands for, or null if it is not a real full ISO date-time (a 13th month, a
// 31st of February or a free-text sentence all give null).
function parseIsoDateTime(text: string): Date | null {
  const match = ISO_DATE_TIME.exec(text);
  if (!match) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  const [, , month, day, hour, minute, second] = match.map(Number);
  // The Date constructor rolls some impossible values over (Feb 31 becomes Mar 3): refuse those.
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const monthDays = new Date(Date.UTC(Number(match[1]), month, 0)).getUTCDate();
  return day <= monthDays ? date : null;
}

function istOf(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : formatIst(value);
  if (typeof value === 'string') {
    const date = parseIsoDateTime(value);
    return date ? formatIst(date) : null;
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Copies plain objects and arrays, and after each key whose value is a Date or a full ISO date-time
// adds `<key>Ist`. Values are never changed. A null gets no twin: without key names there is no way
// to know a null was a date. A twin is not added where `<key>Ist` already exists.
export function addIstTwins(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(addIstTwins);
  if (!isPlainObject(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    result[key] = addIstTwins(inner);
    const twin = istOf(inner);
    const twinKey = `${key}Ist`;
    if (twin !== null && !(twinKey in value)) result[twinKey] = twin;
  }
  return result;
}

// Runs on what the handler returned, BEFORE the ResponseInterceptor wraps it (it is registered
// after it, so it is the inner one). In Express terms, a small step on res.json's input that adds
// display fields. The wrapper itself never reads data; this is the only step that may change it.
// Errors do not pass through here, so error replies are not touched.
@Injectable()
export class IstTwinInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map(addIstTwins));
  }
}
