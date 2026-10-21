// "Best for my table" on the Find page: the planner's vendor priority score for each show.
import type { VendorScore } from '../../../planner/src/scoring.ts';
import type { VendorSettings as PlannerSettings } from '../../../planner/src/types.ts';
import type { PlannerCaller } from './plan-run.ts';
import type { WeightPreset } from './weights.ts';

export interface VendorRowInfo {
  /** 0 to 100, or null when the show is left out of the ranking */
  score: number | null;
  /** the main reasons, most important first */
  reasons: string[];
  excluded: boolean;
  excludedReason: string | null;
  waitlist: boolean;
  /** "profit" when the score comes from expected profit, "points" when it comes from the weighted factors */
  mode: 'profit' | 'points';
}

export const TOP_REASONS = 3;

export function toRowInfo(s: VendorScore): VendorRowInfo {
  return {
    score: s.score,
    reasons: s.reasons.slice(0, TOP_REASONS),
    excluded: s.excluded,
    excludedReason: s.excludedReason,
    waitlist: s.waitlist,
    mode: s.mode,
  };
}

/** Scores for every show the planner knows, by show id. */
export async function rankForTable(
  planner: PlannerCaller,
  settings: PlannerSettings,
  opts: { today: string; weights: WeightPreset; /** "points" scores by the weights even when typical sales are filled in */ scoreBy?: 'auto' | 'points'; labels?: Record<string, string>; rates?: Record<string, number> },
): Promise<Map<string, VendorRowInfo>> {
  const scores = await planner.call('rankForVendor', {
    settings,
    options: { today: opts.today, weights: opts.weights, scoreBy: opts.scoreBy ?? 'auto', labels: opts.labels, rates: opts.rates && Object.keys(opts.rates).length ? opts.rates : undefined },
  });
  return new Map(scores.map((s) => [s.showId, toRowInfo(s)]));
}

/** "Score 82 of 100" and so on, for the result row. */
export function scoreLine(info: VendorRowInfo): string {
  if (info.excluded || info.score === null) return `Left out of your ranking: ${info.excludedReason ?? 'not enough information'}`;
  return `Score ${info.score} of 100${info.waitlist ? ', waitlist only' : ''}`;
}

/** Labels for vocabulary ids, in the planner's reasons ("Has Pokémon and Magic"). */
export function labelMap(vocab: { tcg: { id: string; label: string }[]; sports: { id: string; label: string }[]; other: { id: string; label: string }[] }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const g of [vocab.tcg, vocab.sports, vocab.other]) for (const v of g) out[v.id] = v.label;
  return out;
}
