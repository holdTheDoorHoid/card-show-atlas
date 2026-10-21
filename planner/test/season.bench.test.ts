import { beforeAll, describe, expect, it } from 'vitest';
import { planSeason, verifyPlan, type SeasonOptions } from '../src/index.js';
import { genShows, genVendor, rng } from './gen.js';
import { longestAway } from './helpers.js';

declare const console: { log(...args: unknown[]): void };

interface Proc {
  threadCpuUsage?: (prev?: { user: number; system: number }) => { user: number; system: number };
  cpuUsage: (prev?: { user: number; system: number }) => { user: number; system: number };
}
const proc = (globalThis as unknown as { process: Proc }).process;
const cpuUsage = (prev?: { user: number; system: number }) => (proc.threadCpuUsage ? proc.threadCpuUsage(prev) : proc.cpuUsage(prev));

/**
 * DESIGN 6.4 performance target: about 2,000 candidate shows over 6 months in a browser worker in
 * under 2 seconds. Node runs the same JavaScript engine as Chrome, so this is a fair proxy.
 *
 * Each case is a cold run of its own data. The planner's own CPU time (this thread) must stay under
 * the limit. Wall time must too, unless the machine is overloaded by other work (load average above
 * the number of cores), when wall time measures the other work and is only logged.
 */
const LIMIT_MS = 2000;
let overloaded = false;
let cores = 1;
let load = 0;

function bench(label: string, dense: boolean, options: Partial<SeasonOptions>, seed: number) {
  const r = rng(seed);
  const center = dense ? { lat: 40.2, lon: -76.5 } : { lat: 38.5, lon: -92 };
  const shows = genShows(r, {
    n: 2060,
    start: '2026-11-01',
    spanDays: 181,
    center,
    spreadDeg: dense ? 3 : 9,
    multiDay: 0.3,
    weekendBias: true,
    zones: dense ? ['America/New_York'] : ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'],
    statuses: ['open', 'open', 'open', 'open', 'open', 'open', 'open', 'waitlist', 'unknown'],
  });
  const settings = genVendor(r, center, options.objective !== 'score');
  settings.max_drive_hours_per_day = 7;
  settings.hotel_per_night = 110;
  settings.food_per_day = 40;
  const opts: SeasonOptions = {
    range: { start: '2026-11-01', end: '2027-04-30' },
    today: '2026-10-21',
    keepPastDeadline: true,
    ...options,
  };
  const c0 = cpuUsage();
  const t0 = Date.now();
  const res = planSeason(shows, settings, opts);
  const ms = Date.now() - t0;
  const c1 = cpuUsage(c0);
  const cpuMs = Math.round((c1.user + c1.system) / 1000);
  console.log(
    `[bench] ${label}: ${ms} ms wall, ${cpuMs} ms cpu (load ${load.toFixed(1)} on ${cores} cores), ` +
      `${res.stats.candidates} candidates, ${res.stats.labels} labels, ${res.stats.edges} edges, ` +
      `${res.plan.stops.length} shows in ${res.plan.trips.length} trips, ${res.plan.money.label}`,
  );
  return { res, ms, cpuMs, shows, settings, opts };
}

describe('season planner benchmark (about 2,000 candidate shows, 6 months)', () => {
  beforeAll(async () => {
    const os = (await import('node:os' as string)) as { loadavg(): number[]; availableParallelism?(): number; cpus(): unknown[] };
    cores = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
    load = os.loadavg()[0] ?? 0;
    overloaded = load > cores;
  });

  const cases: [string, boolean, Partial<SeasonOptions>][] = [
    ['dense region, 4 a month, 5 nights away, chained', true, { maxShowsPerMonth: 4, maxNightsAway: 5, chain: true }],
    ['dense region, no limits, chained', true, { chain: true }],
    ['nationwide, 6 a month, 10 nights away, chained', false, { maxShowsPerMonth: 6, maxNightsAway: 10, chain: true }],
    ['dense region, home between shows', true, { maxShowsPerMonth: 4, chain: false }],
    ['dense region, by priority score', true, { maxShowsPerMonth: 4, maxNightsAway: 3, objective: 'score' }],
  ];
  for (const [label, dense, options] of cases) {
    it(`${label}: under ${LIMIT_MS} ms and feasible`, () => {
      const { res, ms, cpuMs, shows, settings, opts } = bench(label, dense, options, 77);
      expect(cpuMs).toBeLessThan(LIMIT_MS);
      if (!overloaded) expect(ms).toBeLessThan(LIMIT_MS);
      expect(res.stats.candidates).toBeGreaterThanOrEqual(1950);
      expect(res.plan.stops.length).toBeGreaterThan(0);
      expect(verifyPlan(res.plan, shows, { settings, blackout: opts.blackout })).toEqual([]);
      if (opts.maxShowsPerMonth) {
        const perMonth = new Map<string, number>();
        for (const s of res.plan.stops) perMonth.set(s.firstDate.slice(0, 7), (perMonth.get(s.firstDate.slice(0, 7)) ?? 0) + 1);
        for (const c of perMonth.values()) expect(c).toBeLessThanOrEqual(opts.maxShowsPerMonth);
      }
      if (opts.maxNightsAway !== undefined && opts.maxNightsAway !== null) {
        expect(longestAway(res.plan.nights)).toBeLessThanOrEqual(opts.maxNightsAway);
      }
      if (opts.chain === false) for (const t of res.plan.trips) expect(t.showIds).toHaveLength(1);
    });
  }
});
