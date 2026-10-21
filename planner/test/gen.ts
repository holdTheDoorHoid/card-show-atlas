/**
 * Seeded random instances for property tests and the benchmark.
 */
import { seededRandom } from '../src/shopping.js';
import { addDays } from '../src/time.js';
import type { PlannerShow, SizeClass, VendorSettings, VendorStatus } from '../src/types.js';

export type Rng = () => number;
export const rng = (seed: number): Rng => seededRandom(seed);

export const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
export const between = (r: Rng, lo: number, hi: number): number => lo + (hi - lo) * r();
export const intBetween = (r: Rng, lo: number, hi: number): number => Math.floor(between(r, lo, hi + 1));

const SELLS = ['pokemon', 'mtg', 'yugioh', 'one_piece', 'lorcana', 'baseball', 'football', 'basketball', 'hockey', 'comics'];
const SIZES: SizeClass[] = ['small', 'medium', 'large', 'major'];

export interface GenOptions {
  n: number;
  start: string;
  /** Days over which first days are spread. */
  spanDays: number;
  center: { lat: number; lon: number };
  /** Spread of positions around the center, in degrees. */
  spreadDeg: number;
  zones?: string[];
  /** Chance a show has two or three days. */
  multiDay?: number;
  statuses?: VendorStatus[];
  currency?: string;
  /** Only weekends (Saturday or Sunday first days). */
  weekendBias?: boolean;
}

function hhmm(h: number): string {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60 / 15) * 15;
  return `${String(hh + Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`;
}

export function genShows(r: Rng, o: GenOptions): PlannerShow[] {
  const shows: PlannerShow[] = [];
  for (let i = 0; i < o.n; i++) {
    let offset = intBetween(r, 0, Math.max(0, o.spanDays - 1));
    let first = addDays(o.start, offset);
    if (o.weekendBias) {
      const wd = (new Date(`${first}T00:00:00Z`).getUTCDay() + 7) % 7;
      const toSat = (6 - wd + 7) % 7;
      offset += toSat + (r() < 0.4 ? 1 : 0);
      first = addDays(o.start, offset);
    }
    const nDays = r() < (o.multiDay ?? 0.3) ? intBetween(r, 2, 3) : 1;
    const days = Array.from({ length: nDays }, (_, d) => {
      const open = between(r, 7, 11);
      const len = between(r, 3, 9);
      const unknown = r() < 0.08;
      return { date: addDays(first, d), open: unknown ? null : hhmm(open), close: unknown ? null : hhmm(Math.min(23, open + len)) };
    });
    const size = pick(r, SIZES);
    const tables = { small: intBetween(r, 10, 29), medium: intBetween(r, 30, 99), large: intBetween(r, 100, 299), major: intBetween(r, 300, 900) }[size];
    const mid = tables * between(r, 3, 20);
    const price = r() < 0.1 ? null : Math.round(between(r, 30, 120) * (size === 'major' ? 4 : size === 'large' ? 2 : 1));
    const nSells = intBetween(r, 0, 4);
    const sells = [...new Set(Array.from({ length: nSells }, () => pick(r, SELLS)))];
    const lat = o.center.lat + between(r, -o.spreadDeg, o.spreadDeg);
    const lon = o.center.lon + between(r, -o.spreadDeg * 1.3, o.spreadDeg * 1.3);
    shows.push({
      id: `show-${i}-${first}`,
      series_id: `series-${i % Math.max(1, Math.floor(o.n / 3))}`,
      name: `Show ${i}`,
      event_type: 'card_show',
      status: r() < 0.05 ? 'tentative' : 'scheduled',
      days,
      timezone: o.zones ? pick(r, o.zones) : 'America/New_York',
      lat,
      lon,
      city: `Town ${i}`,
      region: 'PA',
      country: 'US',
      sells,
      estimate: r() < 0.1 ? null : {
        attendance: { low: Math.round(mid * 0.6), mid: Math.round(mid), high: Math.round(mid * 1.5) },
        size_class: size,
        traffic_per_table: mid / tables,
        confidence: 'estimated',
      },
      size: { tables },
      vendor: {
        min_table_price: price,
        currency: o.currency ?? 'USD',
        deadline: r() < 0.7 ? addDays(first, -intBetween(r, 5, 40)) : null,
        status: o.statuses ? pick(r, o.statuses) : 'open',
        setup: r() < 0.3 ? hhmm(between(r, 6, 8)) : null,
        extras: r() < 0.2 ? intBetween(r, 10, 40) : null,
      },
      admission: { free: r() < 0.3, adult: intBetween(r, 0, 15), currency: 'USD' },
    });
  }
  return shows;
}

export function genVendor(r: Rng, home: { lat: number; lon: number }, withSales = true): VendorSettings {
  return {
    home: { ...home, timezone: 'America/New_York' },
    currency: 'USD',
    mpg: between(r, 15, 35),
    fuel_price: { amount: between(r, 2.8, 4.5), unit: 'gallon', currency: 'USD' },
    hotel_per_night: Math.round(between(r, 0, 200)),
    food_per_day: Math.round(between(r, 0, 60)),
    max_drive_hours_per_day: between(r, 2, 10),
    typical_sales: withSales
      ? { small: Math.round(between(r, 200, 800)), medium: Math.round(between(r, 600, 1500)), large: Math.round(between(r, 1200, 3000)), major: Math.round(between(r, 2500, 6000)) }
      : null,
    margin_percent: Math.round(between(r, 20, 60)),
    sells: [...new Set([pick(r, SELLS), pick(r, SELLS)])],
    extras_per_show: r() < 0.5 ? 0 : 10,
  };
}
