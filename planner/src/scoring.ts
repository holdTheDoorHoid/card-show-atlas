/**
 * Ranking (DESIGN 5).
 *
 * Show goers get a "best match" score: closer is better (a gentle decay, not a cliff), bigger is
 * better, matching what you collect is better, sooner is slightly better, free entry is a small
 * bonus.
 *
 * Vendors get a priority score out of 100 with plain reasons. Closed and sold out shows drop out,
 * waitlists are marked. When typical sales are filled in, the score switches to expected profit.
 */
import { filterCandidates, type Excluded } from './candidates.js';
import {
  buildPriceContext,
  closeness,
  points,
  rankedReasons,
  resolveWeights,
  vendorFactors,
  type PresetName,
  type VendorFactors,
  type Weights,
  type WeightsInput,
} from './factors.js';
import { formatDuration, formatMoney, formatNumber, formatWhen, joinWords } from './format.js';
import {
  resolveProfitModel,
  resolveSizeClass,
  type ProfitEstimate,
  type ProfitModel,
} from './profit.js';
import { epochDay, todayIn } from './time.js';
import { Travel, type LegMatrix, type TravelModel } from './travel.js';
import type { ExchangeRates, LatLon, Place, PlannerShow, PlanningRules, VendorSettings } from './types.js';
import { DEFAULT_RULES, PlannerError } from './types.js';
import { labelFor, matchSells } from './vocab.js';
import { standaloneProfit } from './estimate.js';
import { validateSettings } from './validate.js';

/* ---------------------------------- Show goers ---------------------------------- */

export interface ShowGoerQuery {
  origin: LatLon;
  /** Vocabulary ids the person collects. */
  interests?: string[];
  /** `YYYY-MM-DD`. Defaults to today in the runtime's zone. */
  today?: string;
  travel?: Partial<TravelModel>;
  knownLegs?: LegMatrix | LegMatrix[];
  labels?: Record<string, string>;
  /** Closeness halves every this many hours of driving. Default 1.5. */
  halfLifeHours?: number;
  /** Leave out shows that are already over. Default true. */
  hidePast?: boolean;
}

export interface ShowGoerScore {
  showId: string;
  /** 0 to 100. */
  score: number;
  reasons: string[];
  miles: number;
  km: number;
  hours: number;
  factors: { distance: number; size: number; match: number; soon: number; free: number };
}

const GOER_WEIGHTS = { distance: 0.35, size: 0.25, match: 0.25, soon: 0.1, free: 0.05 };

function sizeValue(show: PlannerShow): { value: number; reason: string | null } {
  const mid = show.estimate?.attendance?.mid;
  if (typeof mid === 'number' && mid > 0) {
    const value = Math.max(0, Math.min(1, Math.log10(mid / 100) / Math.log10(200)));
    const word = mid >= 5000 ? 'Big show' : mid >= 1500 ? 'Good sized show' : mid < 500 ? 'Small show' : 'Medium sized show';
    return { value, reason: `${word} (about ${formatNumber(Math.round(mid / 10) * 10)} people)` };
  }
  const sc = resolveSizeClass(show);
  if (sc.assumed) return { value: 0.35, reason: null };
  const map = { small: 0.2, medium: 0.45, large: 0.7, major: 0.9 } as const;
  const words = { small: 'Small show', medium: 'Medium sized show', large: 'Large show', major: 'Major show' } as const;
  return { value: map[sc.sizeClass], reason: words[sc.sizeClass] };
}

function freeValue(show: PlannerShow): { value: number; reason: string | null } {
  const a = show.admission;
  if (a?.free) return { value: 1, reason: 'Free entry' };
  if (typeof a?.adult === 'number' && a.adult > 0 && a.currency) {
    return { value: 0, reason: `Entry ${formatMoney(a.adult, a.currency)}` };
  }
  return { value: 0, reason: null };
}

export function scoreForShowGoer(show: PlannerShow, query: ShowGoerQuery, travelIn?: Travel): ShowGoerScore {
  const travel = travelIn ?? new Travel(query.travel, query.knownLegs);
  const today = query.today ?? todayIn();
  const leg = travel.leg(query.origin, show);
  const distance = closeness(leg.hours, query.halfLifeHours ?? 1.5);
  const size = sizeValue(show);
  const ms = matchSells(query.interests ?? [], show.sells ?? []);
  const firstDate = show.days.map((d) => d.date).sort()[0] ?? today;
  const daysAway = Math.max(0, epochDay(firstDate) - epochDay(today));
  const soon = 0.5 ** (daysAway / 21);
  const free = freeValue(show);
  const total =
    GOER_WEIGHTS.distance * distance +
    GOER_WEIGHTS.size * size.value +
    GOER_WEIGHTS.match * ms.score +
    GOER_WEIGHTS.soon * soon +
    GOER_WEIGHTS.free * free.value;
  const reasons: string[] = [`${formatDuration(leg.hours)} drive`];
  if (ms.known && ms.matched.length > 0) {
    reasons.push(`Has ${joinWords(ms.matched.slice(0, 3).map((id) => labelFor(id, query.labels)))}`);
  } else if (ms.known) {
    reasons.push('Not much of what you collect');
  }
  if (size.reason) reasons.push(size.reason);
  const when = formatWhen(firstDate, today);
  reasons.push(when.charAt(0).toUpperCase() + when.slice(1));
  if (free.reason) reasons.push(free.reason);
  return {
    showId: show.id,
    score: Math.round(100 * total),
    reasons,
    miles: leg.miles,
    km: leg.km,
    hours: leg.hours,
    factors: { distance, size: size.value, match: ms.score, soon, free: free.value },
  };
}

