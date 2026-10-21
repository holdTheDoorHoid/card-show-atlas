import { describe, expect, it } from 'vitest';
import { buildIndex, emptyIndex, lowestTablePrice, rowDays, rowOverlaps, splitStoreEvents, toRow } from './index-build.ts';
import { normalizeShows } from './normalize.ts';
import { makeShow } from './testing.ts';
import { DEFAULT_VOCAB } from './vocab.ts';

describe('compact rows', () => {
  it('keeps what lists and the map need and nothing else', () => {
    const row = toRow(makeShow());
    expect(row).toEqual({
      i: 'sample-edison-card-show-edison-nj-2026-11-14',
      n: 'Sample Edison Card Show',
      t: 'card_show',
      d: '2026-11-14',
      e: '2026-11-15',
      c: 'Edison',
      r: 'NJ',
      k: 'US',
      ll: [40.5187, -74.3518],
      sz: 'medium',
      at: 700,
      sl: ['pokemon', 'mtg', 'baseball'],
      mx: 'mixed',
      ad: 5,
      vs: 'open',
      vp: 150,
      vd: '2026-10-31',
      vf: 'l',
    });
  });

  it('leaves out values that are just the usual case', () => {
    const row = toRow(makeShow({ days: [{ date: '2026-11-14', open: null, close: null }], estimate: null, sells: {}, mix: undefined, vendor: {}, admission: { free: true, adult: 0, currency: 'USD' } }));
    expect(row.e).toBeUndefined();
    expect(row.g).toBeUndefined();
    expect(row.st).toBeUndefined();
    expect(row.sz).toBeUndefined();
    expect(row.sl).toBeUndefined();
    expect(row.mx).toBeUndefined();
    expect(row.vs).toBeUndefined();
    expect(row.fr).toBe(1);
    expect(row.ad).toBeUndefined();
    expect(row.cu).toBeUndefined();
  });

  it('flags soft locations, status, currency and verification', () => {
    const row = toRow(
      makeShow({
        status: 'tentative',
        venue: { city: 'Toronto', region: 'ON', country: 'CA', lat: 43.65, lon: -79.38, geo_precision: 'postal' },
        admission: { adult: 8, currency: 'CAD' },
        verification: 'organizer_confirmed',
      }),
    );
    expect(row).toMatchObject({ g: 'postal', st: 'tentative', cu: 'CAD', k: 'CA', vf: 'o' });
  });

  it('has no coordinates when the venue has none', () => {
    const row = toRow(makeShow({ venue: { city: 'Edison', region: 'NJ', geo_precision: 'city' } }));
    expect(row.ll).toBeUndefined();
  });

  it('finds the lowest table price', () => {
    const show = makeShow({ vendor: { tables: [{ label: 'a', price: 200 }, { label: 'b', price: 120 }, { label: 'c' }] } });
    expect(lowestTablePrice(show)).toBe(120);
    expect(lowestTablePrice(makeShow({ vendor: {} }))).toBeNull();
  });
});

describe('days in a row', () => {
  it('expands a run of days', () => {
    expect(rowDays(toRow(makeShow()))).toEqual(['2026-11-14', '2026-11-15']);
    expect(rowDays(toRow(makeShow({ days: [{ date: '2026-12-30' }, { date: '2026-12-31' }, { date: '2027-01-01' }] })))).toEqual(['2026-12-30', '2026-12-31', '2027-01-01']);
  });

  it('keeps days that are not an unbroken run', () => {
    const row = toRow(makeShow({ days: [{ date: '2026-11-14' }, { date: '2026-11-16' }] }));
    expect(row.ds).toEqual(['2026-11-14', '2026-11-16']);
    expect(rowDays(row)).toEqual(['2026-11-14', '2026-11-16']);
    expect(rowOverlaps(row, '2026-11-15', '2026-11-15')).toBe(false);
    expect(rowOverlaps(row, '2026-11-16', '2026-11-20')).toBe(true);
  });

  it('checks overlap with a date range, inclusive at both ends', () => {
    const row = toRow(makeShow());
    expect(rowOverlaps(row, '2026-11-15', '2026-11-30')).toBe(true);
    expect(rowOverlaps(row, '2026-11-01', '2026-11-14')).toBe(true);
    expect(rowOverlaps(row, '2026-11-16', '2026-11-30')).toBe(false);
    expect(rowOverlaps(row, '2026-10-01', '2026-11-13')).toBe(false);
  });
});

