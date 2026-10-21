import { describe, expect, it } from 'vitest';
import {
  addressLines,
  dayRows,
  directionsUrl,
  entryLines,
  isPast,
  jsonLdFor,
  sizeView,
  sourceViews,
  staleNotice,
  statusNotice,
  vendorView,
  verificationView,
  whenHeadline,
} from './showview.ts';
import { makeShow } from './testing.ts';
import type { ManifestSource } from './types.ts';

const sources = new Map<string, ManifestSource>([['example_calendar', { id: 'example_calendar', name: 'Example Card Show Calendar', url: 'https://calendar.example.org', kind: 'aggregator', credit: 'Listed by Example Card Show Calendar' }]]);

describe('show page text', () => {
  const show = makeShow();

  it('writes the dates and hours with the time zone', () => {
    expect(whenHeadline(show)).toBe('Nov 14 to 15, 2026');
    const rows = dayRows(show);
    expect(rows[0]).toMatchObject({ label: 'Saturday, November 14, 2026', hours: '9 am to 3 pm', zone: 'EST' });
    expect(rows[1]?.hours).toBe('10 am to 2 pm');
    expect(dayRows(makeShow({ days: [{ date: '2026-11-14' }] }))[0]).toMatchObject({ hours: 'Hours not listed', zone: '' });
  });

  it('knows when a show is over', () => {
    expect(isPast(show, '2026-11-15')).toBe(false);
    expect(isPast(show, '2026-11-16')).toBe(true);
  });

  it('writes the address', () => {
    expect(addressLines(show)).toEqual(['Sample Expo Hall', '97 Sunfield Ave', 'Edison, NJ 08837']);
  });

  it('links to directions by coordinates when the place is exact, by words when it is not', () => {
    expect(directionsUrl(show)).toBe('https://www.google.com/maps/dir/?api=1&destination=40.5187,-74.3518');
    const soft = makeShow({ venue: { name: 'Sample Hall', city: 'Edison', region: 'NJ', lat: 40.5, lon: -74.4, geo_precision: 'city' } });
    expect(directionsUrl(soft)).toContain('destination=Sample%20Hall%2C%20Edison%2C%20NJ');
  });

  it('warns about shows that are off or unsure', () => {
    expect(statusNotice(show)).toBeNull();
    expect(statusNotice(makeShow({ status: 'cancelled' }))?.kind).toBe('bad');
    expect(statusNotice(makeShow({ status: 'postponed' }))?.text).toMatch(/postponed/);
    expect(statusNotice(makeShow({ status: 'tentative' }))?.kind).toBe('warn');
  });

  it('says when the listing has not been checked for a while', () => {
    expect(staleNotice(show, '2026-11-01')).toBeNull(); // checked 11 days ago
    expect(staleNotice(show, '2026-12-20')).toBeNull(); // the show is over by then: no point
    const old = makeShow({ last_checked: '2026-08-01' });
    expect(staleNotice(old, '2026-11-01')).toMatch(/92 days ago and may be out of date/);
  });

  it('lists entry prices', () => {
    expect(entryLines(show)).toEqual(['Adults $5', 'Children free', 'Under 12 free']);
    expect(entryLines(makeShow({ admission: { free: true } }))).toEqual(['Free entry']);
    expect(entryLines(makeShow({ admission: {} }))).toEqual(['Entry price not listed']);
    expect(entryLines(makeShow({ admission: { adult: 8, child: 4, currency: 'CAD' } }))).toEqual(['Adults $8 CAD', 'Children $4 CAD']);
  });
});

describe('size badge and how we know', () => {
  it('explains where the size comes from', () => {
    const v = sizeView(makeShow());
    expect(v.badge).toBe('Medium');
    expect(v.how).toBe('Estimated from 120 vendor tables at a one day card show.');
    expect(v.confidence).toBe('Estimated');
    expect(v.range).toBe('About 400 to 1,100 people, most likely around 700');
    expect(v.traffic).toBe('5.8 people per table');
  });

  it('says so plainly when there is no estimate', () => {
    const v = sizeView(makeShow({ estimate: null }));
    expect(v.badge).toBe('Size unknown');
    expect(v.how).toMatch(/do not have enough information/);
    expect(v.range).toBeNull();
  });

  it('says size unknown when the only basis is the type of event', () => {
    const e = { attendance: { low: 100, mid: 200, high: 300 }, basis: 'type_default', confidence: 'rough', size_class: 'medium', traffic_per_table: null, explain: '' };
    const v = sizeView(makeShow({ estimate: e as never }));
    expect(v.badge).toBe('Size unknown');
    expect(v.range).toBeNull();
  });

  it('writes its own explanation when the estimate has none', () => {
    const e = { attendance: { low: 100, mid: 200, high: 300 }, basis: 'history', confidence: 'rough', size_class: 'small', traffic_per_table: null, explain: '' };
    expect(sizeView(makeShow({ estimate: e })).how).toBe('Estimated from past years.');
  });
});

describe('vendor box and sources', () => {
  it('reads the vendor status', () => {
    expect(vendorView(makeShow())).toMatchObject({ hasInfo: true, statusText: 'Tables are open', statusKind: 'ok' });
    expect(vendorView(makeShow({ vendor: {} }))).toMatchObject({ hasInfo: false, statusKind: 'plain' });
    expect(vendorView(makeShow({ vendor: { status: 'sold_out' } }))).toMatchObject({ hasInfo: true, statusKind: 'bad' });
  });

  it('credits each source, using the credit text in the manifest', () => {
    const show = makeShow({ sources: [{ source: 'example_calendar', url: 'https://calendar.example.org/show/123', retrieved: '2026-10-21', fields: ['name', 'days', 'venue'] }, { source: 'unlisted_source', url: null, fields: [] }] });
    const [a, b] = sourceViews(show, sources);
    expect(a).toMatchObject({ name: 'Example Card Show Calendar', credit: 'Listed by Example Card Show Calendar', url: 'https://calendar.example.org/show/123', retrieved: 'Oct 21, 2026', fields: 'name, days, venue' });
    expect(b).toMatchObject({ name: 'unlisted source', credit: 'Listed by unlisted source' });
  });

  it('shows the right verification badge', () => {
    const listed = makeShow({ verification: 'listed', sources: [{ source: 'example_calendar' }] });
    expect(verificationView(listed, sources)).toMatchObject({ text: 'Listed by Example Card Show Calendar', kind: 'accent' });
    expect(verificationView(makeShow({ verification: 'organizer_confirmed' }), sources)).toMatchObject({ text: 'Confirmed by organizer', kind: 'ok' });
    expect(verificationView(makeShow({ verification: 'community' }), sources).text).toBe('Community submitted');
    expect(verificationView(makeShow({ verification: 'unverified' }), sources).text).toBe('Not yet verified');
  });
});

describe('structured data for search engines', () => {
  it('describes the event', () => {
    const ld = jsonLdFor(makeShow(), 'https://example.com/x/');
    expect(ld).toMatchObject({ '@type': 'Event', name: 'Sample Edison Card Show', startDate: '2026-11-14T09:00', endDate: '2026-11-15T14:00', url: 'https://example.com/x/' });
    expect((ld.location as { address: { addressRegion: string } }).address.addressRegion).toBe('NJ');
    expect(jsonLdFor(makeShow({ status: 'cancelled' }), 'u').eventStatus).toBe('https://schema.org/EventCancelled');
  });
});