/** Best match first. Shows that are over are left out unless `hidePast` is false. */
export function rankForShowGoer(shows: PlannerShow[], query: ShowGoerQuery): ShowGoerScore[] {
  const travel = new Travel(query.travel, query.knownLegs);
  const today = query.today ?? todayIn();
  const out: ShowGoerScore[] = [];
  for (const s of shows) {
    if (!s?.days?.length) continue;
    if (query.hidePast !== false) {
      const last = s.days.map((d) => d.date).sort().at(-1)!;
      if (last < today) continue;
    }
    if (s.status === 'cancelled') continue;
    out.push(scoreForShowGoer(s, { ...query, today }, travel));
  }
  return out.sort((a, b) => b.score - a.score || a.hours - b.hours || (a.showId < b.showId ? -1 : 1));
}

/** Value of visiting a show when shopping: size, match and free entry, 0 to 100 (distance is left to the route). */
export function visitValue(show: PlannerShow, interests: string[]): number {
  const size = sizeValue(show).value;
  const match = matchSells(interests, show.sells ?? []).score;
  const free = freeValue(show).value;
  const w = GOER_WEIGHTS.size + GOER_WEIGHTS.match + GOER_WEIGHTS.free;
  return Math.round((100 * (GOER_WEIGHTS.size * size + GOER_WEIGHTS.match * match + GOER_WEIGHTS.free * free)) / w);
}

/* ---------------------------------- Vendors ---------------------------------- */

export interface VendorScoreOptions {
  /** Where the drive starts. Defaults to home. Pass the previous show to score the next leg of a route. */
  from?: Place & { name?: string };
  today?: string;
  weights?: WeightsInput;
  /** `auto` (default) uses profit when typical sales are set, else points. */
  scoreBy?: 'auto' | 'profit' | 'points';
  rates?: ExchangeRates;
  travel?: Partial<TravelModel>;
  knownLegs?: LegMatrix | LegMatrix[];
  profitModel?: Partial<ProfitModel>;
  rules?: Partial<PlanningRules>;
  labels?: Record<string, string>;
  /** Shows to compare table prices against. `rankForVendor` passes the whole list. */
  peers?: PlannerShow[];
  keepPastDeadline?: boolean;
  includeStoreEvents?: boolean;
}

export interface VendorScore {
  showId: string;
  /** 0 to 100, or null when the show is left out. */
  score: number | null;
  mode: 'profit' | 'points';
  excluded: boolean;
  excludedReason: string | null;
  waitlist: boolean;
  /** Plain reasons, most important first. */
  reasons: string[];
  factors: VendorFactors | null;
  /** Drive from the start point. */
  hours: number | null;
  miles: number | null;
  /** Expected profit for doing this show alone from the start point (profit mode). */
  profit: ProfitEstimate | null;
}

/** Profit to score: a loss scores under 50, a typical medium show's profit scores about 73. */
export function profitToScore(profit: number, settings: VendorSettings): number {
  const ts = settings.typical_sales;
  const scale = Math.max(50, ((ts?.medium ?? 500) * Math.max(1, settings.margin_percent)) / 100);
  return Math.round(100 / (1 + Math.exp(-profit / scale)));
}

interface ScoreShared {
  settings: VendorSettings;
  weights: Weights;
  travel: Travel;
  rules: PlanningRules;
  profitModel: ProfitModel;
  today: string;
  from: Place;
  fromName: string;
  rates: ExchangeRates | null;
  priceContext: ReturnType<typeof buildPriceContext>;
  mode: 'profit' | 'points';
  labels: Record<string, string> | undefined;
}

function shared(settings: VendorSettings, opts: VendorScoreOptions, peers: PlannerShow[]): ScoreShared {
  const scoreBy = opts.scoreBy ?? 'auto';
  if (scoreBy === 'profit' && !settings.typical_sales) {
    throw new PlannerError('no_typical_sales', 'Add your typical sales in settings to score by profit.');
  }
  const mode: 'profit' | 'points' = scoreBy === 'points' ? 'points' : settings.typical_sales ? 'profit' : 'points';
  const from = opts.from ?? settings.home;
  if (!from) throw new PlannerError('no_home', 'Add your home location (or a start point) to score shows.');
  validateSettings(settings, { needFuel: mode === 'profit' });
  return {
    settings,
    weights: resolveWeights(opts.weights),
    travel: new Travel(opts.travel, opts.knownLegs),
    rules: { ...DEFAULT_RULES, ...(opts.rules ?? {}) },
    profitModel: resolveProfitModel(opts.profitModel),
    today: opts.today ?? todayIn(),
    from,
    fromName: opts.from ? (opts.from.name ?? 'your start point') : 'home',
    rates: opts.rates ?? null,
    priceContext: buildPriceContext(peers, settings, opts.rates),
    mode,
    labels: opts.labels,
  };
}

