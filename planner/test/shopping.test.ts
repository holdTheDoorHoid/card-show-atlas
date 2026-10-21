import { describe, expect, it } from 'vitest';
import { planWeekendRun, verifyPlan, type WeekendRunOptions } from '../src/index.js';
import { simulateShop, solveShop, solveShopExact, solveShopHeuristic, type ShopInstance } from '../src/shopping.js';
import { estimateLeg } from '../src/travel.js';
import { bruteShop } from './brute.js';
import { sampleShows, sampleShopping, sampleVendor } from './fixtures.js';
import { between, genShows, genVendor, intBetween, rng, type Rng } from './gen.js';
import { mk, PHILLY, vendor } from './helpers.js';

function randomInstance(r: Rng, n: number, D: number): ShopInstance {
  const pts = Array.from({ length: n }, () => ({ lat: 40 + between(r, -1, 1), lon: -75 + between(r, -1.3, 1.3) }));
  const base = { lat: 40, lon: -75 };
  const end = r() < 0.2 ? { lat: 40.5, lon: -74.5 } : base;
  const all = [...pts, base, end];
  const tt = all.map((a) => all.map((b) => estimateLeg(a, b).hours));
  const win = pts.map(() => {
    const days = Array.from({ length: D }, () => r() < 0.6);
    if (!days.some(Boolean)) days[intBetween(r, 0, D - 1)] = true;
    return days.map((open, t) => {
      if (!open) return null;
      const o = 24 * t + between(r, 8, 12);
      const c = o + between(r, 2, 8);
      const dwell = 1.5;
      return c - dwell >= o ? ([o, c - dwell] as [number, number]) : null;
    });
  });
  return {
    n,
    D,
    value: pts.map(() => intBetween(r, 10, 100)),
    dwell: 1.5,
    win,
    tt,
    dayStart: Array.from({ length: D }, (_, t) => Array.from({ length: n + 1 }, () => 24 * t + 8)),
    dayEnd: Array.from({ length: D }, (_, t) => Array.from({ length: n + 2 }, () => 24 * t + 22)),
    cap: between(r, 2, 8),
    mode: r() < 0.5 ? 'home' : 'stay',
    maxStops: r() < 0.2 ? intBetween(r, 1, 3) : Infinity,
  };
}

describe('shopping: simulation', () => {
  const inst: ShopInstance = {
    n: 2,
    D: 1,
    value: [10, 20],
    dwell: 1.5,
    win: [[[9, 13]], [[10, 12]]],
    tt: [
      [0, 1, 1, 1],
      [1, 0, 1, 1],
      [1, 1, 0, 0],
      [1, 1, 0, 0],
    ],
    dayStart: [[8, 8, 8]],
    dayEnd: [[22, 22, 22, 22]],
    cap: 4,
    mode: 'home',
    maxStops: Infinity,
  };

  it('waits for opening, stays the dwell time and drives home', () => {
    const s = simulateShop(inst, [[0, 1]]);
    expect(s.feasible).toBe(true);
    expect(s.days[0]!.visits[0]).toEqual({ s: 0, arrive: 9, start: 9, leave: 10.5 });
    expect(s.days[0]!.visits[1]).toEqual({ s: 1, arrive: 11.5, start: 11.5, leave: 13 });
    expect(s.feasible && s.days[0]!.endArrive).toBe(14);
    expect(s.drive).toBe(3);
  });

  it('rejects late arrivals, closed days, repeats and the driving cap', () => {
    expect(simulateShop(inst, [[1, 0]]).feasible).toBe(true);
    expect(simulateShop({ ...inst, win: [[[9, 9.2]], [[10, 12]]] }, [[1, 0]]).reason).toBe('arrives too late');
    expect(simulateShop({ ...inst, win: [[null], [[10, 12]]] }, [[0]]).reason).toBe('closed that day');
    expect(simulateShop(inst, [[0, 0]]).reason).toBe('repeated or unknown stop');
    expect(simulateShop({ ...inst, cap: 2.5 }, [[0, 1]]).reason).toBe('over the driving cap');
    expect(simulateShop({ ...inst, maxStops: 1 }, [[0, 1]]).reason).toBe('too many stops');
  });
});

describe('shopping: exact search against brute force', () => {
  const N = 300;
  it(`finds the same best value and driving as brute force on ${N} random instances`, () => {
    for (let k = 0; k < N; k++) {
      const r = rng(500 + k);
      const D = intBetween(r, 1, 3);
      const n = intBetween(r, 1, D === 3 ? 6 : 7);
      const inst = randomInstance(r, n, D);
      const ex = solveShopExact(inst);
      const bf = bruteShop(inst);
      expect(ex.value, `instance ${k}`).toBeCloseTo(bf.value, 9);
      if (bf.value > 0) expect(ex.drive, `instance ${k}`).toBeCloseTo(bf.drive, 9);
      const sim = simulateShop(inst, ex.routes);
      if (bf.value > 0) {
        expect(sim.feasible).toBe(true);
        expect(sim.value).toBeCloseTo(ex.value, 9);
      }
    }
  });
});

