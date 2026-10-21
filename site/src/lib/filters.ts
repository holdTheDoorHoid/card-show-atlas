// Filtering, distance and sorting for the Find list and the map. Pure functions over index rows.
import { daysBetween } from './dates.ts';
import { driveMinutes, haversineMiles, type LatLon } from './geo.ts';
import { rowOverlaps } from './index-build.ts';
import { EVENT_TYPE_INFO, SIZE_INFO } from './labels.ts';
import type { EventType, IndexRow, SizeClass, Vocab } from './types.ts';
import { labelFor, SPORTS_ANY, sportsIds } from './vocab.ts';

export interface Filters {
  /** What is sold: vocabulary ids, or SPORTS_ANY. A show matches when it sells any of them. Empty means no filter. */
  sells: string[];
  /** When something is chosen in `sells`, hide shows that do not say what they sell. */
  sellsKnownOnly: boolean;
  /** Hide shows that sell only sports cards. */
  hideSportsOnly: boolean;
  /** Event types to show. Empty means all of the show types. */
  types: EventType[];
  /** Size classes to show. Empty means all, including shows with no size estimate. */
  sizes: SizeClass[];
  /** Only shows with free entry. */
  free: boolean;
  /** Only shows that have vendor tables open to applications. */
  vendorOpen: boolean;
}

export const DEFAULT_FILTERS: Filters = {
  sells: [],
  sellsKnownOnly: false,
  hideSportsOnly: false,
  types: [],
  sizes: [],
  free: false,
  vendorOpen: false,
};

export function countActiveFilters(f: Filters): number {
  return (
    (f.sells.length > 0 ? 1 : 0) +
    (f.sells.length > 0 && f.sellsKnownOnly ? 1 : 0) +
    (f.hideSportsOnly ? 1 : 0) +
    (f.types.length > 0 ? 1 : 0) +
    (f.sizes.length > 0 ? 1 : 0) +
    (f.free ? 1 : 0) +
    (f.vendorOpen ? 1 : 0)
  );
}

/** The active filters as one short line, for next to the Filters button: "Pokémon, Magic, Free entry". */
export function describeFilters(f: Filters, vocab: Vocab, opts: { storeEvents?: boolean } = {}): string {
  const parts: string[] = [];
  for (const id of f.sells) parts.push(id === SPORTS_ANY ? 'Sports cards' : labelFor(vocab, id));
  if (f.sells.length > 0 && f.sellsKnownOnly) parts.push('only listed');
  if (f.hideSportsOnly) parts.push('no sports only shows');
  for (const t of f.types) parts.push(EVENT_TYPE_INFO[t].plural);
  for (const sz of f.sizes) parts.push(SIZE_INFO[sz].label);
  if (f.free) parts.push('Free entry');
  if (f.vendorOpen) parts.push('Vendor tables open');
  if (opts.storeEvents) parts.push('Store events');
  return parts.join(', ');
}

/** Shows that are called off do not belong in lists or on the map. Their page still says so. */
export function isListable(row: IndexRow): boolean {
  return row.st !== 'cancelled';
}

function matchesSells(row: IndexRow, selected: string[], vocab: Vocab, knownOnly: boolean): boolean {
  if (selected.length === 0) return true;
  const sells = row.sl;
  if (!sells || sells.length === 0) return !knownOnly; // unknown is not the same as "sells nothing"
  const sports = new Set(sportsIds(vocab));
  return selected.some((id) => (id === SPORTS_ANY ? sells.some((s) => sports.has(s)) : sells.includes(id)));
}

export function matchesFilters(row: IndexRow, f: Filters, vocab: Vocab): boolean {
  if (f.types.length > 0 && !f.types.includes(row.t)) return false;
  if (f.sizes.length > 0 && !(row.sz && f.sizes.includes(row.sz))) return false;
  if (f.free && row.fr !== 1) return false;
  if (f.vendorOpen && row.vs !== 'open') return false;
  if (f.hideSportsOnly && row.mx === 'sports') return false;
  return matchesSells(row, f.sells, vocab, f.sellsKnownOnly);
}

export function filterRows(rows: IndexRow[], f: Filters, vocab: Vocab): IndexRow[] {
  return rows.filter((r) => isListable(r) && matchesFilters(r, f, vocab));
}

export interface Result {
  row: IndexRow;
  /** straight line miles from the chosen place, or null when no place is chosen */
  miles: number | null;
  /** estimated drive time in minutes */
  minutes: number | null;
}

export function distanceTo(row: IndexRow, origin: LatLon | null): number | null {
  if (!origin || !row.ll) return null;
  return haversineMiles(origin, { lat: row.ll[0], lon: row.ll[1] });
}

export interface SelectOptions {
  filters: Filters;
  vocab: Vocab;
  /** inclusive date range; shows with any day inside it match */
  range: { from: string; to: string } | null;
  origin: LatLon | null;
  /** only with an origin: farthest straight line distance in miles. Shows without coordinates are left out. */
  maxMiles: number | null;
}

