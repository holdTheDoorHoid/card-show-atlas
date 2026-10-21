import { describe, expect, it } from 'vitest';
import { planSeason, verifyPlan, type SeasonOptions } from '../src/index.js';
import { bruteVending } from './brute.js';
import { sampleSeason, sampleShows, sampleVendor, sampleVendorNoSales } from './fixtures.js';
import { between, genShows, genVendor, intBetween, pick, rng } from './gen.js';
import { longestAway, mk, PHILLY, seasonSetup, vendor } from './helpers.js';
import { addDays } from '../src/time.js';

const EDISON = { lat: 40.5187, lon: -74.3518 };
const PITTSBURGH = { lat: 40.4406, lon: -79.9959 };
const COLUMBUS = { lat: 39.9612, lon: -82.9988 };

function perMonth(plan: { stops: { firstDate: string }[] }): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of plan.stops) m.set(s.firstDate.slice(0, 7), (m.get(s.firstDate.slice(0, 7)) ?? 0) + 1);
  return m;
}

describe('season planner: sample fixture', () => {
  it('plans a feasible season within the rules and lists deadlines in date order', () => {
    const shows = sampleShows();
    const s = sampleVendor();
    const o = sampleSeason();
    const res = planSeason(shows, s, o);
    const p = res.plan;
    expect(p.stops.length).toBeGreaterThan(3);
    expect(verifyPlan(p, shows, { settings: s, blackout: o.blackout })).toEqual([]);
    for (const c of perMonth(p).values()) expect(c).toBeLessThanOrEqual(o.maxShowsPerMonth!);
    expect(longestAway(p.nights)).toBeLessThanOrEqual(o.maxNightsAway!);
    for (const st of p.stops) for (const d of st.dates) expect([0, 6]).toContain(new Date(`${d}T12:00:00Z`).getUTCDay());
    const dated = res.deadlines.filter((d) => d.date).map((d) => d.date!);
    expect(dated).toEqual([...dated].sort());
    expect(res.deadlines.length).toBe(p.stops.length);
    expect(res.totals.money.profit!.mid).toBeCloseTo(p.value, 4);
    expect(res.totals.trips).toBe(p.trips.length);
    for (const t of p.trips) expect(t.departDate <= t.returnDate).toBe(true);
    expect(res.excluded.find((e) => e.id.startsWith('big-apple'))!.reason).toBe('Not on a weekend');
  });

  it('marks shows with a passed deadline as waitlist only when asked to keep them', () => {
    const shows = sampleShows();
    const s = sampleVendor();
    const late = { ...sampleSeason(), today: '2026-11-12' };
    const dropped = planSeason(shows, s, late);
    expect(dropped.excluded.some((e) => /Deadline passed \(Nov 1\)/.test(e.reason))).toBe(true);
    const kept = planSeason(shows, s, { ...late, keepPastDeadline: true });
    const marked = kept.deadlines.filter((d) => d.passed);
    expect(marked.length).toBeGreaterThan(0);
    for (const d of marked) expect(d.label).toMatch(/^Deadline passed [A-Z][a-z]{2} \d+, waitlist only$/);
  });

  it('falls back to priority score without typical sales, and says so', () => {
    const res = planSeason(sampleShows(), sampleVendorNoSales(), sampleSeason());
    expect(res.plan.objective).toBe('score');
    expect(res.plan.money.profit).toBeNull();
    expect(res.warnings.join(' ')).toMatch(/Planned by priority score because typical sales are not set/);
  });
});

