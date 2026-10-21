// The forms on the Plan page and how they become planner options.
import type { PresetName } from '../../../planner/src/factors.ts';
import type { ExchangeRates, Place } from '../../../planner/src/types.ts';
import type { SeasonOptions } from '../../../planner/src/season.ts';
import type { WeekendRunOptions } from '../../../planner/src/weekend.ts';
import type { Plan } from '../../../planner/src/vending.ts';
import { addDays, isISODate, weekday } from './dates.ts';
import type { VendorSettings } from './settings.ts';
import { DEFAULT_WEIGHT, sanitizeWeight, type WeightPreset } from './weights.ts';

export interface PlanPlace {
  lat: number;
  lon: number;
  /** what to show the person: "08837" or "your location" */
  label: string;
  country: 'US' | 'CA' | null;
}

export type TravelMode = 'vending' | 'shopping';

export interface WeekendForm {
  mode: TravelMode;
  start: string;
  end: string;
  /** null means home */
  startPlace: PlanPlace | null;
  /** end where the trip started */
  endSame: boolean;
  /** used when `endSame` is false; null means home */
  endPlace: PlanPlace | null;
  overnight: 'stay' | 'home';
  /** null means the number in settings */
  maxDriveHours: number | null;
  /** null means what the settings say you sell */
  sells: string[] | null;
  weights: WeightPreset;
  mustIncludeId: string | null;
  /** shopping only: minutes at each show */
  dwellMinutes: number;
}

export type SeasonSpan = '3m' | '6m' | 'custom';

export interface SeasonForm {
  span: SeasonSpan;
  /** used when span is custom */
  start: string;
  end: string;
  blackout: string[];
  weekendsOnly: boolean;
  fridayCounts: boolean;
  maxShowsPerMonth: number | null;
  maxNightsAway: number | null;
  /** chain shows into longer trips; false means go home between shows */
  chain: boolean;
  /** keep shows whose application deadline passed, marked "waitlist only" */
  keepPastDeadline: boolean;
  maxDriveHours: number | null;
  sells: string[] | null;
  weights: WeightPreset;
  startPlace: PlanPlace | null;
}

/** Numbers typed into the plan itself (table fee, hotel, fuel price) for this plan only. */
export interface PlanOverrides {
  tableFees: Record<string, number>;
  hotel: number | null;
  fuelPrice: number | null;
}

export const NO_OVERRIDES: PlanOverrides = { tableFees: {}, hotel: null, fuelPrice: null };

export function hasOverrides(o: PlanOverrides): boolean {
  return Object.keys(o.tableFees).length > 0 || o.hotel !== null || o.fuelPrice !== null;
}

/** The coming Friday through Sunday: today's Friday, or the next one from Saturday on. */
export function comingWeekend(today: string): { start: string; end: string } {
  const w = weekday(today);
  const toFriday = w === 5 ? 0 : (5 - w + 7) % 7;
  const start = addDays(today, toFriday);
  return { start, end: addDays(start, 2) };
}

export function defaultWeekendForm(today: string): WeekendForm {
  const { start, end } = comingWeekend(today);
  return {
    mode: 'vending',
    start,
    end,
    startPlace: null,
    endSame: true,
    endPlace: null,
    overnight: 'stay',
    maxDriveHours: null,
    sells: null,
    weights: DEFAULT_WEIGHT,
    mustIncludeId: null,
    dwellMinutes: 90,
  };
}

export function defaultSeasonForm(today: string): SeasonForm {
  return {
    span: '3m',
    start: today,
    end: addDays(today, 90),
    blackout: [],
    weekendsOnly: true,
    fridayCounts: false,
    maxShowsPerMonth: 4,
    maxNightsAway: 3,
    chain: true,
    keepPastDeadline: false,
    maxDriveHours: null,
    sells: null,
    weights: DEFAULT_WEIGHT,
    startPlace: null,
  };
}

