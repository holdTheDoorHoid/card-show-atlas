import { describe, expect, it } from 'vitest';
import { decodeShareLink, encodeShareLink, googleMapsUrls, planSeason, planWeekendRun, type Plan, type SharePayload } from '../src/index.js';
import { sampleSeason, sampleShows, sampleVendor, sampleWeekend } from './fixtures.js';
import { rng } from './gen.js';

function bestWeekend(): Plan {
  return planWeekendRun(sampleShows(), sampleVendor(), sampleWeekend()).best!;
}

describe('Google Maps directions', () => {
  it('gives one link per trip when the plan goes home in between', () => {
    const p = bestWeekend();
    expect(p.trips.length).toBe(2);
    expect(googleMapsUrls(p)).toHaveLength(2);
  });

  it('leaves out home by default so Google starts from where you are', () => {
    const p = { ...bestWeekend(), trips: [] };
    const [link] = googleMapsUrls(p);
    const u = new URL(link!.url);
    expect(u.origin + u.pathname).toBe('https://www.google.com/maps/dir/');
    expect(u.searchParams.get('api')).toBe('1');
    expect(u.searchParams.get('travelmode')).toBe('driving');
    expect(u.searchParams.has('origin')).toBe(false);
    const last = p.stops[p.stops.length - 1]!;
    expect(u.searchParams.get('destination')).toBe(`${last.lat.toFixed(5)},${last.lon.toFixed(5)}`);
    expect(link!.url).not.toContain(p.start.lat.toFixed(5));
  });

  it('includes the start and end point when asked', () => {
    const p = { ...bestWeekend(), trips: [] };
    const u = new URL(googleMapsUrls(p, { includeStart: true })[0]!.url);
    expect(u.searchParams.get('origin')).toBe(`${p.start.lat.toFixed(5)},${p.start.lon.toFixed(5)}`);
    expect(u.searchParams.get('destination')).toBe(`${p.end.lat.toFixed(5)},${p.end.lon.toFixed(5)}`);
    expect(u.searchParams.get('waypoints')!.split('|')).toHaveLength(p.stops.length);
  });

  it('splits long routes into links of at most 9 waypoints that join end to start', () => {
    const p = bestWeekend();
    const many: Plan = { ...p, trips: [], stops: Array.from({ length: 23 }, (_, i) => ({ ...p.stops[0]!, showId: `s${i}`, lat: 40 + i / 100 })) };
    const links = googleMapsUrls(many, { includeStart: true });
    expect(links.length).toBe(3);
    let prevDest: string | null = null;
    for (const l of links) {
      const u = new URL(l.url);
      const way = u.searchParams.get('waypoints')?.split('|') ?? [];
      expect(way.length).toBeLessThanOrEqual(9);
      if (prevDest) expect(u.searchParams.get('origin')).toBe(prevDest);
      prevDest = u.searchParams.get('destination');
    }
    expect(links[0]!.label).toMatch(/part 1 of 3/);
  });

  it('gives a season plan one link per trip', () => {
    const res = planSeason(sampleShows(), sampleVendor(), sampleSeason());
    const links = googleMapsUrls(res.plan);
    expect(links.length).toBe(res.plan.trips.length);
    expect(links[0]!.label).toMatch(/^Trip 1: /);
  });
});

