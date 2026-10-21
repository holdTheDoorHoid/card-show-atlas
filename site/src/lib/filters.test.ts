import { describe, expect, it } from 'vitest';
import { bestMatchScore, countActiveFilters, DEFAULT_FILTERS, filterRows, selectResults, sortResults, type Filters } from './filters.ts';
import { makeRow } from './testing.ts';
import { DEFAULT_VOCAB, SPORTS_ANY } from './vocab.ts';

const vocab = DEFAULT_VOCAB;
const f = (over: Partial<Filters>): Filters => ({ ...DEFAULT_FILTERS, ...over });

const rows = [
  makeRow({ i: 'pokemon-show', sl: ['pokemon', 'mtg'], mx: 'tcg', t: 'card_show', sz: 'small', at: 300, fr: 1, vs: 'open' }),
  makeRow({ i: 'sports-only', sl: ['baseball', 'football'], mx: 'sports', t: 'card_show', sz: 'medium', at: 900, ad: 5 }),
  makeRow({ i: 'mixed', sl: ['pokemon', 'baseball'], mx: 'mixed', t: 'convention', sz: 'large', at: 3000, ad: 10, vs: 'sold_out' }),
  makeRow({ i: 'unknown-sells', t: 'card_show' }),
  makeRow({ i: 'tournament', sl: ['mtg'], mx: 'tcg', t: 'tournament', sz: 'major', at: 9000, vs: 'waitlist' }),
  makeRow({ i: 'called-off', sl: ['pokemon'], mx: 'tcg', st: 'cancelled' }),
];
const ids = (list: { i: string }[]) => list.map((r) => r.i);

describe('filters', () => {
  it('shows everything that is on when no filter is set, except cancelled shows', () => {
    expect(ids(filterRows(rows, DEFAULT_FILTERS, vocab))).toEqual(['pokemon-show', 'sports-only', 'mixed', 'unknown-sells', 'tournament']);
  });

  it('filters by what is sold, matching any chosen game', () => {
    expect(ids(filterRows(rows, f({ sells: ['pokemon'] }), vocab))).toEqual(['pokemon-show', 'mixed', 'unknown-sells']);
    expect(ids(filterRows(rows, f({ sells: ['pokemon', 'mtg'] }), vocab))).toEqual(['pokemon-show', 'mixed', 'unknown-sells', 'tournament']);
  });

  it('treats a show that does not say what it sells as unknown, not as selling nothing', () => {
    expect(ids(filterRows(rows, f({ sells: ['pokemon'] }), vocab))).toContain('unknown-sells');
    expect(ids(filterRows(rows, f({ sells: ['pokemon'], sellsKnownOnly: true }), vocab))).not.toContain('unknown-sells');
  });

  it('the sports chip matches any sport', () => {
    expect(ids(filterRows(rows, f({ sells: [SPORTS_ANY], sellsKnownOnly: true }), vocab))).toEqual(['sports-only', 'mixed']);
  });

  it('can hide sports only shows', () => {
    const out = ids(filterRows(rows, f({ hideSportsOnly: true }), vocab));
    expect(out).not.toContain('sports-only');
    expect(out).toContain('mixed');
    expect(out).toContain('unknown-sells');
  });

  it('filters by event type, size, free entry and open vendor tables', () => {
    expect(ids(filterRows(rows, f({ types: ['convention', 'tournament'] }), vocab))).toEqual(['mixed', 'tournament']);
    expect(ids(filterRows(rows, f({ sizes: ['small', 'major'] }), vocab))).toEqual(['pokemon-show', 'tournament']);
    expect(ids(filterRows(rows, f({ free: true }), vocab))).toEqual(['pokemon-show']);
    expect(ids(filterRows(rows, f({ vendorOpen: true }), vocab))).toEqual(['pokemon-show']);
  });

  it('counts active filters for the badge on the Filters button', () => {
    expect(countActiveFilters(DEFAULT_FILTERS)).toBe(0);
    expect(countActiveFilters(f({ sells: ['pokemon'], free: true, types: ['card_show'] }))).toBe(3);
    expect(countActiveFilters(f({ sellsKnownOnly: true }))).toBe(0); // only counts once something is chosen
  });
});