/** The dates a season form covers. */
export function seasonRange(form: SeasonForm, today: string): { start: string; end: string } {
  if (form.span === '3m') return { start: today, end: addDays(today, 90) };
  if (form.span === '6m') return { start: today, end: addDays(today, 182) };
  return { start: form.start, end: form.end };
}

// ---------- reading saved forms ----------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, min: number, max: number): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null);
const strList = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 60) : null);

function cleanPlace(v: unknown): PlanPlace | null {
  if (!isObj(v) || typeof v.lat !== 'number' || typeof v.lon !== 'number' || Math.abs(v.lat) > 90 || Math.abs(v.lon) > 180) return null;
  return { lat: v.lat, lon: v.lon, label: typeof v.label === 'string' ? v.label.slice(0, 40) : 'your place', country: v.country === 'CA' ? 'CA' : v.country === 'US' ? 'US' : null };
}

export function sanitizeWeekendForm(raw: unknown, today: string): WeekendForm {
  const d = defaultWeekendForm(today);
  if (!isObj(raw)) return d;
  const start = typeof raw.start === 'string' && isISODate(raw.start) && raw.start >= today ? raw.start : d.start;
  const end = typeof raw.end === 'string' && isISODate(raw.end) && raw.end >= start ? raw.end : addDays(start, 2);
  return {
    mode: raw.mode === 'shopping' ? 'shopping' : 'vending',
    start,
    end,
    startPlace: cleanPlace(raw.startPlace),
    endSame: raw.endSame !== false,
    endPlace: cleanPlace(raw.endPlace),
    overnight: raw.overnight === 'home' ? 'home' : 'stay',
    maxDriveHours: num(raw.maxDriveHours, 1, 16),
    sells: strList(raw.sells),
    weights: sanitizeWeight(raw.weights),
    mustIncludeId: null, // never remembered: it comes from the link that opened the page
    dwellMinutes: num(raw.dwellMinutes, 15, 480) ?? 90,
  };
}

export function sanitizeSeasonForm(raw: unknown, today: string): SeasonForm {
  const d = defaultSeasonForm(today);
  if (!isObj(raw)) return d;
  const start = typeof raw.start === 'string' && isISODate(raw.start) ? raw.start : d.start;
  const end = typeof raw.end === 'string' && isISODate(raw.end) && raw.end >= start ? raw.end : d.end;
  const whole = (v: unknown, max: number): number | null => {
    const n = num(v, 0, max);
    return n === null ? null : Math.round(n);
  };
  return {
    span: raw.span === '6m' || raw.span === 'custom' ? raw.span : '3m',
    start,
    end,
    blackout: Array.isArray(raw.blackout) ? [...new Set(raw.blackout.filter((x): x is string => typeof x === 'string' && isISODate(x)))].sort().slice(0, 120) : [],
    weekendsOnly: raw.weekendsOnly !== false,
    fridayCounts: raw.fridayCounts === true,
    maxShowsPerMonth: 'maxShowsPerMonth' in raw ? whole(raw.maxShowsPerMonth, 60) : d.maxShowsPerMonth,
    maxNightsAway: 'maxNightsAway' in raw ? whole(raw.maxNightsAway, 30) : d.maxNightsAway,
    chain: raw.chain !== false,
    keepPastDeadline: raw.keepPastDeadline === true,
    maxDriveHours: num(raw.maxDriveHours, 1, 16),
    sells: strList(raw.sells),
    weights: sanitizeWeight(raw.weights),
    startPlace: cleanPlace(raw.startPlace),
  };
}

// ---------- from form to settings and options ----------

/** The saved vendor settings with this plan's own edits applied. */
export function settingsForPlan(
  base: VendorSettings,
  form: { maxDriveHours: number | null; sells: string[] | null },
  overrides: PlanOverrides,
): VendorSettings {
  return {
    ...base,
    hotelPerNight: overrides.hotel ?? base.hotelPerNight,
    fuelPrice: overrides.fuelPrice ?? base.fuelPrice,
    maxDrivingHoursPerDay: form.maxDriveHours ?? base.maxDrivingHoursPerDay,
    sells: form.sells ?? base.sells,
  };
}