describe('share links', () => {
  const payload: SharePayload = {
    mode: 'season',
    showIds: [
      'garden-state-card-show-edison-nj-2026-11-14',
      'charm-city-tcg-expo-baltimore-md-2026-11-15',
      'garden-state-card-show-edison-nj-2026-12-12',
      'garden-state-card-show-edison-nj-2027-01-09',
      'odd-id-without-date',
    ],
    settings: {
      start: '2026-11-01',
      end: '2027-01-31',
      maxShowsPerMonth: 3,
      maxNightsAway: 3,
      weekendsOnly: true,
      chain: true,
      maxDriveHours: 6.5,
      weights: 'cheapest',
      blackout: ['2026-11-26'],
    },
    start: { lat: 39.95261234, lon: -75.16521234 },
  };

  it('round trips the shows and settings and leaves out the start point by default', () => {
    const link = encodeShareLink(payload);
    expect(link).toMatch(/^[A-Za-z0-9_-]+\.[0-9a-z]+$/);
    const back = decodeShareLink(link);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.showIds).toEqual(payload.showIds);
    expect(back.value.settings).toEqual(payload.settings);
    expect(back.value.mode).toBe('season');
    expect(back.value.start).toBeUndefined();
    // Not even hidden inside: the decoded body has no coordinates.
    const body = decodeBody(link);
    expect(body).not.toContain('39.95');
    expect(body).not.toContain('"h"');
  });

  it('includes a rounded start point only when asked', () => {
    const back = decodeShareLink(encodeShareLink(payload, { includeStart: true }));
    expect(back.ok && back.value.start).toEqual({ lat: 39.953, lon: -75.165 });
  });

  it('is compact for a season with repeated series', () => {
    const link = encodeShareLink(payload);
    expect(link.length).toBeLessThan(JSON.stringify(payload).length);
    const ids = Array.from({ length: 24 }, (_, i) => `garden-state-card-show-edison-nj-2026-${String(1 + (i % 12)).padStart(2, '0')}-1${i % 9}`);
    const long = encodeShareLink({ mode: 'season', showIds: ids, settings: {} });
    expect(long.length).toBeLessThan(ids.join('').length / 3);
  });

  it('rejects damaged or hostile links without throwing', () => {
    const link = encodeShareLink(payload);
    const r = rng(99);
    let rejected = 0;
    for (let i = 0; i < 3000; i++) {
      const chars = link.split('');
      const n = 1 + Math.floor(r() * 3);
      for (let k = 0; k < n; k++) {
        const at = Math.floor(r() * chars.length);
        const op = r();
        if (op < 0.4) chars[at] = String.fromCharCode(32 + Math.floor(r() * 95));
        else if (op < 0.7) chars.splice(at, 1);
        else chars.splice(at, 0, 'A');
      }
      const mutated = chars.join('');
      let res;
      expect(() => (res = decodeShareLink(mutated))).not.toThrow();
      if (!res!.ok) rejected += 1;
      else expect(res!.value.showIds.length).toBeGreaterThan(0);
    }
    expect(rejected).toBeGreaterThan(2900);
    for (const bad of ['', '.', 'abc', 'abc.def', `${'A'.repeat(20000)}.x`, '!!!.1', 'e30.1']) {
      const res = decodeShareLink(bad);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/^The link /);
    }
  });

  it('rejects well formed links with bad values', () => {
    const forge = (wire: unknown) => {
      const json = JSON.stringify(wire);
      return `${b64(json)}.${fnv(json)}`;
    };
    const cases: unknown[] = [
      { m: 'x', e: [] },
      { m: 'v', e: ['Bad ID!'] },
      { m: 'v', e: [0, 1] },
      { m: 'v', b: 20000, d: ['series'], e: [0, -1] },
      { m: 'v', e: ['ok-id'], s: { d: 99 } },
      { m: 'v', e: ['ok-id'], s: { q: 1 } },
      { m: 'v', e: ['ok-id'], h: [123, 0] },
      { m: 'v', e: ['ok-id'], z: 1 },
      { m: 'v', e: ['ok-id'], s: { a: 20500, z: 20400 } },
      [1, 2, 3],
    ];
    for (const c of cases) expect(decodeShareLink(forge(c)).ok, JSON.stringify(c)).toBe(false);
    expect(decodeShareLink(forge({ m: 'v', e: ['ok-id'], s: { o: 'home', w: 90 } }))).toEqual({
      ok: true,
      value: { mode: 'vending', showIds: ['ok-id'], settings: { overnight: 'home', dwellMinutes: 90 } },
    });
  });
});

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function b64(s: string): string {
  const bytes = [...s].map((c) => c.charCodeAt(0));
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63]!;
    if (i + 2 < bytes.length) out += B64[n & 63]!;
  }
  return out;
}
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}
function decodeBody(link: string): string {
  const s = link.slice(0, link.lastIndexOf('.'));
  let buf = 0;
  let bits = 0;
  let out = '';
  for (const ch of s) {
    buf = (buf << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buf >> bits) & 255);
    }
  }
  return out;
}
