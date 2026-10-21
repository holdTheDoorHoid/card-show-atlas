import { resolveCommon } from '../src/common.js';
import { filterCandidates } from '../src/candidates.js';
import { seasonEngine, travelSlack, type SeasonOptions } from '../src/season.js';
import { epochDay } from '../src/time.js';
import type { PlannerShow, VendorSettings, VendorStatus } from '../src/types.js';
import { weekendEngine, type WeekendRunOptions } from '../src/weekend.js';
import type { BruteVendingOptions } from './brute.js';

export const PHILLY = { lat: 39.9526, lon: -75.1652 };

export interface MkOptions {
  days: [string, string | null, string | null][];
  lat: number;
  lon: number;
  tz?: string;
  price?: number | null;
  currency?: string;
  status?: VendorStatus;
  deadline?: string | null;
  size?: 'small' | 'medium' | 'large' | 'major';
  mid?: number;
  tpt?: number;
  sells?: string[];
  setup?: string | null;
  series?: string;
  city?: string;
  country?: string;
  free?: boolean;
  adult?: number | null;
}

export function mk(id: string, o: MkOptions): PlannerShow {
  const mid = o.mid ?? 800;
  return {
    id,
    series_id: o.series ?? id,
    name: id.replace(/-/g, ' '),
    event_type: 'card_show',
    status: 'scheduled',
    days: o.days.map(([date, open, close]) => ({ date, open, close })),
    timezone: o.tz ?? 'America/New_York',
    lat: o.lat,
    lon: o.lon,
    city: o.city ?? id,
    region: 'PA',
    country: o.country ?? 'US',
    sells: o.sells ?? ['pokemon'],
    estimate: { attendance: { low: mid * 0.6, mid, high: mid * 1.5 }, size_class: o.size ?? 'medium', traffic_per_table: o.tpt ?? 6, confidence: 'estimated' },
    size: { tables: 100 },
    vendor: {
      min_table_price: o.price === undefined ? 100 : o.price,
      currency: o.currency ?? 'USD',
      deadline: o.deadline ?? null,
      status: o.status ?? 'open',
      setup: o.setup ?? null,
    },
    admission: { free: o.free ?? false, adult: o.adult === undefined ? 5 : o.adult, currency: o.currency ?? 'USD' },
  };
}

export function vendor(over: Partial<VendorSettings> = {}): VendorSettings {
  return {
    home: { ...PHILLY, timezone: 'America/New_York' },
    currency: 'USD',
    mpg: 25,
    fuel_price: { amount: 3.5, unit: 'gallon', currency: 'USD' },
    hotel_per_night: 120,
    food_per_day: 40,
    max_drive_hours_per_day: 8,
    typical_sales: { small: 500, medium: 1000, large: 2000, major: 4000 },
    margin_percent: 50,
    sells: ['pokemon'],
    ...over,
  };
}

export function weekendSetup(shows: PlannerShow[], settings: VendorSettings, options: WeekendRunOptions) {
  const r = resolveCommon(settings, options);
  const { kept } = filterCandidates(shows, {
    rangeStart: options.dates.start,
    rangeEnd: options.dates.end,
    today: r.today,
    purpose: 'vending',
    blackout: options.blackout,
  });
  const start = options.start ?? settings.home!;
  const end = options.end ?? start;
  const engine = weekendEngine(kept, shows, settings, options, start, end, r);
  const brute: BruteVendingOptions = {
    homeOnly: options.overnight === 'home',
    chain: true,
    countCap: options.maxShows ?? null,
    countReset: 'never',
    maxNights: null,
    maxGap: 14,
    hStart: epochDay(options.dates.start) - 1,
    hEnd: epochDay(options.dates.end),
    tripWithinRange: true,
    rangeStart: epochDay(options.dates.start),
  };
  return { engine, brute };
}

export function seasonSetup(shows: PlannerShow[], settings: VendorSettings, options: SeasonOptions) {
  const r = resolveCommon(settings, options);
  const { kept } = filterCandidates(shows, {
    rangeStart: options.range.start,
    rangeEnd: options.range.end,
    today: r.today,
    purpose: 'vending',
    blackout: options.blackout,
    weekendsOnly: options.weekendsOnly,
  });
  const engine = seasonEngine(kept, shows, settings, options, r);
  const slack = travelSlack(options.maxNightsAway ?? null);
  const maxN = options.maxNightsAway ?? null;
  const brute: BruteVendingOptions = {
    homeOnly: false,
    chain: options.chain ?? true,
    countCap: options.maxShowsPerMonth ?? null,
    countReset: 'month',
    maxNights: maxN,
    maxGap: Math.min(options.maxChainGapDays ?? 7, maxN ?? Infinity),
    hStart: epochDay(options.range.start) - 1 - slack,
    hEnd: epochDay(options.range.end) + slack,
    tripWithinRange: false,
    rangeStart: epochDay(options.range.start),
  };
  return { engine, brute };
}

/** Longest run of hotel nights in a row. */
export function longestAway(nights: { date: string; where: string }[]): number {
  let best = 0;
  let run = 0;
  let prev: number | null = null;
  for (const n of [...nights].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    const d = epochDay(n.date);
    if (n.where === 'hotel') {
      run = prev !== null && d === prev + 1 && run > 0 ? run + 1 : 1;
      best = Math.max(best, run);
    } else {
      run = 0;
    }
    prev = d;
  }
  return best;
}

/** Every string anywhere inside a value. */
export function allStrings(x: unknown, out: string[] = []): string[] {
  if (typeof x === 'string') out.push(x);
  else if (Array.isArray(x)) for (const y of x) allStrings(y, out);
  else if (x && typeof x === 'object') for (const v of Object.values(x)) allStrings(v, out);
  return out;
}
