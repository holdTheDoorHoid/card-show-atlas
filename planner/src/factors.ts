/**
 * Vendor priority factors (DESIGN 5.2). Each factor is a number from 0 to 1 with a short plain
 * reason. Weights come from a preset or from the user's sliders.
 */
import { formatDuration, formatMoney, formatNumber, joinWords } from './format.js';
import { convert } from './money.js';
import { resolveSizeClass, tableCost, vendorCurrency, type ProfitModel } from './profit.js';
import type { Currency, ExchangeRates, PlannerShow, SizeClass, VendorSettings } from './types.js';
import { PlannerError } from './types.js';
import { labelFor, matchSells } from './vocab.js';

export type WeightKey = 'crowd' | 'traffic' | 'cost' | 'travel' | 'match' | 'history';
export const WEIGHT_KEYS: WeightKey[] = ['crowd', 'traffic', 'cost', 'travel', 'match', 'history'];
export type Weights = Record<WeightKey, number>;
export type PresetName = 'biggest_crowds' | 'cheapest' | 'closest' | 'balanced';

export const WEIGHT_PRESETS: Record<PresetName, Weights> = {
  balanced: { crowd: 0.25, traffic: 0.15, cost: 0.15, travel: 0.2, match: 0.15, history: 0.1 },
  biggest_crowds: { crowd: 0.45, traffic: 0.2, cost: 0.05, travel: 0.1, match: 0.1, history: 0.1 },
  cheapest: { crowd: 0.1, traffic: 0.1, cost: 0.45, travel: 0.15, match: 0.1, history: 0.1 },
  closest: { crowd: 0.1, traffic: 0.05, cost: 0.1, travel: 0.5, match: 0.15, history: 0.1 },
};

export const PRESET_LABELS: Record<PresetName, string> = {
  biggest_crowds: 'Biggest crowds',
  cheapest: 'Cheapest',
  closest: 'Closest',
  balanced: 'Balanced',
};

/** A preset name, or custom weights (any non negative numbers; missing keys count as zero). */
export type WeightsInput = PresetName | Partial<Weights> | null | undefined;

export function resolveWeights(input: WeightsInput): Weights {
  if (input === null || input === undefined) return { ...WEIGHT_PRESETS.balanced };
  if (typeof input === 'string') {
    const p = WEIGHT_PRESETS[input];
    if (!p) throw new PlannerError('bad_weights', `Unknown weight preset "${input}".`);
    return { ...p };
  }
  const raw: Weights = { crowd: 0, traffic: 0, cost: 0, travel: 0, match: 0, history: 0 };
  for (const k of WEIGHT_KEYS) {
    const v = input[k];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new PlannerError('bad_weights', 'Weights must be zero or more.');
    }
    raw[k] = v;
  }
  const sum = WEIGHT_KEYS.reduce((s, k) => s + raw[k], 0);
  if (sum <= 0) return { ...WEIGHT_PRESETS.balanced };
  for (const k of WEIGHT_KEYS) raw[k] /= sum;
  return raw;
}

/** Gentle decay: halves every `halfLifeHours` of driving. Never a cliff. */
export function closeness(hours: number, halfLifeHours = 2): number {
  if (!(hours > 0)) return 1;
  return 0.5 ** (hours / halfLifeHours);
}

export interface Factor {
  value: number;
  /** Plain reason, or null when there is nothing worth saying. */
  reason: string | null;
  known: boolean;
}

export type VendorFactors = Record<WeightKey, Factor>;

/** Table prices of the shows being compared, per currency, for "cheaper than most". */
export interface PriceContext {
  byCurrency: Map<Currency, number[]>;
}

export function buildPriceContext(
  shows: PlannerShow[],
  settings: VendorSettings,
  rates?: ExchangeRates | null,
): PriceContext {
  const byCurrency = new Map<Currency, number[]>();
  const vc = vendorCurrency(settings);
  for (const s of shows) {
    const p = s.vendor?.min_table_price;
    if (typeof p !== 'number' || p < 0) continue;
    const t = tableCost(s, settings);
    const conv = convert(t.amount, t.currency, vc, rates);
    const cur = conv ? vc : t.currency;
    const amount = conv ? conv.to.amount : t.amount;
    const list = byCurrency.get(cur) ?? [];
    list.push(amount);
    byCurrency.set(cur, list);
  }
  for (const list of byCurrency.values()) list.sort((a, b) => a - b);
  return { byCurrency };
}

