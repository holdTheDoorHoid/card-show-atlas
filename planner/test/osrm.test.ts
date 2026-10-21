import { describe, expect, it } from 'vitest';
import { checkRealDriveTimes, OsrmRouteProvider, planWeekendRun, type FetchLike, type LatLon, type RouteProvider, type WeekendRunOptions } from '../src/index.js';
import { estimateLeg } from '../src/travel.js';
import { mk, PHILLY, vendor } from './helpers.js';

interface Call {
  url: string;
}

/** A fake fetch that answers like OSRM, scaling the estimate by `slow`. Never touches the network. */
function fakeOsrm(slow = 1.2, status = 200, body?: unknown): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push({ url });
    if (body !== undefined) return { ok: status < 400, status, json: async () => body };
    const coords = decodeURIComponent(url.split('/table/v1/driving/')[1]!.split('?')[0]!)
      .split(';')
      .map((c) => {
        const [lon, lat] = c.split(',').map(Number);
        return { lat: lat!, lon: lon! };
      });
    const durations = coords.map((a) => coords.map((b) => estimateLeg(a, b).hours * 3600 * slow));
    const distances = coords.map((a) => coords.map((b) => estimateLeg(a, b).miles * 1609.344));
    return { ok: status < 400, status, json: async () => ({ code: 'Ok', durations, distances }) };
  };
  return { fetch, calls };
}

const A = { lat: 40.6084, lon: -75.4902 };
const B = { lat: 39.2904, lon: -76.6122 };

describe('OSRM adapter', () => {
  it('makes exactly one table request, with lon,lat order, and reads hours and miles', async () => {
    const f = fakeOsrm(1);
    const p = new OsrmRouteProvider({ fetch: f.fetch, minIntervalMs: 0 });
    const m = await p.table([PHILLY, A, B]);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe(
      'https://router.project-osrm.org/table/v1/driving/-75.165200,39.952600;-75.490200,40.608400;-76.612200,39.290400?annotations=duration,distance',
    );
    expect(m.source).toBe('osrm');
    expect(m.hours[0]![1]).toBeCloseTo(estimateLeg(PHILLY, A).hours, 9);
    expect(m.miles[0]![2]).toBeCloseTo(estimateLeg(PHILLY, B).miles, 6);
  });

  it('caches, and refuses rapid repeat requests instead of queueing or looping', async () => {
    let now = 0;
    const f = fakeOsrm(1);
    const p = new OsrmRouteProvider({ fetch: f.fetch, now: () => now });
    await p.table([PHILLY, A]);
    await p.table([PHILLY, A]);
    expect(f.calls).toHaveLength(1);
    await expect(p.table([PHILLY, B])).rejects.toMatchObject({ code: 'routing_busy' });
    expect(f.calls).toHaveLength(1);
    now = 5000;
    await p.table([PHILLY, B]);
    expect(f.calls).toHaveLength(2);
    expect(p.requestCount).toBe(2);
  });

  it('never retries on errors and explains them plainly', async () => {
    const cases: [number, unknown, string][] = [
      [429, {}, 'routing_rate_limited'],
      [500, {}, 'routing_http'],
      [200, { code: 'NoRoute' }, 'routing_failed'],
      [200, { code: 'Ok', durations: [[0]], distances: [[0]] }, 'routing_bad_reply'],
    ];
    for (const [status, body, code] of cases) {
      const f = fakeOsrm(1, status, body);
      const p = new OsrmRouteProvider({ fetch: f.fetch, minIntervalMs: 0 });
      await expect(p.table([PHILLY, A])).rejects.toMatchObject({ code });
      expect(f.calls).toHaveLength(1);
    }
    const throwing = new OsrmRouteProvider({ fetch: async () => { throw new Error('offline'); }, minIntervalMs: 0 });
    await expect(throwing.table([PHILLY, A])).rejects.toMatchObject({ code: 'routing_unavailable' });
  });

  it('times out instead of hanging', async () => {
    const p = new OsrmRouteProvider({ fetch: () => new Promise(() => {}), timeoutMs: 20, minIntervalMs: 0 });
    await expect(p.table([PHILLY, A])).rejects.toMatchObject({ code: 'routing_timeout' });
  });

  it('refuses too many points rather than splitting into several requests', async () => {
    const f = fakeOsrm(1);
    const p = new OsrmRouteProvider({ fetch: f.fetch, maxPoints: 3, minIntervalMs: 0 });
    await expect(p.table([PHILLY, A, B, PHILLY])).rejects.toMatchObject({ code: 'routing_too_many_points' });
    expect(f.calls).toHaveLength(0);
  });

  it('reads a route through several points in one request', async () => {
    const calls: string[] = [];
    const p = new OsrmRouteProvider({
      minIntervalMs: 0,
      fetch: async (url) => {
        calls.push(url);
        return { ok: true, status: 200, json: async () => ({ code: 'Ok', routes: [{ legs: [{ duration: 3600, distance: 1609.344 * 50 }, { duration: 7200, distance: 1609.344 * 120 }] }] }) };
      },
    });
    const r = await p.route([PHILLY, A, B]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/\/route\/v1\/driving\/.*overview=false/);
    expect(r.hours).toBeCloseTo(3, 9);
    expect(r.miles).toBeCloseTo(170, 9);
  });
});

