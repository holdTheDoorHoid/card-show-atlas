import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRAVEL_MODEL,
  EstimateRouteProvider,
  estimateLeg,
  haversineMiles,
  hoursForRoadMiles,
  KM_PER_MILE,
  resolveTravelModel,
  Travel,
} from '../src/travel.js';
import { rng } from './gen.js';

const NYC = { lat: 40.7128, lon: -74.006 };
const PHL = { lat: 39.9526, lon: -75.1652 };
const LA = { lat: 34.0522, lon: -118.2437 };

describe('travel model', () => {
  it('measures great circle distances', () => {
    expect(haversineMiles(NYC, PHL)).toBeCloseTo(80.6, 0);
    expect(haversineMiles(NYC, LA)).toBeCloseTo(2445, -1);
    expect(haversineMiles(NYC, NYC)).toBe(0);
  });

  it('applies the road factor and reports miles, km and hours', () => {
    const leg = estimateLeg(NYC, PHL);
    expect(leg.miles).toBeCloseTo(haversineMiles(NYC, PHL) * 1.25, 9);
    expect(leg.km).toBeCloseTo(leg.miles * KM_PER_MILE, 9);
    expect(leg.hours).toBeGreaterThan(1.5);
    expect(leg.hours).toBeLessThan(2.2);
    expect(leg.source).toBe('estimate');
  });

  it('drives slower on short legs and never takes less time for a longer leg', () => {
    let prev = 0;
    for (let mi = 0.5; mi < 1500; mi *= 1.3) {
      const h = hoursForRoadMiles(mi);
      expect(h).toBeGreaterThanOrEqual(prev);
      prev = h;
    }
    const avg = (mi: number) => mi / hoursForRoadMiles(mi);
    expect(avg(3)).toBeLessThan(avg(30));
    expect(avg(30)).toBeLessThan(avg(300));
    expect(avg(3000)).toBeLessThan(DEFAULT_TRAVEL_MODEL.cruiseMph);
    expect(estimateLeg(NYC, NYC).hours).toBe(0);
  });

  it('keeps the triangle inequality, so skipping a stop never makes a route longer', () => {
    const r = rng(3);
    for (let i = 0; i < 2000; i++) {
      const p = () => ({ lat: 38 + r() * 4, lon: -78 + r() * 5 });
      const a = p();
      const b = p();
      const c = p();
      expect(estimateLeg(a, c).hours).toBeLessThanOrEqual(estimateLeg(a, b).hours + estimateLeg(b, c).hours + 1e-12);
    }
  });

  it('is configurable and validates its settings', () => {
    const fast = resolveTravelModel({ roadFactor: 1.1, cruiseMph: 70 });
    expect(estimateLeg(NYC, LA, fast).hours).toBeLessThan(estimateLeg(NYC, LA).hours);
    const withOverhead = resolveTravelModel({ overheadMinutes: 15 });
    expect(estimateLeg(NYC, PHL, withOverhead).hours - estimateLeg(NYC, PHL).hours).toBeCloseTo(0.25, 9);
    expect(() => resolveTravelModel({ roadFactor: 0.5 })).toThrow(/Road factor/);
    expect(() => resolveTravelModel({ bands: [{ miles: 0, mph: 10 }] })).toThrow(/speed band/);
  });

  it('uses known legs first and estimates the rest', async () => {
    const t = new Travel(null, { points: [NYC, PHL], miles: [[0, 95], [96, 0]], hours: [[0, 1.75], [1.8, 0]], source: 'osrm' });
    expect(t.leg(NYC, PHL)).toEqual({ miles: 95, km: 95 * KM_PER_MILE, hours: 1.75, source: 'osrm' });
    expect(t.leg(PHL, NYC).hours).toBe(1.8);
    expect(t.leg(NYC, LA).source).toBe('estimate');
    const out = { miles: 0, hours: 0 };
    t.fill(NYC, PHL, out);
    expect(out).toEqual({ miles: 95, hours: 1.75 });
    const p = new EstimateRouteProvider();
    const m = await p.table([NYC, PHL, LA]);
    expect(m.hours[0]![1]).toBeCloseTo(estimateLeg(NYC, PHL).hours, 12);
    expect(m.miles[2]![2]).toBe(0);
  });
});

describe('pair estimates used by the search', () => {
  it('give exactly the same numbers as the shared estimate', async () => {
    const { cosLatitude, haversineCos, latitudeGapMiles } = await import('../src/travel.js');
    const r = rng(8);
    for (let i = 0; i < 5000; i++) {
      const a = { lat: 25 + r() * 25, lon: -125 + r() * 60 };
      const b = { lat: 25 + r() * 25, lon: -125 + r() * 60 };
      expect(haversineCos(a.lat, a.lon, cosLatitude(a.lat), b.lat, b.lon, cosLatitude(b.lat))).toBe(haversineMiles(a, b));
      expect(latitudeGapMiles(a.lat, b.lat)).toBeLessThanOrEqual(haversineMiles(a, b) + 1e-9);
      const out = { miles: 0, hours: 0 };
      new Travel().fromStraight(haversineMiles(a, b), out);
      expect(out.hours).toBe(estimateLeg(a, b).hours);
    }
  });
});

describe('road miles for hours', () => {
  it('inverts the speed bands', async () => {
    const { roadMilesForHours } = await import('../src/travel.js');
    for (let mi = 0.5; mi < 3000; mi *= 1.17) expect(roadMilesForHours(hoursForRoadMiles(mi))).toBeCloseTo(mi, 6);
    expect(roadMilesForHours(0)).toBe(0);
  });
});
