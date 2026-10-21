// Running a plan through the planner (normally a Web Worker) and shaping what comes back for the page.
import type { PlannerCalls, RequestType } from '../../../planner/src/protocol.ts';
import type { Excluded } from '../../../planner/src/candidates.ts';
import type { SeasonOptions } from '../../../planner/src/season.ts';
import type { VendorSettings as PlannerSettings } from '../../../planner/src/types.ts';
import type { Plan } from '../../../planner/src/vending.ts';
import type { WeekendRunOptions } from '../../../planner/src/weekend.ts';

/** Anything that can make planner calls: the worker client, or a plain function in tests. */
export interface PlannerCaller {
  call<K extends RequestType>(type: K, args: PlannerCalls[K]['args']): Promise<PlannerCalls[K]['result']>;
}

export type PlanKind = 'weekend' | 'season';

export interface PlanEntry {
  /** stable within one run */
  id: string;
  plan: Plan;
  role: 'best' | 'alternative' | 'forced' | 'season';
}

export interface RunOutput {
  kind: PlanKind;
  mode: 'vending' | 'shopping';
  plans: PlanEntry[];
  excluded: Excluded[];
  warnings: string[];
  /** plain notes for the top of the results */
  notices: string[];
  candidates: number;
  /** the options this run used, so "check real drive times" can plan the same thing again */
  options: WeekendRunOptions | SeasonOptions;
  settings: PlannerSettings;
  ms: number;
}

export interface WeekendRunInput {
  settings: PlannerSettings;
  options: WeekendRunOptions;
  /** a show that has to be in the plan, from a link on a show page */
  mustInclude?: { id: string; name: string } | null;
}

/**
 * A weekend run. When a must include show is given and the planner's best plans leave it out, a plan
 * with just that show is added first and the reason is said plainly. (The planner has no
 * "force this show" switch, so this is done by planning that show on its own.)
 */
export async function runWeekend(planner: PlannerCaller, input: WeekendRunInput): Promise<RunOutput> {
  const { settings, options, mustInclude } = input;
  const res = await planner.call('weekendRun', { settings, options });
  const plans: PlanEntry[] = [];
  if (res.best) plans.push({ id: 'best', plan: res.best, role: 'best' });
  res.alternatives.forEach((p, i) => plans.push({ id: `alt-${i + 1}`, plan: p, role: 'alternative' }));
  const notices: string[] = [];

  if (mustInclude) {
    const has = (p: Plan) => p.stops.some((s) => s.showId === mustInclude.id);
    const withIt = plans.filter((e) => has(e.plan));
    if (withIt.length > 0 && !has(plans[0]?.plan as Plan)) {
      // plans that include the show first
      plans.sort((a, b) => Number(has(b.plan)) - Number(has(a.plan)));
      notices.push(`The best plan for these dates does not include ${mustInclude.name}. Plans that do are listed first.`);
    } else if (withIt.length === 0) {
      // planned by score, so a show that is expected to lose money is still planned (and says so)
      const alone = await planner.call('weekendRun', { settings, options: { ...options, onlyIds: [mustInclude.id], alternatives: 0, objective: 'score' } });
      const why = res.excluded.find((x) => x.id === mustInclude.id)?.reason;
      if (alone.best) {
        plans.unshift({ id: 'forced', plan: { ...alone.best, title: `Just ${mustInclude.name}`, note: 'The best plans for these dates leave this show out, so here it is on its own.' }, role: 'forced' });
        notices.push(`The best plans for these dates do not include ${mustInclude.name}${why ? ` (${why.replace(/\.$/, "")})` : ''}. A plan with only that show comes first.`);
      } else {
        const reason = alone.excluded.find((x) => x.id === mustInclude.id)?.reason ?? why ?? alone.warnings[0];
        notices.push(`${mustInclude.name} cannot be planned for these dates${reason ? `: ${reason.replace(/\.$/, '')}` : ''}.`);
      }
    }
  }
  return {
    kind: 'weekend',
    mode: res.mode,
    plans,
    excluded: res.excluded,
    warnings: res.warnings,
    notices,
    candidates: res.candidates,
    options,
    settings,
    ms: res.ms,
  };
}

export interface SeasonRunInput {
  settings: PlannerSettings;
  options: SeasonOptions;
}

export async function runSeason(planner: PlannerCaller, input: SeasonRunInput): Promise<RunOutput> {
  const res = await planner.call('season', { settings: input.settings, options: input.options });
  return {
    kind: 'season',
    mode: 'vending',
    plans: res.plan.stops.length > 0 ? [{ id: 'season', plan: res.plan, role: 'season' }] : [],
    excluded: res.excluded,
    warnings: res.warnings,
    notices: [],
    candidates: res.stats.candidates,
    options: input.options,
    settings: input.settings,
    ms: res.stats.ms,
  };
}

// ---------- exchange rates ----------

/** Currencies the planner left shows out for ("Table price is in CAD. Add an exchange rate to include it."). */
export function currenciesNeedingRate(excluded: Excluded[], vendorCurrency: string): string[] {
  const found = new Set<string>();
  for (const x of excluded) {
    if (!/exchange rate/i.test(x.reason)) continue;
    const m = /\bin ([A-Z]{3})\b/.exec(x.reason);
    if (m && m[1] !== vendorCurrency) found.add(m[1] as string);
  }
  return [...found].sort();
}

/** "CAD_USD" for one Canadian dollar in US dollars. */
export function rateKey(from: string, to: string): string {
  return `${from}_${to}`;
}

export function sanitizeRates(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (/^[A-Z]{3}_[A-Z]{3}$/.test(k) && typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1000) out[k] = v;
    }
  }
  return out;
}

/** Drop a plan's alternatives that are the same set of shows as the best plan (a safety net; the planner already does this). */
export function distinctPlans(entries: PlanEntry[]): PlanEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    const key = e.plan.stops.map((s) => s.showId).join('|');
    if (seen.has(key) && e.role !== 'forced') return false;
    seen.add(key);
    return true;
  });
}