describe('shopping: heuristic', () => {
  it('is always feasible and nearly always optimal on small instances', () => {
    let same = 0;
    let gapSum = 0;
    const N = 150;
    for (let k = 0; k < N; k++) {
      const r = rng(9000 + k);
      const D = intBetween(r, 1, 3);
      const inst = randomInstance(r, intBetween(r, 5, 10), D);
      const ex = solveShopExact(inst);
      const he = solveShopHeuristic(inst, { seed: 7 });
      const sim = simulateShop(inst, he.routes);
      expect(sim.feasible, `instance ${k}`).toBe(true);
      expect(he.value).toBeLessThanOrEqual(ex.value + 1e-9);
      if (Math.abs(he.value - ex.value) < 1e-9) same += 1;
      gapSum += ex.value > 0 ? (ex.value - he.value) / ex.value : 0;
    }
    expect(same / N).toBeGreaterThanOrEqual(0.88);
    expect(gapSum / N).toBeLessThan(0.01);
  });

  it('repeats exactly for the same seed and handles 30 candidates', () => {
    const r = rng(42);
    const inst = randomInstance(r, 30, 2);
    const t0 = Date.now();
    const a = solveShopHeuristic(inst, { seed: 3, timeBudgetMs: 2000 });
    expect(Date.now() - t0).toBeLessThan(5000);
    const b = solveShopHeuristic(inst, { seed: 3, timeBudgetMs: 2000, iterations: a ? undefined : 0 });
    expect(simulateShop(inst, a.routes).feasible).toBe(true);
    expect(b.routes).toEqual(a.routes);
    expect(a.value).toBeGreaterThan(0);
  });

  it('switches from exact to heuristic above the limit', () => {
    const r = rng(43);
    const inst = randomInstance(r, 8, 1);
    expect(solveShop(inst, 12).exact).toBe(true);
    expect(solveShop(inst, 4).exact).toBe(false);
  });
});

describe('shopping: weekend run', () => {
  it('plans the sample fixture with feasible stops and alternatives', () => {
    const shows = sampleShows();
    const s = sampleVendor();
    const o = sampleShopping();
    const res = planWeekendRun(shows, s, o);
    expect(res.mode).toBe('shopping');
    expect(res.exact).toBe(true);
    const best = res.best!;
    expect(best.stops.length).toBeGreaterThanOrEqual(3);
    expect(verifyPlan(best, shows, { settings: s, within: o.dates, dwellMinutes: o.dwellMinutes })).toEqual([]);
    expect(best.money.profit).toBeNull();
    expect(best.money.label).toMatch(/^Costs about [\d,]+ USD$/);
    expect(best.money.costs.some((c) => c.kind === 'admission')).toBe(true);
    for (const a of res.alternatives) {
      expect(verifyPlan(a, shows, { settings: s, within: o.dates, dwellMinutes: o.dwellMinutes })).toEqual([]);
    }
  });

  it('gets times right when shopping across a time zone line', () => {
    const CHICAGO = { lat: 41.8781, lon: -87.6298 };
    const INDY = { lat: 39.7684, lon: -86.1581 };
    const shows = [
      mk('chicago', { days: [['2026-11-14', '09:00', '12:00']], ...CHICAGO, tz: 'America/Chicago' }),
      mk('indy', { days: [['2026-11-14', '10:00', '18:00']], ...INDY, tz: 'America/Indiana/Indianapolis' }),
    ];
    const s = vendor({ home: { ...CHICAGO, timezone: 'America/Chicago' }, max_drive_hours_per_day: 10 });
    const o: WeekendRunOptions = { mode: 'shopping', dates: { start: '2026-11-14', end: '2026-11-14' }, today: '2026-10-21', end: { ...INDY, name: 'Indy hotel', timezone: 'America/Indiana/Indianapolis' } };
    const p = planWeekendRun(shows, s, o).best!;
    expect(p.stops.map((x) => x.showId)).toEqual(['chicago', 'indy']);
    // Chicago opens 9:00 CT, which is 15:00 UTC.
    expect(p.stops[0]!.arriveMs).toBe(Date.UTC(2026, 10, 14, 15, 0));
    // Leave at 10:30 CT (11:30 ET), drive about 3 h 35 min, arrive about 15:05 ET, in time for a
    // 90 minute visit before Indy closes at 18:00 ET.
    const drive = estimateLeg(CHICAGO, INDY).hours;
    expect(p.stops[1]!.arriveMs).toBeCloseTo(Date.UTC(2026, 10, 14, 16, 30) + drive * 3_600_000, -3);
    expect(p.stops[1]!.arrive.endsWith('-05:00')).toBe(true);
    expect(verifyPlan(p, shows, { settings: s, within: o.dates })).toEqual([]);
  });

  it('passes the independent checks on random real show sets', () => {
    for (let k = 0; k < 40; k++) {
      const r = rng(7000 + k);
      const shows = genShows(r, { n: intBetween(r, 3, 16), start: '2026-11-14', spanDays: 2, center: PHILLY, spreadDeg: 1, multiDay: 0.4 });
      const s = genVendor(r, PHILLY);
      const o: WeekendRunOptions = {
        mode: 'shopping',
        dates: { start: '2026-11-14', end: '2026-11-15' },
        today: '2026-10-21',
        overnight: r() < 0.5 ? 'home' : 'stay',
        dwellMinutes: intBetween(r, 30, 120),
        exactLimit: 10,
      };
      const res = planWeekendRun(shows, s, o);
      for (const p of [res.best, ...res.alternatives]) {
        if (!p) continue;
        expect(verifyPlan(p, shows, { settings: s, within: o.dates, dwellMinutes: o.dwellMinutes }), `instance ${k} ${p.title}`).toEqual([]);
      }
    }
  });
});