describe('season planner: rules', () => {
  // Four Saturdays, all far enough to need a hotel, and a Sunday near home.
  const sat = (d: string, i: number) => mk(`sat-${i}`, { days: [[d, '09:00', '16:00']], ...(i % 2 ? PITTSBURGH : COLUMBUS), mid: 3000, size: 'large' });
  const shows = [
    sat('2026-11-07', 0),
    sat('2026-11-14', 1),
    sat('2026-11-21', 2),
    sat('2026-11-28', 3),
    mk('sun-near', { days: [['2026-11-08', '10:00', '16:00']], ...EDISON }),
    mk('dec', { days: [['2026-12-05', '10:00', '16:00']], ...EDISON }),
  ];
  const base: SeasonOptions = { range: { start: '2026-11-01', end: '2026-12-31' }, today: '2026-10-21' };
  const s = vendor({ max_drive_hours_per_day: 8 });

  it('caps shows per calendar month', () => {
    const open = planSeason(shows, s, base).plan;
    expect(open.stops.filter((x) => x.firstDate.startsWith('2026-11')).length).toBeGreaterThan(2);
    const capped = planSeason(shows, s, { ...base, maxShowsPerMonth: 2 }).plan;
    expect(perMonth(capped).get('2026-11')).toBe(2);
    expect(perMonth(capped).get('2026-12')).toBe(1);
  });

  it('limits nights away in a row', () => {
    for (const n of [0, 1, 2, 3]) {
      const p = planSeason(shows, s, { ...base, maxNightsAway: n }).plan;
      expect(longestAway(p.nights)).toBeLessThanOrEqual(n);
      expect(verifyPlan(p, shows, { settings: s })).toEqual([]);
    }
    expect(planSeason(shows, s, { ...base, maxNightsAway: 0 }).plan.hotelNights).toBe(0);
  });

  it('goes home between shows when chaining is off', () => {
    const p = planSeason(shows, s, { ...base, chain: false }).plan;
    for (const t of p.trips) expect(t.showIds).toHaveLength(1);
  });

  it('keeps every blackout day at home', () => {
    const p = planSeason(shows, s, { ...base, blackout: ['2026-11-13', '2026-11-20', '2026-12-05'] }).plan;
    expect(p.stops.map((x) => x.showId)).not.toContain('dec');
    expect(verifyPlan(p, shows, { settings: s, blackout: ['2026-11-13', '2026-11-20', '2026-12-05'] })).toEqual([]);
  });

  it('can leave out shows that are too far', () => {
    const res = planSeason(shows, s, { ...base, maxDriveHoursFromHome: 3 });
    expect(res.plan.stops.every((x) => x.showId === 'sun-near' || x.showId === 'dec')).toBe(true);
    expect(res.excluded.some((e) => /^More than 3 h from home$/.test(e.reason))).toBe(true);
  });

  it('rejects bad options plainly', () => {
    expect(() => planSeason(shows, s, { ...base, maxShowsPerMonth: 1.5 })).toThrow(/whole number/);
    expect(() => planSeason(shows, s, { ...base, range: { start: '2026-12-01', end: '2026-11-01' } })).toThrow(/before the start/);
    expect(() => planSeason(shows, { ...s, home: null }, base)).toThrow(/home location/);
  });
});

describe('season planner: exact against brute force on random instances', () => {
  const N = 150;
  it(`matches brute force and passes the independent checks on ${N} instances`, () => {
    for (let k = 0; k < N; k++) {
      const r = rng(30_000 + k);
      const home = { lat: between(r, 39.5, 40.5), lon: between(r, -76, -75) };
      const start = pick(r, ['2026-11-01', '2026-11-20', '2026-12-10']);
      const shows = genShows(r, {
        n: intBetween(r, 3, 9),
        start,
        spanDays: 40,
        center: home,
        spreadDeg: pick(r, [0.7, 2, 4]),
        multiDay: 0.3,
        weekendBias: r() < 0.5,
      });
      const settings = genVendor(r, home, r() < 0.8);
      const end = addDays(start, 45);
      const blackout = r() < 0.3 ? [addDays(start, intBetween(r, 0, 40)), addDays(start, intBetween(r, 0, 40))] : undefined;
      const options: SeasonOptions = {
        range: { start, end },
        today: '2026-10-01',
        maxShowsPerMonth: r() < 0.5 ? intBetween(r, 1, 3) : null,
        maxNightsAway: r() < 0.5 ? intBetween(r, 0, 4) : null,
        chain: r() < 0.8,
        blackout,
        maxChainGapDays: pick(r, [3, 7]),
      };
      const { engine, brute } = seasonSetup(shows, settings, options);
      const dp = engine.solve();
      const bf = bruteVending(engine, brute);
      expect(dp.value, `instance ${k}`).toBeCloseTo(bf, 6);
      const res = planSeason(shows, settings, options);
      const p = res.plan;
      expect(verifyPlan(p, shows, { settings, blackout }), `instance ${k}`).toEqual([]);
      if (options.maxShowsPerMonth) for (const c of perMonth(p).values()) expect(c).toBeLessThanOrEqual(options.maxShowsPerMonth);
      if (options.maxNightsAway !== null && options.maxNightsAway !== undefined) expect(longestAway(p.nights)).toBeLessThanOrEqual(options.maxNightsAway);
      if (p.objective === 'profit' && p.stops.length) expect(p.money.profit!.mid).toBeCloseTo(dp.value, 4);
    }
  });
});

describe('season planner: home handling', () => {
  it('starts every trip at home and ends it there', () => {
    const shows = [mk('a', { days: [['2026-11-14', '09:00', '15:00']], ...EDISON }), mk('b', { days: [['2026-11-21', '09:00', '15:00']], ...EDISON })];
    const p = planSeason(shows, vendor(), { range: { start: '2026-11-01', end: '2026-11-30' }, today: '2026-10-21' }).plan;
    expect(p.trips).toHaveLength(2);
    for (const t of p.trips) {
      const legs = p.legs.filter((l) => l.segments[0]!.date >= t.departDate && l.segments[0]!.date <= t.returnDate);
      expect(legs[0]!.from.lat).toBeCloseTo(PHILLY.lat, 9);
      expect(legs[legs.length - 1]!.to.lat).toBeCloseTo(PHILLY.lat, 9);
    }
  });
});
