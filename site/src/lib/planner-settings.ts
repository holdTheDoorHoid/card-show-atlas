// The glue between the vendor settings saved in the browser (src/lib/settings.ts) and the settings
// the route planner wants (planner/src/types.ts). The planner needs a few numbers that the form
// lets people leave empty, so this decides what to do about each one:
//
//   * Anything needed for a profit estimate that is missing goes on a list ("missing"), and the plan
//     is made by priority score instead (the planner's `objective: 'score'`).
//   * The planner's engine always wants a fuel economy and price, a hotel price and food money. When
//     they are not filled in, realistic placeholders are used and listed on the plan, so planning by
//     priority score still works and a hotel never looks free.
import type { SeriesHistory, VendorSettings as PlannerSettings } from '../../../planner/src/types.ts';
import type { MyShowsStore } from './myshows.ts';
import type { VendorSettings } from './settings.ts';

export interface MissingSetting {
  key: 'home' | 'fuelEconomy' | 'fuelPrice' | 'hotel' | 'food' | 'sales' | 'margin';
  /** "Fuel economy" */
  label: string;
  /** the id of the field on the My shows page, so a link can jump to it */
  fieldId: string;
  /** what it is needed for */
  needed: 'plan' | 'profit';
}

export interface PlannerSettingsResult {
  settings: PlannerSettings;
  /** settings still empty, in the order of the form */
  missing: MissingSetting[];
  /** true when everything a profit estimate needs is filled in */
  profit: boolean;
  /** plain notes about placeholder numbers that were used so planning could go ahead */
  placeholders: string[];
  hasHome: boolean;
}

/** Placeholders used only when planning by score and the real number is missing. */
export const PLACEHOLDER_MPG = 20;
export const PLACEHOLDER_L_PER_100KM = 10;
export const PLACEHOLDER_GALLON_PRICE = 3.5;
export const PLACEHOLDER_LITRE_PRICE = 1.8;
/** A night in a plain hotel, and a day of food on the road, by currency. */
export const PLACEHOLDER_HOTEL: Record<'USD' | 'CAD', number> = { USD: 140, CAD: 180 };
export const PLACEHOLDER_FOOD: Record<'USD' | 'CAD', number> = { USD: 35, CAD: 45 };

/** The hotel and food numbers a plan uses: the vendor's own, or the placeholders. */
export function hotelFor(s: VendorSettings): { amount: number; placeholder: boolean } {
  return s.hotelPerNight !== null ? { amount: s.hotelPerNight, placeholder: false } : { amount: PLACEHOLDER_HOTEL[s.currency], placeholder: true };
}

export function foodFor(s: VendorSettings): { amount: number; placeholder: boolean } {
  return s.foodPerDay !== null ? { amount: s.foodPerDay, placeholder: false } : { amount: PLACEHOLDER_FOOD[s.currency], placeholder: true };
}

export interface PlannerSettingsOptions {
  /** where trips start and end, when the settings have no home (a ZIP typed on the Plan page) */
  home?: { lat: number; lon: number; name?: string } | null;
  /** the vendor's own results, by series id */
  history?: Record<string, SeriesHistory>;
}

export function missingSettings(s: VendorSettings, hasHome: boolean): MissingSetting[] {
  const out: MissingSetting[] = [];
  if (!hasHome) out.push({ key: 'home', label: 'Home postal code', fieldId: 'home-postal', needed: 'plan' });
  if (s.fuelEconomy === null) out.push({ key: 'fuelEconomy', label: 'Fuel economy', fieldId: 'fuel-economy', needed: 'profit' });
  if (s.fuelPrice === null) out.push({ key: 'fuelPrice', label: 'Fuel price', fieldId: 'fuel-price', needed: 'profit' });
  if (s.hotelPerNight === null) out.push({ key: 'hotel', label: 'Hotel per night', fieldId: 'hotel', needed: 'profit' });
  if (s.foodPerDay === null) out.push({ key: 'food', label: 'Food per day', fieldId: 'food', needed: 'profit' });
  const t = s.typicalSales;
  if (t.small === null || t.medium === null || t.large === null || t.major === null) {
    out.push({ key: 'sales', label: 'Typical sales for all four show sizes', fieldId: 'sales-small', needed: 'profit' });
  }
  if (s.marginPercent === null) out.push({ key: 'margin', label: 'Margin on sales', fieldId: 'margin', needed: 'profit' });
  return out;
}