export function selectResults(rows: IndexRow[], opts: SelectOptions): Result[] {
  const out: Result[] = [];
  for (const row of rows) {
    if (!isListable(row)) continue;
    if (opts.range && !rowOverlaps(row, opts.range.from, opts.range.to)) continue;
    if (!matchesFilters(row, opts.filters, opts.vocab)) continue;
    let miles: number | null = null;
    let minutes: number | null = null;
    if (opts.origin) {
      miles = distanceTo(row, opts.origin);
      if (miles === null) continue;
      if (opts.maxMiles !== null && miles > opts.maxMiles) continue;
      minutes = driveMinutes(miles);
    }
    out.push({ row, miles, minutes });
  }
  return out;
}

export type SortKey = 'date' | 'distance' | 'size' | 'match' | 'vendor';
export const SORT_LABELS: Record<SortKey, string> = {
  date: 'Date',
  distance: 'Distance',
  size: 'Size',
  match: 'Best match',
  vendor: 'Best for my table',
};

const SIZE_FALLBACK: Record<SizeClass, number> = { small: 300, medium: 1000, large: 3000, major: 8000 };

export function attendanceOf(row: IndexRow): number | null {
  if (typeof row.at === 'number') return row.at;
  return row.sz ? SIZE_FALLBACK[row.sz] : null;
}

/**
 * "Best match" for show goers (DESIGN 5.1): closer is better with a gentle decay, bigger is better,
 * matching what you collect is better, sooner is slightly better, free entry is a small bonus.
 * Returns a number between 0 and 1.
 */
export function bestMatchScore(
  result: Result,
  ctx: { today: string; selected: string[]; vocab: Vocab },
): number {
  const { row, miles } = result;
  const closeness = miles === null ? 0.5 : 1 / (1 + (miles / 80) ** 1.5);
  const att = attendanceOf(row);
  const bigness = att === null ? 0.3 : Math.min(1, Math.log10(Math.max(att, 50)) / 4);
  let fit = 0.5;
  if (ctx.selected.length > 0) {
    const sells = row.sl ?? [];
    if (sells.length === 0) fit = 0.3;
    else {
      const sports = new Set(sportsIds(ctx.vocab));
      const hits = ctx.selected.filter((id) => (id === SPORTS_ANY ? sells.some((s) => sports.has(s)) : sells.includes(id))).length;
      fit = 0.4 + 0.6 * (hits / ctx.selected.length);
    }
  }
  const days = Math.max(0, daysBetween(ctx.today, row.d));
  const soon = 1 / (1 + days / 30);
  const free = row.fr === 1 ? 1 : 0;
  return 0.34 * closeness + 0.26 * bigness + 0.24 * fit + 0.1 * soon + 0.06 * free;
}

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const cmpNullLast = (a: number | null, b: number | null) => (a === null ? (b === null ? 0 : 1) : b === null ? -1 : a - b);

export function sortResults(
  results: Result[],
  sort: SortKey,
  ctx: { today: string; selected: string[]; vocab: Vocab; /** vendor priority scores by show id, for "Best for my table" */ vendorScores?: ReadonlyMap<string, number | null> },
): Result[] {
  const byDate = (a: Result, b: Result) => cmpStr(a.row.d, b.row.d) || cmpNullLast(a.miles, b.miles) || cmpStr(a.row.i, b.row.i);
  const copy = [...results];
  switch (sort) {
    case 'date':
      return copy.sort(byDate);
    case 'distance':
      return copy.sort((a, b) => cmpNullLast(a.miles, b.miles) || byDate(a, b));
    case 'size':
      return copy.sort((a, b) => cmpNullLast(negate(attendanceOf(a.row)), negate(attendanceOf(b.row))) || byDate(a, b));
    case 'vendor': {
      const scores = ctx.vendorScores;
      if (!scores) return copy.sort(byDate);
      // best score first; shows the planner left out (no score) go last, in date order
      return copy.sort((a, b) => cmpNullLast(negate(scores.get(a.row.i) ?? null), negate(scores.get(b.row.i) ?? null)) || byDate(a, b));
    }
    case 'match': {
      const scored = copy.map((r) => ({ r, s: bestMatchScore(r, ctx) }));
      return scored.sort((a, b) => b.s - a.s || byDate(a.r, b.r)).map((x) => x.r);
    }
  }
}

function negate(n: number | null): number | null {
  return n === null ? null : -n;
}

const EVENT_TYPE_IDS: readonly string[] = ['card_show', 'convention', 'tournament', 'pop_culture_con'];
const SIZE_IDS: readonly string[] = ['small', 'medium', 'large', 'major'];

/** Read filters saved in the browser, ignoring anything that is not valid. */
export function sanitizeFilters(raw: unknown): Filters {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_FILTERS };
  const o = raw as Record<string, unknown>;
  const list = (v: unknown, allowed?: readonly string[]) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && (!allowed || allowed.includes(x))).slice(0, 80) : [];
  return {
    sells: list(o.sells),
    sellsKnownOnly: o.sellsKnownOnly === true,
    hideSportsOnly: o.hideSportsOnly === true,
    types: list(o.types, EVENT_TYPE_IDS) as EventType[],
    sizes: list(o.sizes, SIZE_IDS) as SizeClass[],
    free: o.free === true,
    vendorOpen: o.vendorOpen === true,
  };
}

/** Add or remove one value in a list. */
export function toggled<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}