const SIZE_VALUE: Record<SizeClass, number> = { small: 0.2, medium: 0.45, large: 0.7, major: 0.9 };
const SIZE_WORD: Record<SizeClass, string> = {
  small: 'Small show',
  medium: 'Medium sized show',
  large: 'Large show',
  major: 'Major show',
};

export interface FactorContext {
  settings: VendorSettings;
  /** Drive hours from home or from the previous show, or null when unknown. */
  hours: number | null;
  /** "home" or a show name, for "3 h drive from home". */
  fromName?: string | null;
  priceContext?: PriceContext | null;
  rates?: ExchangeRates | null;
  labels?: Record<string, string>;
  profitModel?: Partial<ProfitModel> | null;
  travelHalfLifeHours?: number;
  /** Build the reason strings. Default true; the planners turn it off for speed. */
  withReasons?: boolean;
}

/** Number of sorted values below x, and equal to x. */
function rankIn(sorted: number[], x: number): { below: number; same: number } {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < x - 1e-9) lo = mid + 1;
    else hi = mid;
  }
  let end = lo;
  while (end < sorted.length && Math.abs(sorted[end]! - x) <= 1e-9) end += 1;
  return { below: lo, same: end - lo };
}

export function vendorFactors(show: PlannerShow, ctx: FactorContext): VendorFactors {
  const settings = ctx.settings;
  const vc = vendorCurrency(settings);
  const say = ctx.withReasons !== false;

  // Crowd.
  let crowd: Factor;
  const mid = show.estimate?.attendance?.mid;
  if (typeof mid === 'number' && mid > 0) {
    const value = Math.max(0, Math.min(1, Math.log10(mid / 100) / Math.log10(200)));
    const word = mid >= 5000 ? 'Big crowd' : mid >= 1500 ? 'Good crowd' : mid < 500 ? 'Small crowd' : 'Medium crowd';
    crowd = { value, reason: say ? `${word} expected (about ${formatNumber(Math.round(mid / 10) * 10)})` : null, known: true };
  } else {
    const sc = resolveSizeClass(show);
    crowd = sc.assumed
      ? { value: 0.35, reason: 'Crowd size unknown', known: false }
      : { value: SIZE_VALUE[sc.sizeClass], reason: SIZE_WORD[sc.sizeClass], known: true };
  }

  // Traffic per table.
  let traffic: Factor;
  const tpt = show.estimate?.traffic_per_table;
  const ref = ctx.profitModel?.trafficReference ?? 6;
  if (typeof tpt === 'number' && tpt > 0) {
    let reason: string | null = null;
    if (say) {
      const n = formatNumber(tpt, tpt < 10 ? 1 : 0).replace(/\.0$/, '');
      reason =
        tpt >= ref * 1.7
          ? `Busy room, about ${n} visitors per table`
          : tpt <= ref * 0.5
            ? `Quiet room, about ${n} visitors per table`
            : `About ${n} visitors per table`;
    }
    traffic = { value: tpt / (tpt + ref), reason, known: true };
  } else {
    traffic = { value: 0.5, reason: null, known: false };
  }

  // Table cost.
  let cost: Factor;
  const listed = show.vendor?.min_table_price;
  if (typeof listed === 'number' && listed >= 0) {
    const t = tableCost(show, settings);
    const conv = convert(t.amount, t.currency, vc, ctx.rates);
    const cur = conv ? vc : t.currency;
    const amount = conv ? conv.to.amount : t.amount;
    const shown = say ? formatMoney(Math.round(t.amount), t.currency) : '';
    const peers = ctx.priceContext?.byCurrency.get(cur) ?? [];
    if (peers.length >= 5) {
      const { below, same } = rankIn(peers, amount);
      const q = (below + 0.5 * same) / peers.length;
      const word = q <= 0.33 ? 'cheaper than most' : q >= 0.67 ? 'pricier than most' : 'about average';
      cost = { value: 1 - q, reason: say ? `Table is ${shown}, ${word}` : null, known: true };
    } else if (conv) {
      cost = { value: 1 / (1 + amount / 150), reason: say ? `Table is ${shown}` : null, known: true };
    } else {
      cost = { value: 0.5, reason: say ? `Table is ${shown} (no exchange rate set)` : null, known: false };
    }
  } else {
    cost = { value: 0.5, reason: 'Table price not listed', known: false };
  }

  // Travel.
  let travel: Factor;
  if (ctx.hours !== null && ctx.hours !== undefined) {
    const from = ctx.fromName ? ` from ${ctx.fromName}` : '';
    travel = {
      value: closeness(ctx.hours, ctx.travelHalfLifeHours ?? 2),
      reason: !say ? null : ctx.hours < 1 / 12 ? `Under 5 min drive${from}` : `${formatDuration(ctx.hours)} drive${from}`,
      known: true,
    };
  } else {
    travel = { value: 0.5, reason: null, known: false };
  }

  // What is sold.
  const ms = matchSells(settings.sells ?? [], show.sells ?? []);
  let match: Factor;
  if (!ms.known) {
    match = { value: 0.5, reason: (show.sells ?? []).length === 0 ? 'What is sold is not listed' : null, known: false };
  } else if (ms.matched.length > 0) {
    const reason = say ? `Matches what you sell: ${joinWords(ms.matched.slice(0, 3).map((id) => labelFor(id, ctx.labels)))}` : null;
    match = { value: ms.score, reason, known: true };
  } else {
    match = { value: ms.score, reason: 'Little overlap with what you sell', known: true };
  }

  // Own history.
  let history: Factor = { value: 0.5, reason: null, known: false };
  const h = show.series_id ? settings.history?.[show.series_id] : undefined;
  if (h) {
    const parts: number[] = [];
    const reasons: string[] = [];
    if (typeof h.rating === 'number' && h.rating >= 1 && h.rating <= 5) {
      parts.push((h.rating - 1) / 4);
      if (say) reasons.push(`You rated it ${formatNumber(h.rating, h.rating % 1 ? 1 : 0)} last time`);
    }
    const past = (h.gross_sales ?? []).filter((x) => typeof x === 'number' && x >= 0);
    if (past.length > 0) {
      const avg = past.reduce((s, x) => s + x, 0) / past.length;
      const ts = settings.typical_sales;
      if (ts) {
        const typical = ts[resolveSizeClass(show).sizeClass];
        if (typical > 0) parts.push(avg / typical / (avg / typical + 1));
      }
      if (say) reasons.push(`You averaged ${formatMoney(Math.round(avg), vc)} here`);
    }
    if (parts.length > 0 || reasons.length > 0) {
      history = {
        value: parts.length > 0 ? parts.reduce((s, x) => s + x, 0) / parts.length : 0.5,
        reason: reasons.length ? joinWords(reasons) : null,
        known: parts.length > 0,
      };
    }
  }

  return { crowd, traffic, cost, travel, match, history };
}

/** Weighted points, 0 to 100, without the travel factor. */
export function pointsWithoutTravel(f: VendorFactors, w: Weights): number {
  let s = 0;
  for (const k of WEIGHT_KEYS) if (k !== 'travel') s += w[k] * f[k].value;
  return 100 * s;
}

/** Weighted points, 0 to 100. */
export function points(f: VendorFactors, w: Weights): number {
  let s = 0;
  for (const k of WEIGHT_KEYS) s += w[k] * f[k].value;
  return 100 * s;
}

/** Reasons ordered by how much they moved the score. */
export function rankedReasons(f: VendorFactors, w: Weights, max = 5): string[] {
  const items = WEIGHT_KEYS.map((k) => ({ k, impact: w[k] * Math.abs(f[k].value - 0.5) + (f[k].known ? 1e-6 : 0), r: f[k].reason }))
    .filter((x) => x.r)
    .sort((a, b) => b.impact - a.impact);
  return items.slice(0, max).map((x) => x.r as string);
}