export function toPlannerSettings(s: VendorSettings, opts: PlannerSettingsOptions = {}): PlannerSettingsResult {
  const homePoint =
    s.home.lat !== null && s.home.lon !== null ? { lat: s.home.lat, lon: s.home.lon, name: 'Home' } : opts.home ? { lat: opts.home.lat, lon: opts.home.lon, name: opts.home.name ?? 'Home' } : null;
  const hasHome = homePoint !== null;
  const missing = missingSettings(s, hasHome);
  const profit = !missing.some((m) => m.needed === 'profit');
  const placeholders: string[] = [];
  const metric = s.fuelEconomyUnit === 'l_per_100km';

  let economy = s.fuelEconomy;
  if (economy === null) {
    economy = metric ? PLACEHOLDER_L_PER_100KM : PLACEHOLDER_MPG;
    placeholders.push(`fuel economy ${economy} ${metric ? 'litres per 100 km' : 'mpg'}`);
  }
  let price = s.fuelPrice;
  if (price === null) {
    price = metric ? PLACEHOLDER_LITRE_PRICE : PLACEHOLDER_GALLON_PRICE;
    placeholders.push(`fuel price ${price} a ${metric ? 'litre' : 'gallon'}`);
  }
  const hotel = hotelFor(s);
  const food = foodFor(s);
  if (hotel.placeholder) placeholders.push(`hotel ${hotel.amount} ${s.currency} a night`);
  if (food.placeholder) placeholders.push(`food ${food.amount} ${s.currency} a day`);

  const t = s.typicalSales;
  const typical =
    profit && t.small !== null && t.medium !== null && t.large !== null && t.major !== null
      ? { small: t.small, medium: t.medium, large: t.large, major: t.major }
      : null;

  const settings: PlannerSettings = {
    home: homePoint,
    currency: s.currency,
    mpg: metric ? null : economy,
    l_per_100km: metric ? economy : null,
    fuel_price: { amount: price, unit: metric ? 'litre' : 'gallon', currency: s.currency },
    hotel_per_night: hotel.amount,
    food_per_day: food.amount,
    max_drive_hours_per_day: s.maxDrivingHoursPerDay,
    typical_sales: typical,
    margin_percent: s.marginPercent ?? 0,
    sells: [...s.sells],
  };
  if (s.timeValuePerHour !== null && s.timeValuePerHour > 0) settings.time_value_per_hour = s.timeValuePerHour;
  if (opts.history && Object.keys(opts.history).length > 0) settings.history = opts.history;
  return { settings, missing, profit, placeholders, hasHome };
}

/**
 * The vendor's own results by series, from My shows: every show with sales entered counts as a past
 * edition, and "would do again" becomes the rating (the average of the shows that have one).
 * `seriesIdOf` finds a show's series, which My shows does not keep itself.
 */
export function historyFromMyShows(store: MyShowsStore, seriesIdOf: (showId: string) => string | null): Record<string, SeriesHistory> {
  const bySeries = new Map<string, { sales: number[]; ratings: number[] }>();
  for (const e of Object.values(store.shows)) {
    if (e.grossSales === null && e.wouldDoAgain === null) continue;
    const series = seriesIdOf(e.id);
    if (!series) continue;
    const entry = bySeries.get(series) ?? { sales: [], ratings: [] };
    if (e.grossSales !== null) entry.sales.push(e.grossSales);
    if (e.wouldDoAgain !== null) entry.ratings.push(e.wouldDoAgain);
    bySeries.set(series, entry);
  }
  const out: Record<string, SeriesHistory> = {};
  for (const [series, v] of bySeries) {
    out[series] = {
      gross_sales: v.sales,
      rating: v.ratings.length > 0 ? Math.round((v.ratings.reduce((a, b) => a + b, 0) / v.ratings.length) * 10) / 10 : null,
    };
  }
  return out;
}

/** The series id from a show id of the form `<series>-<YYYY-MM-DD>`, for shows that left the data. */
export function seriesFromShowId(id: string): string | null {
  const m = /^(.*)-\d{4}-\d{2}-\d{2}$/.exec(id);
  return m ? (m[1] as string) : null;
}