describe('selectResults', () => {
  const near = makeRow({ i: 'near', ll: [40.52, -74.41], d: '2026-11-14' }); // Edison
  const mid = makeRow({ i: 'mid', ll: [39.95, -75.16], d: '2026-11-07' }); // Philadelphia, about 60 mi
  const far = makeRow({ i: 'far', ll: [42.36, -71.06], d: '2026-12-20' }); // Boston, about 210 mi
  const nowhere = makeRow({ i: 'nowhere', d: '2026-11-14' }); // no coordinates
  const origin = { lat: 40.5, lon: -74.4 };
  const all = [near, mid, far, nowhere];

  it('keeps shows inside the distance and drops those without coordinates when a place is set', () => {
    const out = selectResults(all, { filters: DEFAULT_FILTERS, vocab, range: null, origin, maxMiles: 100 });
    expect(ids(out.map((r) => r.row))).toEqual(['near', 'mid']);
    expect(out[0]?.miles).toBeLessThan(5);
    expect(out[1]?.minutes).toBeGreaterThan(60);
  });

  it('without a place, it does not measure and does not drop anything', () => {
    const out = selectResults(all, { filters: DEFAULT_FILTERS, vocab, range: null, origin: null, maxMiles: null });
    expect(out).toHaveLength(4);
    expect(out.every((r) => r.miles === null)).toBe(true);
  });

  it('applies the date range to any day of a multi day show', () => {
    const multi = makeRow({ i: 'multi', d: '2026-11-13', e: '2026-11-15' });
    const range = { from: '2026-11-15', to: '2026-11-20' };
    expect(ids(selectResults([multi, near, mid], { filters: DEFAULT_FILTERS, vocab, range, origin: null, maxMiles: null }).map((r) => r.row))).toEqual(['multi']);
  });
});

describe('sorting', () => {
  const origin = { lat: 40.5, lon: -74.4 };
  const a = makeRow({ i: 'a', d: '2026-11-20', ll: [40.52, -74.41], sz: 'small', at: 200 });
  const b = makeRow({ i: 'b', d: '2026-11-05', ll: [39.95, -75.16], sz: 'large', at: 4000 });
  const c = makeRow({ i: 'c', d: '2026-11-10', ll: [42.36, -71.06], sz: 'major', at: 9000 });
  const d = makeRow({ i: 'd', d: '2026-11-01', ll: [40.6, -74.3] }); // no size estimate
  const results = selectResults([a, b, c, d], { filters: DEFAULT_FILTERS, vocab, range: null, origin, maxMiles: null });
  const ctx = { today: '2026-10-21', selected: [] as string[], vocab };
  const order = (key: Parameters<typeof sortResults>[1]) => sortResults(results, key, ctx).map((r) => r.row.i);

  it('sorts by date', () => expect(order('date')).toEqual(['d', 'b', 'c', 'a']));
  it('sorts by distance', () => expect(order('distance')).toEqual(['a', 'd', 'b', 'c']));
  it('sorts by size, biggest first, unknown last', () => expect(order('size')).toEqual(['c', 'b', 'a', 'd']));

  it('best match prefers closer, bigger and better matching shows', () => {
    const close = { row: makeRow({ i: 'close', sl: ['pokemon'], at: 1000, d: '2026-11-14' }), miles: 10, minutes: 20 };
    const far = { row: makeRow({ i: 'far', sl: ['pokemon'], at: 1000, d: '2026-11-14' }), miles: 300, minutes: 360 };
    const ctx2 = { today: '2026-10-21', selected: ['pokemon'], vocab };
    expect(bestMatchScore(close, ctx2)).toBeGreaterThan(bestMatchScore(far, ctx2));
    const big = { row: makeRow({ i: 'big', sl: ['pokemon'], at: 6000, d: '2026-11-14' }), miles: 10, minutes: 20 };
    const small = { row: makeRow({ i: 'small', sl: ['pokemon'], at: 200, d: '2026-11-14' }), miles: 10, minutes: 20 };
    expect(bestMatchScore(big, ctx2)).toBeGreaterThan(bestMatchScore(small, ctx2));
    const wrong = { row: makeRow({ i: 'wrong', sl: ['baseball'], at: 1000, d: '2026-11-14' }), miles: 10, minutes: 20 };
    expect(bestMatchScore(close, ctx2)).toBeGreaterThan(bestMatchScore(wrong, ctx2));
    const free = { row: makeRow({ i: 'free', sl: ['pokemon'], at: 1000, fr: 1, d: '2026-11-14' }), miles: 10, minutes: 20 };
    expect(bestMatchScore(free, ctx2)).toBeGreaterThan(bestMatchScore(close, ctx2));
  });

  it('closeness decays gently rather than falling off a cliff', () => {
    const at = (miles: number) => bestMatchScore({ row: makeRow({ i: 'x', at: 1000 }), miles, minutes: 0 }, { today: '2026-10-21', selected: [], vocab });
    const drop1 = at(50) - at(60);
    const drop2 = at(100) - at(110);
    expect(drop1).toBeGreaterThan(0);
    expect(drop1).toBeLessThan(0.03);
    expect(at(400)).toBeGreaterThan(0.2); // far shows still count a little
    expect(drop2).toBeGreaterThan(0);
  });

  it('orders by best match', () => {
    const out = sortResults(results, 'match', ctx).map((r) => r.row.i);
    // a: right next door but small. b: an hour away and large. d: close, size unknown. c: major but 210 miles.
    expect(out).toEqual(['a', 'b', 'd', 'c']);
  });
});
