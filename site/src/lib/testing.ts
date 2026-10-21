// Helpers for tests: build rows and shows without writing every field.
import { toRow } from './index-build.ts';
import { normalizeShow } from './normalize.ts';
import type { IndexRow, Show } from './types.ts';

export function makeRow(partial: Partial<IndexRow> & { i: string }): IndexRow {
  return { n: `Sample ${partial.i}`, t: 'card_show', d: '2026-11-14', c: 'Edison', r: 'NJ', k: 'US', vf: 'l', ...partial };
}

export function makeShow(overrides: Record<string, unknown> = {}): Show {
  const raw = {
    id: 'sample-edison-card-show-edison-nj-2026-11-14',
    series_id: 'sample-edison-card-show-edison-nj',
    name: 'Sample Edison Card Show',
    event_type: 'card_show',
    status: 'scheduled',
    days: [
      { date: '2026-11-14', open: '09:00', close: '15:00' },
      { date: '2026-11-15', open: '10:00', close: '14:00' },
    ],
    timezone: 'America/New_York',
    venue: { name: 'Sample Expo Hall', address: '97 Sunfield Ave', city: 'Edison', region: 'NJ', postal: '08837', country: 'US', lat: 40.5187, lon: -74.3518, geo_precision: 'address' },
    sells: { tcg: ['pokemon', 'mtg'], sports: ['baseball'], other: [] },
    mix: 'mixed',
    admission: { free: false, adult: 5, child: 0, currency: 'USD', notes: 'Under 12 free' },
    size: { tables: 120 },
    vendor: {
      tables: [{ label: '8 ft table', price: 150, currency: 'USD', notes: '2 badges included' }],
      application_url: 'https://example.com/vendors',
      opens: '2026-08-01',
      deadline: '2026-10-31',
      status: 'open',
    },
    organizer: { name: 'Sample Promotions', promoter_id: 'sample-promotions', url: 'https://example.com' },
    links: { official: 'https://example.com/show' },
    sources: [{ source: 'fixture', url: 'https://example.com/listing', retrieved: '2026-10-21', fields: ['name', 'days'] }],
    verification: 'listed',
    first_seen: '2026-10-21',
    last_checked: '2026-10-21',
    summary: null,
    estimate: {
      attendance: { low: 400, mid: 700, high: 1100 },
      basis: 'tables',
      confidence: 'estimated',
      size_class: 'medium',
      traffic_per_table: 5.8,
      explain: 'Estimated from 120 vendor tables at a one day card show.',
    },
    ...overrides,
  };
  const show = normalizeShow(raw);
  if (!show) throw new Error('makeShow: invalid test show');
  return show;
}

export function makeShowRow(overrides: Record<string, unknown> = {}): IndexRow {
  return toRow(makeShow(overrides));
}