export interface BuildContext {
  today: string;
  rates?: ExchangeRates | null;
  labels?: Record<string, string>;
  knownLegs?: WeekendRunOptions['knownLegs'];
  /** the home point from the settings, used when the form has no place of its own */
  home: { lat: number; lon: number } | null;
}

const toPlace = (p: PlanPlace): Place => ({ lat: p.lat, lon: p.lon, name: p.label });

export function buildWeekendOptions(form: WeekendForm, ctx: BuildContext, extra: { onlyIds?: string[]; skipIds?: string[]; alternatives?: number } = {}): WeekendRunOptions {
  const start = form.startPlace ? toPlace(form.startPlace) : ctx.home ? { ...ctx.home, name: 'Home' } : undefined;
  const end = form.endSame ? undefined : form.endPlace ? toPlace(form.endPlace) : ctx.home ? { ...ctx.home, name: 'Home' } : undefined;
  const o: WeekendRunOptions = {
    mode: form.mode,
    dates: { start: form.start, end: form.end },
    overnight: form.overnight,
    alternatives: extra.alternatives ?? 3,
    today: ctx.today,
    weights: form.weights as PresetName,
  };
  if (start) o.start = start;
  if (end) o.end = end;
  if (ctx.rates && Object.keys(ctx.rates).length > 0) o.rates = ctx.rates;
  if (ctx.labels) o.labels = ctx.labels;
  if (ctx.knownLegs) o.knownLegs = ctx.knownLegs;
  if (form.mode === 'shopping') {
    o.dwellMinutes = form.dwellMinutes;
    if (form.sells && form.sells.length > 0) o.interests = form.sells;
  }
  if (extra.onlyIds) o.onlyIds = extra.onlyIds;
  if (extra.skipIds && extra.skipIds.length > 0) o.skipIds = extra.skipIds;
  return o;
}

export function buildSeasonOptions(form: SeasonForm, ctx: BuildContext, extra: { onlyIds?: string[] } = {}): SeasonOptions {
  const o: SeasonOptions = {
    range: seasonRange(form, ctx.today),
    blackout: form.blackout,
    weekendsOnly: form.weekendsOnly,
    fridayIsWeekend: form.weekendsOnly && form.fridayCounts,
    maxShowsPerMonth: form.maxShowsPerMonth,
    maxNightsAway: form.maxNightsAway,
    chain: form.chain,
    keepPastDeadline: form.keepPastDeadline,
    today: ctx.today,
    weights: form.weights as PresetName,
  };
  if (ctx.rates && Object.keys(ctx.rates).length > 0) o.rates = ctx.rates;
  if (ctx.labels) o.labels = ctx.labels;
  if (ctx.knownLegs) o.knownLegs = ctx.knownLegs;
  if (extra.onlyIds) o.onlyIds = extra.onlyIds;
  return o;
}

// ---------- rows with the vendor's edited table fees ----------

import type { PlannerShow } from './planner-rows.ts';

/** The planner rows with table fees the vendor typed in. Rows that are not edited are reused as they are. */
export function applyTableFees(rows: PlannerShow[], fees: Record<string, number>): PlannerShow[] {
  if (Object.keys(fees).length === 0) return rows;
  return rows.map((r) => {
    const fee = fees[r.id];
    if (fee === undefined) return r;
    const vendor = r.vendor ?? { min_table_price: null, currency: null, deadline: null, status: 'unknown' as const };
    return { ...r, vendor: { ...vendor, min_table_price: fee } };
  });
}

/** Plans listed best first: the best plan, then each alternative. */
export function planIds(plans: Plan[]): string[] {
  return plans.flatMap((p) => p.stops.map((s) => s.showId));
}

export { DEFAULT_WEIGHT };
