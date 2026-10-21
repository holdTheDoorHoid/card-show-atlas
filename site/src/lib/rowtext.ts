// Short plain-language lines about a row, for the lists and cards.
import { formatMonthDay } from './dates.ts';
import { formatDriveTime, formatMoney } from './format.ts';
import { formatDistance, type DistanceUnit } from './geo.ts';
import { VENDOR_STATUS_LABEL } from './labels.ts';
import type { IndexRow } from './types.ts';

/** "Free entry", "Entry $5", or "Entry price not listed". */
export function entryText(row: IndexRow): string {
  if (row.fr === 1) return 'Free entry';
  if (row.ad !== undefined) return `Entry ${formatMoney(row.ad, row.cu ?? 'USD')}`;
  return 'Entry price not listed';
}

/** "42 mi, about 55 min", or "" when the distance is not known. */
export function distanceText(miles: number | null, minutes: number | null, unit: DistanceUnit): string {
  if (miles === null || minutes === null) return '';
  return `${formatDistance(miles, unit)}, ${formatDriveTime(minutes)}`;
}

/** The vendors note for a row: "Vendors: tables open, from $90, apply by Nov 3". Empty when nothing is known. */
export function vendorNote(row: IndexRow): string {
  if (!row.vs) return '';
  if (row.vs === 'unknown') {
    const bits = [];
    if (row.vp !== undefined) bits.push(`tables from ${formatMoney(row.vp, row.cu ?? 'USD')}`);
    if (row.vd) bits.push(`apply by ${formatMonthDay(row.vd)}`);
    return bits.length ? `Vendors: ${bits.join(', ')}` : 'Vendors: info on the show page';
  }
  const bits = [VENDOR_STATUS_LABEL[row.vs].toLowerCase()];
  if (row.vs === 'open' || row.vs === 'waitlist') {
    if (row.vp !== undefined) bits.push(`from ${formatMoney(row.vp, row.cu ?? 'USD')}`);
    if (row.vd) bits.push(`apply by ${formatMonthDay(row.vd)}`);
  }
  return `Vendors: ${bits.join(', ')}`;
}
