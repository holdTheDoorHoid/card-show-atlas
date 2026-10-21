// Calendar dates as "YYYY-MM-DD" strings. All math is done on whole calendar days in UTC, so
// daylight saving changes and the viewer's time zone never shift a date.

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
export const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December',
] as const;
export const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

export function parseISODate(s: string): { y: number; m: number; d: number } | null {
  const m = ISO.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

export function isISODate(s: unknown): s is string {
  return typeof s === 'string' && parseISODate(s) !== null;
}

function toDayNumber(iso: string): number {
  const p = parseISODate(iso);
  if (!p) throw new Error(`Not a date: ${iso}`);
  return Math.round(Date.UTC(p.y, p.m - 1, p.d) / 86400000);
}

function fromDayNumber(n: number): string {
  const t = new Date(n * 86400000);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(iso: string, n: number): string {
  return fromDayNumber(toDayNumber(iso) + n);
}

/** Whole days from a to b (negative when b is earlier). */
export function daysBetween(a: string, b: string): number {
  return toDayNumber(b) - toDayNumber(a);
}

/** Today's date on the viewer's own clock. */
export function todayISO(now: Date = new Date()): string {
  const y = String(now.getFullYear()).padStart(4, '0');
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 0 for Sunday through 6 for Saturday. */
export function weekday(iso: string): number {
  return ((toDayNumber(iso) % 7) + 11) % 7; // 1970-01-01 (day 0) was a Thursday (4)
}

export interface DateRange {
  from: string;
  to: string;
}

/** Friday through Sunday. From Saturday on, the part of the weekend that is left. */
export function thisWeekend(today: string): DateRange {
  const w = weekday(today);
  if (w === 0) return { from: today, to: today };
  if (w === 6) return { from: today, to: addDays(today, 1) };
  if (w === 5) return { from: today, to: addDays(today, 2) };
  const friday = addDays(today, 5 - w);
  return { from: friday, to: addDays(friday, 2) };
}

export type DateChip = 'weekend' | '2weeks' | '30days' | 'pick';

export function rangeForChip(chip: DateChip, today: string, pick?: { from?: string; to?: string }): DateRange {
  switch (chip) {
    case 'weekend':
      return thisWeekend(today);
    case '2weeks':
      return { from: today, to: addDays(today, 14) };
    case '30days':
      return { from: today, to: addDays(today, 30) };
    case 'pick': {
      const from = pick?.from && isISODate(pick.from) ? pick.from : today;
      let to = pick?.to && isISODate(pick.to) ? pick.to : addDays(from, 30);
      if (to < from) to = from;
      return { from, to };
    }
  }
}

/** "Sat, Nov 14" */
export function formatDay(iso: string, withYear = false): string {
  const p = parseISODate(iso);
  if (!p) return iso;
  const base = `${WEEKDAYS_SHORT[weekday(iso)]}, ${MONTHS_SHORT[p.m - 1]} ${p.d}`;
  return withYear ? `${base}, ${p.y}` : base;
}

/** "Saturday, November 14, 2026" */
export function formatDayLong(iso: string): string {
  const p = parseISODate(iso);
  if (!p) return iso;
  return `${WEEKDAYS_LONG[weekday(iso)]}, ${MONTHS_LONG[p.m - 1]} ${p.d}, ${p.y}`;
}

/** "Nov 14" */
export function formatMonthDay(iso: string, withYear = false): string {
  const p = parseISODate(iso);
  if (!p) return iso;
  return `${MONTHS_SHORT[p.m - 1]} ${p.d}${withYear ? `, ${p.y}` : ''}`;
}

/** "Nov 14", "Nov 14 to 15", "Nov 30 to Dec 1", "Dec 30, 2026 to Jan 2, 2027" */
export function formatRange(first: string, last: string = first, refYear?: number): string {
  const a = parseISODate(first);
  const b = parseISODate(last);
  if (!a || !b) return first;
  const yearTag = refYear !== undefined && a.y !== refYear ? `, ${a.y}` : '';
  if (first === last) return `${formatMonthDay(first)}${yearTag}`;
  if (a.y !== b.y) return `${formatMonthDay(first, true)} to ${formatMonthDay(last, true)}`;
  if (a.m === b.m) return `${MONTHS_SHORT[a.m - 1]} ${a.d} to ${b.d}${yearTag}`;
  return `${formatMonthDay(first)} to ${formatMonthDay(last)}${yearTag}`;
}

/** "Sat, Nov 14" for one day, "Nov 14 to 15" for several. A year is added when it is not `refYear`. */
export function formatRowDate(first: string, last: string = first, refYear?: number): string {
  const p = parseISODate(first);
  if (first === last) return p && refYear !== undefined && p.y !== refYear ? formatDay(first, true) : formatDay(first);
  return formatRange(first, last, refYear);
}

/** "9 am", "1:30 pm", "noon" is not used: the clock is clearer. */
export function formatTime(hhmm: string | null): string {
  if (!hhmm) return '';
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  const h = Number(m[1]);
  const min = m[2];
  const suffix = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return min === '00' ? `${h12} ${suffix}` : `${h12}:${min} ${suffix}`;
}

/** "9 am to 3 pm", "opens 9 am", "closes 3 pm", or "" */
export function formatHours(open: string | null, close: string | null): string {
  if (open && close) return `${formatTime(open)} to ${formatTime(close)}`;
  if (open) return `opens ${formatTime(open)}`;
  if (close) return `closes ${formatTime(close)}`;
  return '';
}

/** "EST", "PDT", or "" when the zone is unknown. */
export function timeZoneAbbreviation(timeZone: string | null, iso: string): string {
  if (!timeZone) return '';
  const p = parseISODate(iso);
  if (!p) return '';
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' });
    const part = fmt.formatToParts(new Date(Date.UTC(p.y, p.m - 1, p.d, 18))).find((x) => x.type === 'timeZoneName');
    return part?.value ?? '';
  } catch {
    return '';
  }
}

/** "Today", "Tomorrow", "in 5 days", "3 days ago". */
export function relativeDays(iso: string, today: string): string {
  const n = daysBetween(today, iso);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}