describe('check real drive times', () => {
  const shows = [
    mk('sat', { days: [['2026-11-14', '09:00', '15:00']], ...A }),
    mk('sun', { days: [['2026-11-15', '10:00', '16:00']], ...B, mid: 2500, size: 'large' }),
  ];
  const settings = vendor({ max_drive_hours_per_day: 8 });
  const options: WeekendRunOptions = { mode: 'vending', dates: { start: '2026-11-14', end: '2026-11-15' }, today: '2026-10-21' };

  it('uses one table request per plan check and relabels the plan', async () => {
    const plan = planWeekendRun(shows, settings, options).best!;
    const f = fakeOsrm(1.2);
    const provider = new OsrmRouteProvider({ fetch: f.fetch, minIntervalMs: 0 });
    const res = await checkRealDriveTimes(plan, { kind: 'weekend', shows, settings, options }, provider);
    expect(f.calls).toHaveLength(1);
    expect(res.ok).toBe(true);
    expect(res.plan!.driveTimes.source).toBe('osrm');
    expect(res.plan!.legs.every((l) => l.source === 'osrm')).toBe(true);
    expect(res.changes[0]).toMatch(/still fit/);
    expect(res.changes.some((c) => /more than estimated/.test(c))).toBe(true);
    expect(res.problems).toEqual([]);
  });

  it('reports a show that no longer fits', async () => {
    const tight = vendor({ max_drive_hours_per_day: 4.6 });
    const plan = planWeekendRun(shows, tight, options).best!;
    expect(plan.stops.length).toBe(2);
    const provider = new OsrmRouteProvider({ fetch: fakeOsrm(2).fetch, minIntervalMs: 0 });
    const res = await checkRealDriveTimes(plan, { kind: 'weekend', shows, settings: tight, options }, provider);
    expect(res.problems.length).toBeGreaterThan(0);
    expect(res.problems.join(' ')).toMatch(/no longer fits/);
  });

  it('keeps the estimate, clearly labeled, when the service is unavailable', async () => {
    const plan = planWeekendRun(shows, settings, options).best!;
    const down: RouteProvider = { name: 'down', label: 'down', table: async (_: LatLon[]) => { throw new Error('offline'); } };
    const res = await checkRealDriveTimes(plan, { kind: 'weekend', shows, settings, options }, down);
    expect(res.ok).toBe(false);
    expect(res.source).toBe('estimate');
    expect(res.label).toMatch(/estimates stand/);
    expect(res.plan).toBe(plan);
  });
});
