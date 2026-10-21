/**
 * Season planner (DESIGN 6.4): the best set of shows across a date range, each trip starting and
 * ending at home, never two at once, within the vendor's rules. Uses the same exact engine as the
 * weekend run (see `vending.ts`), with a per month show cap and a limit on nights away in a row.
 */
import { filterCandidates, type Candidate, type Excluded } from './candidates.js';
import { checkPlace, checkRange, resolveCommon, type CommonPlanOptions } from './common.js';
import { buildPriceContext } from './factors.js';
import { formatDuration } from './format.js';
import type { ProfitEstimate } from './profit.js';
import { epochDay } from './time.js';
import type { PlannerShow, VendorSettings } from './types.js';
import { PlannerError } from './types.js';
import { describeVending, VendingEngine, type Deadline, type Plan } from './vending.js';

export interface SeasonOptions extends CommonPlanOptions {
  range: { start: string; end: string };
  /** Days you cannot be away from home at all (no shows and no travel). */
  blackout?: string[];
  weekendsOnly?: boolean;
  /** With `weekendsOnly`, also allow Friday. Default false. */
  fridayIsWeekend?: boolean;
  /** Most shows in one calendar month (a show counts in the month it starts). */
  maxShowsPerMonth?: number | null;
  /** Longest stretch away from home, in nights in a row. */
  maxNightsAway?: number | null;
  /** True (default): shows may be chained into longer trips. False: go home between shows. */
  chain?: boolean;
  /** Straight drives between two shows are considered only up to this many days apart. Default 7. */
  maxChainGapDays?: number;
  /** Leave out shows farther than this many hours from home. */
  maxDriveHoursFromHome?: number;
}

export interface SeasonResult {
  plan: Plan;
  /** Application deadlines for the chosen shows, soonest first. */
  deadlines: Deadline[];
  totals: {
    currency: string;
    shows: number;
    trips: number;
    hotelNights: number;
    miles: number;
    driveHours: number;
    /** Same object as `plan.money`. */
    money: ProfitEstimate;
  };
  excluded: Excluded[];
  warnings: string[];
  stats: { candidates: number; labels: number; edges: number; ms: number };
}

const MAX_SEASON_DAYS = 400;

export function planSeason(shows: PlannerShow[], settings: VendorSettings, options: SeasonOptions): SeasonResult {
  const t0 = Date.now();
  if (!options || !options.range) throw new PlannerError('bad_date', 'Pick a start and end date.');
  checkRange(options.range.start, options.range.end);
  if (epochDay(options.range.end) - epochDay(options.range.start) + 1 > MAX_SEASON_DAYS) {
    throw new PlannerError('season_too_long', 'A season plan can cover up to about 13 months.');
  }
  const home = settings.home;
  checkPlace(home, 'your home location in settings');
  for (const [k, v] of [
    ['Shows per month', options.maxShowsPerMonth],
    ['Nights away in a row', options.maxNightsAway],
  ] as const) {
    if (v !== null && v !== undefined && !(Number.isInteger(v) && v >= 0)) {
      throw new PlannerError('bad_option', `${k} must be a whole number, zero or more.`);
    }
  }
  const r = resolveCommon(settings, options);
  const { kept, excluded } = filterCandidates(shows, {
    rangeStart: options.range.start,
    rangeEnd: options.range.end,
    today: r.today,
    purpose: 'vending',
    blackout: options.blackout,
    weekendsOnly: options.weekendsOnly,
    fridayIsWeekend: options.fridayIsWeekend,
    keepPastDeadline: options.keepPastDeadline,
    includeStoreEvents: options.includeStoreEvents,
    skipIds: options.skipIds,
    onlyIds: options.onlyIds,
  });
  let candidates = kept;
  if (typeof options.maxDriveHoursFromHome === 'number') {
    const limit = options.maxDriveHoursFromHome;
    candidates = [];
    for (const c of kept) {
      if (r.travel.leg(home, c.show).hours <= limit + 1e-9) candidates.push(c);
      else excluded.push({ id: c.show.id, name: c.show.name, reason: `More than ${formatDuration(limit)} from home` });
    }
  }
  const engine = seasonEngine(candidates, shows, settings, options, r);
  const sol = engine.solve();
  const plan = describeVending(engine, sol, 'Season plan');
  const warnings = [...engine.warnings, ...plan.warnings];
  if (plan.stops.length === 0) {
    warnings.push(
      candidates.length === 0
        ? 'No shows match your dates and rules.'
        : r.objective === 'profit'
          ? 'No show fits your rules and is expected to pay for itself.'
          : 'No show fits your rules.',
    );
  }
  if (r.objective === 'score') {
    warnings.push('Planned by priority score because typical sales are not set. Add them to plan by expected profit.');
  }
  return {
    plan,
    deadlines: plan.deadlines,
    totals: {
      currency: plan.money.currency,
      shows: plan.stops.length,
      trips: plan.trips.length,
      hotelNights: plan.hotelNights,
      miles: plan.miles,
      driveHours: plan.driveHours,
      money: plan.money,
    },
    excluded: [...excluded, ...engine.excluded],
    warnings: [...new Set(warnings)],
    stats: { candidates: engine.nodes.length, labels: sol.stats.labels, edges: sol.stats.edges, ms: Date.now() - t0 },
  };
}

/** The engine the season planner uses. Exposed for tests. */
export function seasonEngine(
  candidates: Candidate[],
  shows: PlannerShow[],
  settings: VendorSettings,
  options: SeasonOptions,
  r: ReturnType<typeof resolveCommon>,
): VendingEngine {
  const home = settings.home!;
  const maxNights = options.maxNightsAway ?? null;
  return new VendingEngine({
    candidates,
    allShows: shows,
    settings,
    base: home,
    end: home,
    rangeStart: options.range.start,
    rangeEnd: options.range.end,
    tripWithinRange: false,
    overnight: 'stay',
    chain: options.chain ?? true,
    maxNightsAway: maxNights,
    countCap: options.maxShowsPerMonth ?? null,
    countReset: 'month',
    blackout: options.blackout ?? [],
    objective: r.objective,
    rules: r.rules,
    travel: r.travel,
    rates: r.rates,
    profitModel: r.profitModel,
    weights: r.weights,
    priceContext: buildPriceContext(candidates.map((c) => c.show), settings, r.rates),
    labels: options.labels,
    maxChainGapDays: options.maxChainGapDays ?? 7,
    travelSlackDays: travelSlack(maxNights),
    minScore: options.minScore ?? 0,
    travelHalfLifeHours: 2,
    penalties: r.penalties,
  });
}

export function travelSlack(maxNights: number | null): number {
  return Math.max(2, Math.min(7, maxNights ?? 7));
}
