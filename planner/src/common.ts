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
import type { Objective } from './vending.js';

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
}

export interface Resolved {
  today: string;
  rates: ExchangeRates | null;
  rules: PlanningRules;
  travel: Travel;
  profitModel: ProfitModel;
  objective: Objective;
  weights: ReturnType<typeof resolveWeights>;
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
  return {
    today,
    rates: o.rates ?? null,
    rules,
    travel: new Travel(o.travel, o.knownLegs),
    profitModel: resolveProfitModel(o.profitModel),
    objective,
    weights: resolveWeights(o.weights),
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
