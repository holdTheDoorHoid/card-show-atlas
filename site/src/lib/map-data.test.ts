import { describe, expect, it } from 'vitest';
import { boundsOf, groupPlaces, popupHtml } from './map-data.ts';
import { markerSvg, EVENT_TYPE_INFO, SHOW_EVENT_TYPES } from './labels.ts';
import { makeRow } from './testing.ts';
import type { EventType } from './types.ts';

const showHref = (id: string) => `/card-show-atlas/shows/${id}/`;

describe('places', () => {
  it('puts shows at the same venue on one marker, soonest first', () => {
    const rows = [
      makeRow({ i: 'b', d: '2026-12-01', ll: [40.5187, -74.3518], t: 'convention' }),
      makeRow({ i: 'a', d: '2026-11-01', ll: [40.51871, -74.35179], t: 'card_show' }),
      makeRow({ i: 'c', d: '2026-11-01', ll: [41, -75] }),
      makeRow({ i: 'nowhere', d: '2026-11-01' }),
    ];
    const places = groupPlaces(rows);
    expect(places).toHaveLength(2);
    const shared = places.find((p) => p.rows.length === 2);
    expect(shared?.rows.map((r) => r.i)).toEqual(['a', 'b']);
    expect(shared?.type).toBe('card_show');
  });

  it('is soft only when every show there has an approximate location', () => {
    const soft = groupPlaces([makeRow({ i: 'a', ll: [40, -75], g: 'postal' }), makeRow({ i: 'b', ll: [40, -75], g: 'city' })]);
    expect(soft[0]?.soft).toBe(true);
    const mixed = groupPlaces([makeRow({ i: 'a', ll: [40, -75], g: 'postal' }), makeRow({ i: 'b', ll: [40, -75] })]);
    expect(mixed[0]?.soft).toBe(false);
  });

  it('finds bounds', () => {
    expect(boundsOf([])).toBeNull();
    expect(boundsOf([makeRow({ i: 'a', ll: [40, -75] }), makeRow({ i: 'b', ll: [42, -71] }), makeRow({ i: 'c' })])).toEqual([[40, -75], [42, -71]]);
  });
});

describe('marker cards', () => {
  it('shows the essentials with a link to the show page', () => {
    const [p] = groupPlaces([makeRow({ i: 'sample-a', n: 'Sample A', d: '2026-11-14', e: '2026-11-15', ll: [40, -75], sz: 'large', fr: 1 })]);
    const html = popupHtml(p!, { showHref });
    expect(html).toContain('Sample A');
    expect(html).toContain('Nov 14 to 15');
    expect(html).toContain('Edison, NJ');
    expect(html).toContain('Large');
    expect(html).toContain('Free entry');
    expect(html).toContain('href="/card-show-atlas/shows/sample-a/"');
  });

  it('escapes names so data cannot inject markup', () => {
    const [p] = groupPlaces([makeRow({ i: 'x', n: '<script>alert(1)</script> "Cards"', c: 'A&B', ll: [40, -75] })]);
    const html = popupHtml(p!, { showHref });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('A&amp;B');
  });

  it('says when the location is approximate', () => {
    const [p] = groupPlaces([makeRow({ i: 'x', ll: [40, -75], g: 'postal' })]);
    expect(popupHtml(p!, { showHref })).toContain('Approximate location');
  });

  it('lists several shows at one place', () => {
    const rows = Array.from({ length: 11 }, (_, k) => makeRow({ i: `s${k}`, n: `Sample ${k}`, d: `2026-11-${String(k + 1).padStart(2, '0')}`, ll: [40, -75] }));
    const [p] = groupPlaces(rows);
    const html = popupHtml(p!, { showHref });
    expect(html).toContain('11 shows here');
    expect(html).toContain('and 3 more');
    expect(html.match(/<li>/g)).toHaveLength(8);
  });

  it('store events link to their own page, never to a javascript link', () => {
    const [p] = groupPlaces([makeRow({ i: 'st', t: 'store_event', ll: [40, -75], u: 'javascript:alert(1)' })]);
    expect(popupHtml(p!, { showHref, isStoreLayer: true })).not.toContain('javascript:');
    const [q] = groupPlaces([makeRow({ i: 'st', t: 'store_event', ll: [40, -75], u: 'https://example.com/store' })]);
    expect(popupHtml(q!, { showHref, isStoreLayer: true })).toContain('href="https://example.com/store"');
  });
});

describe('marker symbols', () => {
  it('give every event type its own shape and its own colour', () => {
    const types = Object.keys(EVENT_TYPE_INFO) as EventType[];
    expect(new Set(types.map((t) => EVENT_TYPE_INFO[t].shape)).size).toBe(types.length);
    expect(new Set(types.map((t) => EVENT_TYPE_INFO[t].color)).size).toBe(types.length);
    expect(SHOW_EVENT_TYPES).not.toContain('store_event');
  });

  it('draw approximate locations softer and dashed', () => {
    const solid = markerSvg('card_show');
    const soft = markerSvg('card_show', { soft: true });
    expect(solid).not.toContain('stroke-dasharray');
    expect(soft).toContain('stroke-dasharray');
    expect(soft).toContain('fill-opacity');
    expect(solid).toContain('<svg');
  });
});