describe('the index file', () => {
  it('sorts rows by date and counts them', () => {
    const a = makeShow({ id: 'b-show-2026-12-01', days: [{ date: '2026-12-01' }] });
    const b = makeShow({ id: 'a-show-2026-11-01', days: [{ date: '2026-11-01' }] });
    const index = buildIndex([a, b], DEFAULT_VOCAB, { generated: 'now', fixture: false });
    expect(index.rows.map((r) => r.i)).toEqual(['a-show-2026-11-01', 'b-show-2026-12-01']);
    expect(index).toMatchObject({ v: 1, count: 2, fixture: false, generated: 'now' });
    expect(index.vocab.tcg.length).toBeGreaterThan(10);
  });

  it('marks a fixture index', () => {
    expect(buildIndex([], DEFAULT_VOCAB, { generated: 'x', fixture: true }).fixture).toBe(true);
  });

  it('has an empty form for the empty state', () => {
    expect(emptyIndex(DEFAULT_VOCAB, 'x')).toMatchObject({ count: 0, rows: [], fixture: false });
  });

  it('keeps store events out of the main index and gives them their link', () => {
    const store = makeShow({ id: 'store-2026-11-01', event_type: 'store_event', links: { official: 'https://example.com/store' } });
    const show = makeShow();
    const split = splitStoreEvents([show, store]);
    expect(split.shows).toHaveLength(1);
    expect(split.storeEvents).toHaveLength(1);
    expect(buildIndex(split.storeEvents, DEFAULT_VOCAB, { generated: 'x', fixture: false, withLink: true }).rows[0]?.u).toBe('https://example.com/store');
    expect(toRow(store).u).toBeUndefined();
  });

  it('survives an index written to JSON and read back', () => {
    const index = buildIndex([makeShow()], DEFAULT_VOCAB, { generated: 'x', fixture: false });
    expect(JSON.parse(JSON.stringify(index))).toEqual(index);
  });
});

describe('reading shows.json', () => {
  it('accepts a bare list or an object holding the list', () => {
    const raw = JSON.parse(JSON.stringify(makeShow()));
    expect(normalizeShows([raw]).shows).toHaveLength(1);
    expect(normalizeShows({ shows: [raw] }).shows).toHaveLength(1);
    expect(normalizeShows({ nope: [raw] }).shows).toHaveLength(0);
  });

  it('skips records it cannot use, and duplicates, and says how many', () => {
    const good = JSON.parse(JSON.stringify(makeShow()));
    const noDays = { ...good, id: 'other', days: [] };
    const noPlace = { ...good, id: 'other2', venue: { city: 'Edison' } };
    const badType = { ...good, id: 'other3', event_type: 'bake_sale' };
    const result = normalizeShows([good, noDays, noPlace, badType, good, 'text', null]);
    expect(result.shows).toHaveLength(1);
    expect(result.dropped).toBe(6);
  });

  it('fills in what a record leaves out', () => {
    const [s] = normalizeShows([{ id: 'x-2026-11-14', name: 'Sample X', event_type: 'card_show', days: [{ date: '2026-11-14' }], venue: { city: 'Edison', region: 'nj' } }]).shows;
    expect(s).toBeDefined();
    expect(s?.venue.region).toBe('NJ');
    expect(s?.venue.country).toBe('US');
    expect(s?.venue.geo_precision).toBe('city');
    expect(s?.status).toBe('scheduled');
    expect(s?.vendor.status).toBe('unknown');
    expect(s?.mix).toBe('unknown');
    expect(s?.verification).toBe('unverified');
    expect(s?.estimate).toBeNull();
    expect(s?.days[0]).toEqual({ date: '2026-11-14', open: null, close: null });
  });

  it('derives the mix from what is sold when it is not given', () => {
    const base = { id: 'x-2026-11-14', name: 'Sample X', event_type: 'card_show', days: [{ date: '2026-11-14' }], venue: { city: 'A', region: 'NJ' } };
    expect(normalizeShows([{ ...base, sells: { tcg: ['pokemon'] } }]).shows[0]?.mix).toBe('tcg');
    expect(normalizeShows([{ ...base, sells: { sports: ['baseball'] } }]).shows[0]?.mix).toBe('sports');
    expect(normalizeShows([{ ...base, sells: { tcg: ['pokemon'], sports: ['baseball'] } }]).shows[0]?.mix).toBe('mixed');
  });

  it('puts days in order and drops repeated days', () => {
    const [s] = normalizeShows([{ id: 'x', name: 'N', event_type: 'card_show', days: [{ date: '2026-11-15' }, { date: '2026-11-14' }, { date: '2026-11-14' }, { date: 'bad' }], venue: { city: 'A', region: 'NJ' } }]).shows;
    expect(s?.days.map((d) => d.date)).toEqual(['2026-11-14', '2026-11-15']);
  });
});
