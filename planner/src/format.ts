/**
 * Plain language formatting for user facing strings. House rules: short, no jargon, and no dashes
 * used as punctuation. Ranges read "180 to 650", durations read "3 h 10 min".
 */
import { epochDay, weekdayOf, zonedParts } from './time.js';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_NAMES_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "3 h 10 min", "45 min", "2 h". Rounded to 5 minutes; anything above zero shows at least 5 min. */
export function formatDuration(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return '0 min';
  let minutes = Math.round((hours * 60) / 5) * 5;
  if (minutes === 0) minutes = 5;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

/** Whole number with thousands separators. */
export function formatNumber(n: number, decimals = 0): string {
  const fixed = Math.abs(n).toFixed(decimals);
  const [int, frac] = fixed.split('.');
  const withSep = (int ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = n < 0 && Number(fixed) !== 0 ? 'minus ' : '';
  return frac ? `${sign}${withSep}.${frac}` : `${sign}${withSep}`;
}

/** "1,200 USD". Amounts under 10 keep cents so a fuel price reads "3.40 USD". */
export function formatMoney(amount: number, currency: string): string {
  const abs = Math.abs(amount);
  const decimals = abs > 0 && abs < 10 && Math.round(abs) !== abs ? 2 : 0;
  return `${formatNumber(amount, decimals)} ${currency}`;
}

/** "312 miles" or "502 km". */
export function formatDistance(miles: number, unit: 'mi' | 'km' = 'mi'): string {
  if (unit === 'km') return `${formatNumber(miles * 1.609344)} km`;
  const r = Math.round(miles);
  return `${formatNumber(r)} ${r === 1 ? 'mile' : 'miles'}`;
}

/** "Nov 3". */
export function formatShortDate(date: string): string {
  const [, mo, d] = date.split('-');
  return `${MONTHS[Number(mo) - 1] ?? mo} ${Number(d)}`;
}

/** "Sat Nov 14". */
export function formatDayLabel(date: string): string {
  return `${DAY_NAMES[weekdayOf(date)]} ${formatShortDate(date)}`;
}

/** "Saturday". */
export function formatWeekday(date: string): string {
  return DAY_NAMES_LONG[weekdayOf(date)] ?? '';
}

/** "9:00 AM" in the zone. */
export function formatClock(instantMs: number, timeZone: string): string {
  const p = zonedParts(instantMs, timeZone);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${h12}:${String(p.minute).padStart(2, '0')} ${p.hour < 12 ? 'AM' : 'PM'}`;
}

/** "9:00 AM" from a local `HH:MM`. */
export function formatLocalClock(time: string): string {
  const [hs, ms] = time.split(':');
  const h = Number(hs) % 24;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${ms} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "Nov 14 to 15", "Nov 30 to Dec 1", or "Nov 14" for one day. */
export function formatDateRange(first: string, last: string): string {
  if (first === last) return formatShortDate(first);
  const [, m1] = first.split('-');
  const [, m2, d2] = last.split('-');
  if (m1 === m2) return `${formatShortDate(first)} to ${Number(d2)}`;
  return `${formatShortDate(first)} to ${formatShortDate(last)}`;
}

/** "in 3 days", "today", "tomorrow", "in 2 weeks". */
export function formatWhen(date: string, today: string): string {
  const n = epochDay(date) - epochDay(today);
  if (n < 0) return n === -1 ? 'yesterday' : `${-n} days ago`;
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n < 14) return `in ${n} days`;
  if (n < 60) return `in ${Math.round(n / 7)} weeks`;
  return `in ${Math.round(n / 30)} months`;
}

/** Joins words as "a, b and c". */
export function joinWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** "Edison, NJ" when the city is known, otherwise the show name. */
export function townLabel(p: { city?: string | null; region?: string | null; name?: string }): string {
  if (p.city) return p.region ? `${p.city}, ${p.region}` : p.city;
  return p.name ?? 'the show';
}
