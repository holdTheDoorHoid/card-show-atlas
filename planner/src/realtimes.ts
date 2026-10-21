/**
 * "Check real drive times" (DESIGN 6.1). Asks a route provider once for every pair of points in a
 * plan (one table request), then plans the same shows again with those drive times. If the service
 * cannot be reached, the estimate stands and the result says so.
 */
import { formatDuration } from './format.js';
import { planSeason, type SeasonOptions } from './season.js';
import type { LatLon, PlannerShow, VendorSettings } from './types.js';
import { PlannerError } from './types.js';
import type { LegMatrix, LegSource, RouteProvider } from './travel.js';
import type { Plan } from './vending.js';
import { planWeekendRun, type WeekendRunOptions } from './weekend.js';
import { haversineMiles } from './travel.js';

export type RecheckRequest =
  | { kind: 'weekend'; shows: PlannerShow[]; settings: VendorSettings; options: WeekendRunOptions }
  | { kind: 'season'; shows: PlannerShow[]; settings: VendorSettings; options: SeasonOptions };

export interface DriveTimeCheck {
  /** True when real drive times were used. */
  ok: boolean;
  source: LegSource;
  /** Plain label for the UI. */
  label: string;
  /** The plan with real drive times, or the original plan when the check failed. */
  plan: Plan | null;
  /** The table the provider returned, to pass back as `knownLegs` for later plans. */
  matrix: LegMatrix | null;
  /** "Drive to Edison, NJ is 1 h 40 min, 15 min more than estimated." */
  changes: string[];
  /** "With real drive times, Lehigh Valley Card Show no longer fits." */
  problems: string[];
}

/** Unique points of a plan in order: start, every stop, end. */
export function planPoints(plan: Plan): LatLon[] {
  const out: LatLon[] = [];
  const add = (p: LatLon) => {
    if (!out.some((q) => haversineMiles(p, q) < 1e-6)) out.push({ lat: p.lat, lon: p.lon });
  };
  add(plan.start);
  for (const s of plan.stops) add(s);
  add(plan.end);
  return out;
}

export async function checkRealDriveTimes(plan: Plan, req: RecheckRequest, provider: RouteProvider): Promise<DriveTimeCheck> {
  const points = planPoints(plan);
  let matrix: LegMatrix;
  try {
    matrix = await provider.table(points);
  } catch (e) {
    return {
      ok: false,
      source: 'estimate',
      label: 'Real drive times are not available right now, so the estimates stand.',
      plan,
      matrix: null,
      changes: [],
      problems: [e instanceof PlannerError ? e.message : 'The routing service could not be reached.'],
    };
  }
  const ids = plan.stops.map((s) => s.showId);
  const known = [matrix, ...asList(req.options.knownLegs)];
  let next: Plan | null;
  if (req.kind === 'weekend') {
    const res = planWeekendRun(req.shows, req.settings, { ...req.options, onlyIds: ids, knownLegs: known, alternatives: 0 });
    next = res.best;
  } else {
    next = planSeason(req.shows, req.settings, { ...req.options, onlyIds: ids, knownLegs: known }).plan;
  }
  const changes: string[] = [];
  const problems: string[] = [];
  const kept = new Set(next?.stops.map((s) => s.showId) ?? []);
  for (const s of plan.stops) {
    if (!kept.has(s.showId) && !problems.some((p) => p.includes(s.name))) {
      problems.push(`With real drive times, ${s.name} no longer fits.`);
    }
  }
  if (next) {
    for (const leg of next.legs) {
      const before = plan.legs.find((l) => near(l.from, leg.from) && near(l.to, leg.to));
      if (!before) continue;
      const diff = leg.hours - before.hours;
      if (Math.abs(diff) >= 10 / 60) {
        changes.push(
          `Drive to ${leg.to.name} is ${formatDuration(leg.hours)}, ${formatDuration(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} than estimated.`,
        );
      }
    }
    if (problems.length === 0) {
      changes.unshift(plan.stops.length === 1 ? 'The show still fits with real drive times.' : `All ${plan.stops.length} stops still fit with real drive times.`);
    }
  }
  return {
    ok: true,
    source: matrix.source,
    label: provider.label,
    plan: next,
    matrix,
    changes: [...new Set(changes)],
    problems,
  };
}

function near(a: LatLon, b: LatLon): boolean {
  return haversineMiles(a, b) < 1e-6;
}

function asList(x: LegMatrix | LegMatrix[] | undefined): LegMatrix[] {
  if (!x) return [];
  return Array.isArray(x) ? x : [x];
}