function scoreOne(show: PlannerShow, ctx: ScoreShared, flags: { waitlist: boolean; notes: string[] }): VendorScore {
  const leg = ctx.travel.leg(ctx.from, show);
  const f = vendorFactors(show, {
    settings: ctx.settings,
    hours: leg.hours,
    fromName: ctx.fromName,
    priceContext: ctx.priceContext,
    rates: ctx.rates,
    labels: ctx.labels,
    profitModel: ctx.profitModel,
  });
  const reasons = [...flags.notes];
  if (ctx.mode === 'points') {
    reasons.push(...rankedReasons(f, ctx.weights));
    return {
      showId: show.id,
      score: Math.round(points(f, ctx.weights)),
      mode: 'points',
      excluded: false,
      excludedReason: null,
      waitlist: flags.waitlist,
      reasons,
      factors: f,
      hours: leg.hours,
      miles: leg.miles,
      profit: null,
    };
  }
  const profit = standaloneProfit(show, ctx);
  if (!profit.estimate) {
    return {
      showId: show.id,
      score: null,
      mode: 'profit',
      excluded: true,
      excludedReason: profit.reason,
      waitlist: flags.waitlist,
      reasons: [...reasons, profit.reason],
      factors: f,
      hours: leg.hours,
      miles: leg.miles,
      profit: null,
    };
  }
  const est = profit.estimate;
  if (!est.profit && est.totalCost === null) {
    const cur = est.costs.find((c) => !c.converted)?.currency ?? 'another currency';
    const reason = `Table price is in ${cur}. Add an exchange rate to compare it.`;
    return {
      showId: show.id,
      score: null,
      mode: 'profit',
      excluded: true,
      excludedReason: reason,
      waitlist: flags.waitlist,
      reasons: [...reasons, reason],
      factors: f,
      hours: leg.hours,
      miles: leg.miles,
      profit: est,
    };
  }
  if (est.profit) reasons.push(est.label);
  else reasons.push(...est.notes.slice(1, 2));
  reasons.push(...rankedReasons(f, ctx.weights, 4));
  return {
    showId: show.id,
    score: est.profit ? profitToScore(est.profit.mid, ctx.settings) : null,
    mode: 'profit',
    excluded: false,
    excludedReason: null,
    waitlist: flags.waitlist,
    reasons,
    factors: f,
    hours: leg.hours,
    miles: leg.miles,
    profit: est,
  };
}

/** Score one show for a vendor. Closed or sold out shows come back excluded with the reason. */
export function scoreForVendor(show: PlannerShow, settings: VendorSettings, opts: VendorScoreOptions = {}): VendorScore {
  const ctx = shared(settings, opts, opts.peers ?? [show]);
  return scoreWithFilter([show], ctx, opts)[0]!;
}

function scoreWithFilter(shows: PlannerShow[], ctx: ScoreShared, opts: VendorScoreOptions): VendorScore[] {
  const { kept, excluded } = filterCandidates(shows, {
    rangeStart: '1900-01-01',
    rangeEnd: '2999-12-31',
    today: ctx.today,
    purpose: 'vending',
    keepPastDeadline: opts.keepPastDeadline,
    includeStoreEvents: opts.includeStoreEvents,
  });
  const out: VendorScore[] = kept.map((c) => scoreOne(c.show, ctx, c.flags));
  out.push(...excluded.map((e: Excluded) => excludedScore(e, ctx.mode)));
  return out;
}

function excludedScore(e: Excluded, mode: 'profit' | 'points'): VendorScore {
  return {
    showId: e.id,
    score: null,
    mode,
    excluded: true,
    excludedReason: e.reason,
    waitlist: false,
    reasons: [e.reason],
    factors: null,
    hours: null,
    miles: null,
    profit: null,
  };
}

/** Score many shows; best first, then waitlists, then excluded shows with their reasons. */
export function rankForVendor(shows: PlannerShow[], settings: VendorSettings, opts: VendorScoreOptions = {}): VendorScore[] {
  const ctx = shared(settings, opts, opts.peers ?? shows);
  const scored = scoreWithFilter(shows, ctx, opts);
  return scored.sort((a, b) => {
    if (a.excluded !== b.excluded) return a.excluded ? 1 : -1;
    const sa = a.score ?? -1;
    const sb = b.score ?? -1;
    if (sa !== sb) return sb - sa;
    if (a.waitlist !== b.waitlist) return a.waitlist ? 1 : -1;
    return a.showId < b.showId ? -1 : 1;
  });
}

export { resolveWeights, WEIGHT_PRESETS, PRESET_LABELS } from './factors.js';
export type { PresetName, Weights, WeightsInput };
