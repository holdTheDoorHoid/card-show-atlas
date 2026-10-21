/**
 * Option handling shared by the weekend run and the season planner.
 */
import { resolveWeights, type WeightsInput } from './factors.js';
import { resolveProfitModel, type ProfitModel } from './profit.js';
import { isValidDate, isValidTime, isValidTimeZone, todayIn } from './time.js';
import { haversineMiles, Travel, type LegMatrix, type TravelModel } from './travel.js';
import type { ExchangeRates, LatLon, Place, PlannerShow, PlanningRules, VendorSettings } from './types.js';
import { DEFAULT_RULES, PlannerError } from './types.js';
import { validateSettings } from './validate.js';
import type { Objective, Penalties } from './vending.js';

/** "How much do you mind driving?" */
export type MindDriving = 'little' | 'some' | 'lot';

/**
 * Points taken off a plan made by score (and every shopping plan) for each hour of driving and each
 * hotel night. Show scores and visit values run from 0 to 100, so with "some" an hour of driving costs
 * a tenth of a perfect show, and a 3 hour drive each way has to be worth 60 points more than staying
 * close to home.
 */
export const DRIVING_PENALTIES: Record<MindDriving, Penalties> = {
  little: { perDriveHour: 2, perHotelNight: 5 },
  some: { perDriveHour: 10, perHotelNight: 25 },
  lot: { perDriveHour: 20, perHotelNight: 50 },
};

export const MIND_DRIVING_LABELS: Record<MindDriving, string> = { little: 'A little', some: 'Some', lot: 'A lot' };

/** Options every planner accepts. */
export interface CommonPlanOptions {
  /** `YYYY-MM-DD`; defaults to today in the runtime's zone. */
  today?: string;
  /** Exchange rates the user typed in, for example `{ "CAD_USD": 0.73 }`. */
  rates?: ExchangeRates;
  rules?: Partial<PlanningRules>;
  travel?: Partial<TravelModel>;
  /** Real drive times from a plan check (see `checkRealDriveTimes`). */
  knownLegs?: LegMatrix | LegMatrix[];
  profitModel?: Partial<ProfitModel>;
  /** `auto` (default) plans by profit when typical sales are set, else by priority score. */
  objective?: 'auto' | Objective;
  weights?: WeightsInput;
  /** Display names for vocabulary ids. */
  labels?: Record<string, string>;
  keepPastDeadline?: boolean;
  includeStoreEvents?: boolean;
  skipIds?: string[];
  onlyIds?: string[];
  /** Score mode: points a show must beat to be worth a spot. Default 0. */
  minScore?: number;
  /** How much driving and hotel nights count against a plan made by score. Default `some`. */
  mindDriving?: MindDriving;
  /** Your own points per driving hour and per hotel night, instead of a `mindDriving` preset. */
  penalties?: Partial<Penalties>;
}

export interface Resolved {
  today: string;
  rates: ExchangeRates | null;
  rules: PlanningRules;
  travel: Travel;
  profitModel: ProfitModel;
  objective: Objective;
  weights: ReturnType<typeof resolveWeights>;
  /** Penalties for the vending search: points in score mode, the vendor's time value in profit mode. */
  penalties: Penalties;
  /** Penalties in points, used by shopping (always) and by score mode. */
  pointPenalties: Penalties;
}

export function resolvePointPenalties(o: CommonPlanOptions): Penalties {
  const key = o.mindDriving ?? 'some';
  const base = DRIVING_PENALTIES[key];
  if (!base) throw new PlannerError('bad_option', 'How much you mind driving must be a little, some or a lot.');
  const out: Penalties = { ...base, ...(o.penalties ?? {}) };
  for (const v of [out.perDriveHour, out.perHotelNight]) {
    if (!(typeof v === 'number' && Number.isFinite(v) && v >= 0)) {
      throw new PlannerError('bad_option', 'Driving and night penalties must be zero or more.');
    }
  }
  return out;
}

export function resolveCommon(settings: VendorSettings, o: CommonPlanOptions, needFuel = true): Resolved {
  validateSettings(settings, { needFuel });
  const rules: PlanningRules = { ...DEFAULT_RULES, ...(o.rules ?? {}) };
  for (const k of ['earliestDrive', 'latestDrive', 'defaultOpen', 'defaultClose', 'shoppingDayStart'] as const) {
    if (!isValidTime(rules[k])) throw new PlannerError('bad_rules', `"${rules[k]}" is not a time like 09:30.`);
  }
  for (const k of ['setupLeadMinutes', 'laterDayLeadMinutes', 'teardownMinutes'] as const) {
    if (!(rules[k] >= 0 && rules[k] <= 24 * 60)) throw new PlannerError('bad_rules', 'Setup and teardown times must be between 0 and 24 hours.');
  }
  const today = o.today ?? todayIn();
  if (!isValidDate(today)) throw new PlannerError('bad_date', `"${today}" is not a date like 2026-11-14.`);
  let objective: Objective;
  if (o.objective === 'profit') {
    if (!settings.typical_sales) throw new PlannerError('no_typical_sales', 'Add your typical sales in settings to plan by profit.');
    objective = 'profit';
  } else if (o.objective === 'score') {
    objective = 'score';
  } else {
    objective = settings.typical_sales ? 'profit' : 'score';
  }
  const pointPenalties = resolvePointPenalties(o);
  const penalties: Penalties =
    objective === 'profit' ? { perDriveHour: settings.time_value_per_hour ?? 0, perHotelNight: 0 } : pointPenalties;
  return {
    today,
    rates: o.rates ?? null,
    rules,
    travel: new Travel(o.travel, o.knownLegs),
    profitModel: resolveProfitModel(o.profitModel),
    objective,
    weights: resolveWeights(o.weights),
    penalties,
    pointPenalties,
  };
}

export function checkPlace(p: LatLon | null | undefined, what: string): asserts p is LatLon {
  if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) {
    throw new PlannerError('no_place', `Add ${what}.`);
  }
  const tz = (p as Place).timezone;
  if (tz && !isValidTimeZone(tz)) throw new PlannerError('bad_timezone', `The time zone for ${what} is not valid.`);
}

export function checkRange(start: string, end: string): void {
  if (!isValidDate(start) || !isValidDate(end)) throw new PlannerError('bad_date', 'Pick a start and end date.');
  if (end < start) throw new PlannerError('bad_date', 'The end date is before the start date.');
}

/** Zone of the nearest show, used when a start point has no zone of its own. */
export function nearestZone(p: LatLon, shows: PlannerShow[]): string {
  let best = 'America/New_York';
  let bestD = Infinity;
  for (const s of shows) {
    const d = haversineMiles(p, s);
    if (d < bestD && isValidTimeZone(s.timezone)) {
      bestD = d;
      best = s.timezone;
    }
  }
  return best;
}
