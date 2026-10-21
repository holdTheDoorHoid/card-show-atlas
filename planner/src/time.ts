/**
 * Time handling. Shows list local dates and times in an IANA zone. Everything the planner compares
 * is an absolute instant (milliseconds since the Unix epoch), converted with the Intl API so it is
 * correct across time zone boundaries and daylight saving changes. No dependencies.
 */
import { PlannerError } from './types.js';

const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        weekday: 'short',
      });
    } catch {
      throw new PlannerError('bad_timezone', `Unknown time zone "${timeZone}".`);
    }
    formatters.set(timeZone, f);
  }
  return f;
}

/** True when the zone is a valid IANA name for this runtime. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 is Sunday. */
  weekday: number;
}

/** Wall clock parts of an instant in a zone. */
export function zonedParts(instantMs: number, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(instantMs));
  const out: ZonedParts = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0, weekday: 0 };
  for (const p of parts) {
    switch (p.type) {
      case 'year': out.year = Number(p.value); break;
      case 'month': out.month = Number(p.value); break;
      case 'day': out.day = Number(p.value); break;
      case 'hour': out.hour = Number(p.value) % 24; break;
      case 'minute': out.minute = Number(p.value); break;
      case 'second': out.second = Number(p.value); break;
      case 'weekday': out.weekday = WEEKDAYS[p.value] ?? 0; break;
      default: break;
    }
  }
  return out;
}

/** Offset of the zone from UTC at an instant, in milliseconds (local minus UTC). */
export function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const whole = Math.floor(instantMs / 1000) * 1000;
  const p = zonedParts(whole, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - whole;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})$/;

export function isValidDate(date: string): boolean {
  const m = DATE_RE.exec(date);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

export function isValidTime(time: string): boolean {
  const m = TIME_RE.exec(time);
  if (!m) return false;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h >= 0 && h <= 24 && mi >= 0 && mi < 60 && (h < 24 || mi === 0);
}

/** Minutes after midnight for `HH:MM`. `24:00` is allowed and means midnight at the end of the day. */
export function parseTime(time: string): number {
  const m = TIME_RE.exec(time);
  if (!m || !isValidTime(time)) throw new PlannerError('bad_time', `"${time}" is not a time like 09:30.`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Days since 1970-01-01 for a local calendar date. Used as a day index; it is not an instant. */
export function epochDay(date: string): number {
  const m = DATE_RE.exec(date);
  if (!m || !isValidDate(date)) throw new PlannerError('bad_date', `"${date}" is not a date like 2026-11-14.`);
  return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / MS_PER_DAY);
}

export function dateFromEpochDay(day: number): string {
  const d = new Date(day * MS_PER_DAY);
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth() + 1;
  const da = d.getUTCDate();
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
}

export function addDays(date: string, n: number): string {
  return dateFromEpochDay(epochDay(date) + n);
}

/** Weekday of a calendar date, 0 is Sunday. */
export function weekdayOf(date: string): number {
  return ((epochDay(date) % 7) + 7 + 4) % 7;
}

/** Month index (year * 12 + month - 1) of a calendar date. */
export function monthIndex(date: string): number {
  const m = DATE_RE.exec(date);
  if (!m) throw new PlannerError('bad_date', `"${date}" is not a date like 2026-11-14.`);
  return Number(m[1]) * 12 + Number(m[2]) - 1;
}

export type Disambiguation = 'compatible' | 'earlier' | 'later';

const instantCache = new Map<string, number>();

/**
 * Absolute instant for a local date and time in an IANA zone.
 *
 * Follows the Temporal "compatible" rule by default: a time that happens twice (the hour repeated
 * when clocks fall back) resolves to the earlier one, and a time that does not exist (the hour
 * skipped when clocks spring forward) is pushed forward by the length of the gap.
 */
export function zonedTimeToInstant(
  date: string,
  time: string,
  timeZone: string,
  disambiguation: Disambiguation = 'compatible',
): number {
  const key = `${date}|${time}|${timeZone}|${disambiguation}`;
  const cached = instantCache.get(key);
  if (cached !== undefined) return cached;

  const day = epochDay(date);
  const minutes = parseTime(time);
  const localAsUtc = day * MS_PER_DAY + minutes * MS_PER_MINUTE;

  const offBefore = zoneOffsetMs(localAsUtc - MS_PER_DAY, timeZone);
  const offAfter = zoneOffsetMs(localAsUtc + MS_PER_DAY, timeZone);
  const candidates: number[] = [];
  for (const off of offBefore === offAfter ? [offBefore] : [offBefore, offAfter]) {
    const t = localAsUtc - off;
    if (zoneOffsetMs(t, timeZone) === off) candidates.push(t);
  }
  let result: number;
  if (candidates.length === 0) {
    // In a gap. "compatible" and "later" read the wall time with the offset in force before the
    // gap, which lands after it. "earlier" uses the offset after the gap.
    result = disambiguation === 'earlier' ? localAsUtc - offAfter : localAsUtc - offBefore;
  } else {
    candidates.sort((a, b) => a - b);
    result = disambiguation === 'later' ? candidates[candidates.length - 1]! : candidates[0]!;
  }
  if (instantCache.size > 100_000) instantCache.clear();
  instantCache.set(key, result);
  return result;
}

/** Local date `YYYY-MM-DD` of an instant in a zone. */
export function localDate(instantMs: number, timeZone: string): string {
  const p = zonedParts(instantMs, timeZone);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Local time `HH:MM` of an instant in a zone. */
export function localTime(instantMs: number, timeZone: string): string {
  const p = zonedParts(instantMs, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** ISO 8601 with the zone's offset, for example `2026-11-14T07:30:00-05:00`. */
export function toZonedIso(instantMs: number, timeZone: string): string {
  const whole = Math.round(instantMs / 1000) * 1000;
  const p = zonedParts(whole, timeZone);
  const offMin = Math.round(zoneOffsetMs(whole, timeZone) / MS_PER_MINUTE);
  const sign = offMin < 0 ? '-' : '+';
  const abs = Math.abs(offMin);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${String(p.year).padStart(4, '0')}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** Today's date in a zone (or the runtime's zone). */
export function todayIn(timeZone?: string): string {
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return localDate(Date.now(), zone);
}

/** Hours between two instants. */
export function hoursBetween(fromMs: number, toMs: number): number {
  return (toMs - fromMs) / MS_PER_HOUR;
}
