import { describe, expect, it } from 'vitest';
import { planWeekendRun, verifyPlan, type Plan, type PlannerShow, type VendorSettings, type WeekendRunOptions } from '../src/index.js';
import { estimateLeg } from '../src/travel.js';
import { bruteVending } from './brute.js';
import { sampleShows, sampleVendor, sampleVendorNoSales, sampleWeekend } from './fixtures.js';
import { between, genShows, genVendor, intBetween, pick, rng } from './gen.js';
import { mk, PHILLY, vendor, weekendSetup } from './helpers.js';

const ALLENTOWN = { lat: 40.6084, lon: -75.4902 };
const PITTSBURGH = { lat: 40.4406, lon: -79.9959 };
const COLUMBUS = { lat: 39.9612, lon: -82.9988 };
const EDISON = { lat: 40.5187, lon: -74.3518 };
const BALTIMORE = { lat: 39.2904, lon: -76.6122 };

function run(shows: PlannerShow[], settings: VendorSettings, o: Partial<WeekendRunOptions> = {}) {
  const options: WeekendRunOptions = { mode: 'vending', dates: { start: '2026-11-13', end: '2026-11-15' }, today: '2026-10-21', ...o };
  const res = planWeekendRun(shows, settings, options);
  return { res, options };
}

function feasible(plan: Plan, shows: PlannerShow[], settings: VendorSettings, o: WeekendRunOptions) {
  const problems = verifyPlan(plan, shows, { settings, within: o.dates, blackout: o.blackout, rates: o.rates });
  expect(problems).toEqual([]);
}

describe('weekend run, vending: scenarios', () => {
  it('drives the morning of a nearby one day show and comes home that night', () => {
    const shows = [mk('near', { days: [['2026-11-14', '09:00', '15:00']], ...ALLENTOWN })];
    const s = vendor();
    const { res, options } = run(shows, s);
    const p = res.best!;
    expect(p.stops.map((x) => x.showId)).toEqual(['near']);
    expect(p.hotelNights).toBe(0);
    expect(p.legs).toHaveLength(2);
    expect(p.legs[0]!.segments[0]!.date).toBe('2026-11-14');
    expect(p.legs[0]!.segments[0]!.arriveMs).toBe(p.stops[0]!.arriveMs);
    expect(p.nights).toEqual([expect.objectContaining({ date: '2026-11-14', where: 'home' })]);
    feasible(p, shows, s, options);
  });

  it('leaves the day before and splits a long drive when the daily cap demands it', () => {
    const shows = [mk('far', { days: [['2026-11-14', '09:00', '16:00']], ...COLUMBUS, size: 'large', mid: 3000 })];
    const s = vendor({ max_drive_hours_per_day: 8 });
    const h = estimateLeg(PHILLY, COLUMBUS).hours;
    expect(h).toBeGreaterThan(8);
    const { res, options } = run(shows, s);
    const p = res.best!;
    expect(p).not.toBeNull();
    expect(p.departDate).toBe('2026-11-13');
    expect(p.returnDate).toBe('2026-11-15');
    expect(p.hotelNights).toBe(2);
    const first = p.legs[0]!;
    expect(first.segments.length).toBe(2);
    expect(first.segments[0]!.hours).toBeCloseTo(8, 9);
    expect(p.nights.find((n) => n.date === '2026-11-13')!.label).toMatch(/^Hotel on the road/);
    feasible(p, shows, s, options);
  });

  it('cannot reach a far show inside the dates when the cap is short, and says why', () => {
    const shows = [mk('far', { days: [['2026-11-14', '09:00', '16:00']], ...COLUMBUS, size: 'large', mid: 3000 })];
    const s = vendor({ max_drive_hours_per_day: 4 });
    const { res } = run(shows, s, { dates: { start: '2026-11-14', end: '2026-11-14' } });
    expect(res.best).toBeNull();
    expect(res.warnings.join(' ')).toMatch(/driving limit/);
  });

  it('couples the morning and evening drive of a one day show against the daily cap', () => {
    // About 5.6 h each way. With a 7 h cap the same day round trip (11 h) is impossible, so the plan
    // must either arrive the night before or leave the next morning.
    const shows = [mk('pgh', { days: [['2026-11-14', '10:00', '16:00']], ...PITTSBURGH })];
    const s = vendor({ max_drive_hours_per_day: 7 });
    const { res, options } = run(shows, s);
    const p = res.best!;
    const sat = p.days.find((d) => d.date === '2026-11-14')!;
    expect(sat.driveHours).toBeLessThanOrEqual(7 + 1e-9);
    expect(p.hotelNights).toBe(1);
    feasible(p, shows, s, options);
  });

  it('commutes from home for a nearby two day show and uses a hotel for a far one', () => {
    const near = [mk('edison', { days: [['2026-11-14', '09:00', '15:00'], ['2026-11-15', '10:00', '14:00']], ...EDISON })];
    const s = vendor({ hotel_per_night: 150 });
    const a = run(near, s);
    expect(a.res.best!.stops[0]!.nights).toBe('home');
    expect(a.res.best!.hotelNights).toBe(0);
    feasible(a.res.best!, near, s, a.options);

    const far = [mk('pgh2', { days: [['2026-11-14', '09:00', '15:00'], ['2026-11-15', '10:00', '14:00']], ...PITTSBURGH, mid: 3000, size: 'large' })];
    const b = run(far, s);
    expect(b.res.best!.stops[0]!.nights).toBe('hotel');
    expect(b.res.best!.hotelNights).toBeGreaterThanOrEqual(1);
    feasible(b.res.best!, far, s, b.options);
  });

  it('chains two weekend shows and never puts two shows on one day', () => {
    const shows = [
      mk('sat-edison', { days: [['2026-11-14', '09:00', '15:00']], ...EDISON, mid: 1500 }),
      mk('sat-allentown', { days: [['2026-11-14', '09:00', '15:00']], ...ALLENTOWN, mid: 900 }),
      mk('sun-baltimore', { days: [['2026-11-15', '10:00', '16:00']], ...BALTIMORE, mid: 2500, size: 'large' }),
    ];
    const s = vendor();
    const { res, options } = run(shows, s);
    const p = res.best!;
    const dates = p.stops.flatMap((x) => x.dates);
    expect(new Set(dates).size).toBe(dates.length);
    expect(p.stops.map((x) => x.showId)).toContain('sun-baltimore');
    feasible(p, shows, s, options);
  });

  it('coming home each night never books a hotel', () => {
    const shows = [
      mk('pgh', { days: [['2026-11-14', '10:00', '16:00']], ...PITTSBURGH, mid: 6000, size: 'major' }),
      mk('near', { days: [['2026-11-15', '10:00', '16:00']], ...ALLENTOWN }),
    ];
    const s = vendor({ max_drive_hours_per_day: 8 });
    const stay = run(shows, s, { overnight: 'stay' }).res.best!;
    expect(stay.stops.map((x) => x.showId)).toContain('pgh');
    const { res, options } = run(shows, s, { overnight: 'home' });
    expect(res.best!.hotelNights).toBe(0);
    expect(res.best!.stops.map((x) => x.showId)).toEqual(['near']);
    feasible(res.best!, shows, s, options);
  });

  it('respects a cap on the number of shows', () => {
    const shows = [
      mk('fri', { days: [['2026-11-13', '12:00', '18:00']], ...ALLENTOWN }),
      mk('sat', { days: [['2026-11-14', '09:00', '15:00']], ...EDISON }),
      mk('sun', { days: [['2026-11-15', '10:00', '16:00']], ...BALTIMORE }),
    ];
    const s = vendor();
    expect(run(shows, s).res.best!.stops).toHaveLength(3);
    expect(run(shows, s, { maxShows: 2 }).res.best!.stops).toHaveLength(2);
  });

  it('can start and end in different places', () => {
    const shows = [mk('sat', { days: [['2026-11-14', '09:00', '15:00']], ...ALLENTOWN })];
    const s = vendor();
    const { res, options } = run(shows, s, { start: { ...PHILLY, name: 'Home' }, end: { ...EDISON, name: 'Edison office' } });
    const p = res.best!;
    expect(p.end.name).toBe('Edison office');
    expect(p.legs[p.legs.length - 1]!.to.name).toBe('Edison office');
    feasible(p, shows, s, options);
    expect(() => run(shows, s, { end: EDISON, overnight: 'home' })).toThrow(/start and end at the same place/);
  });

  it('works across a time zone boundary', () => {
    const SOUTH_BEND = { lat: 41.6764, lon: -86.252 };
    const CHICAGO = { lat: 41.8781, lon: -87.6298 };
    const shows = [
      mk('chicago-sat', { days: [['2026-11-14', '09:00', '17:00']], ...CHICAGO, tz: 'America/Chicago' }),
      mk('south-bend-sun', { days: [['2026-11-15', '10:00', '16:00']], ...SOUTH_BEND, tz: 'America/Indiana/Indianapolis' }),
    ];
    const s = vendor({ home: { ...SOUTH_BEND, timezone: 'America/Indiana/Indianapolis' } });
    const { res, options } = run(shows, s);
    const p = res.best!;
    expect(p.stops.map((x) => x.showId)).toEqual(['chicago-sat', 'south-bend-sun']);
    // Setup 90 minutes before opening, local to each show.
    expect(p.stops[0]!.arrive).toBe('2026-11-14T07:30:00-06:00');
    expect(p.stops[1]!.arrive).toBe('2026-11-15T08:30:00-05:00');
    // Both are 13:30 UTC: one hour later on the clock, one zone east.
    expect(p.stops[0]!.arriveMs).toBe(Date.UTC(2026, 10, 14, 13, 30));
    expect(p.stops[1]!.arriveMs).toBe(Date.UTC(2026, 10, 15, 13, 30));
    feasible(p, shows, s, options);
  });

  it('gets the clocks right over the fall daylight saving change', () => {
    const shows = [
      mk('sat-oct31', { days: [['2026-10-31', '09:00', '15:00']], ...ALLENTOWN }),
      mk('sun-nov1', { days: [['2026-11-01', '09:00', '15:00']], ...EDISON }),
    ];
    const s = vendor();
    const { res, options } = run(shows, s, { dates: { start: '2026-10-31', end: '2026-11-01' }, today: '2026-10-01' });
    const p = res.best!;
    expect(p.stops[0]!.arrive).toBe('2026-10-31T07:30:00-04:00');
    expect(p.stops[0]!.leave).toBe('2026-10-31T16:00:00-04:00');
    expect(p.stops[1]!.arrive).toBe('2026-11-01T07:30:00-05:00');
    // 16:00 EDT to 07:30 EST is 16.5 hours, not 15.5.
    expect((p.stops[1]!.arriveMs - p.stops[0]!.leaveMs) / 3_600_000).toBeCloseTo(16.5, 9);
    feasible(p, shows, s, options);
  });

  it('gets the clocks right over the spring daylight saving change', () => {
    const shows = [mk('sun-mar14', { days: [['2027-03-14', '09:00', '15:00']], ...EDISON })];
    const s = vendor();
    const { res, options } = run(shows, s, { dates: { start: '2027-03-13', end: '2027-03-14' }, today: '2027-01-01' });
    const p = res.best!;
    expect(p.stops[0]!.arrive).toBe('2027-03-14T07:30:00-04:00');
    expect(p.stops[0]!.arriveMs).toBe(Date.UTC(2027, 2, 14, 11, 30));
    feasible(p, shows, s, options);
  });

  it('uses a listed setup time instead of the default lead', () => {
    const shows = [mk('setup', { days: [['2026-11-14', '10:00', '16:00']], ...ALLENTOWN, setup: '07:00' })];
    const p = run(shows, vendor()).res.best!;
    expect(p.stops[0]!.arrive).toBe('2026-11-14T07:00:00-05:00');
  });

  it('respects blackout dates for shows and travel', () => {
    const shows = [mk('far', { days: [['2026-11-14', '09:00', '16:00']], ...COLUMBUS, size: 'large', mid: 3000 })];
    const s = vendor({ max_drive_hours_per_day: 8 });
    expect(run(shows, s).res.best).not.toBeNull();
    expect(run(shows, s, { blackout: ['2026-11-13'] }).res.best).toBeNull();
    const res = run(shows, s, { blackout: ['2026-11-14'] }).res;
    expect(res.best).toBeNull();
    expect(res.excluded[0]!.reason).toMatch(/blackout/);
  });
});

describe('weekend run, vending: sample fixture', () => {
  it('returns a feasible best plan and up to three different feasible alternatives', () => {
    const shows = sampleShows();
    const s = sampleVendor();
    const o = sampleWeekend();
    const res = planWeekendRun(shows, s, o);
    const best = res.best!;
    expect(best).not.toBeNull();
    feasible(best, shows, s, o);
    expect(res.alternatives.length).toBeGreaterThanOrEqual(2);
    expect(res.alternatives.length).toBeLessThanOrEqual(3);
    const sigs = new Set([best, ...res.alternatives].map((p) => `${p.stops.map((x) => x.showId).join()}|${p.hotelNights}|${p.returnDate}`));
    expect(sigs.size).toBe(res.alternatives.length + 1);
    for (const a of res.alternatives) {
      feasible(a, shows, s, o);
      expect(a.value).toBeLessThanOrEqual(best.value + 1e-6);
      expect(a.note).toBeTruthy();
    }
    expect(best.money.profit!.low).toBeLessThanOrEqual(best.money.profit!.mid);
    expect(best.money.profit!.mid).toBeLessThanOrEqual(best.money.profit!.high);
    expect(best.money.profit!.mid).toBeCloseTo(best.value, 6);
    const dl = best.deadlines.filter((d) => d.date).map((d) => d.date!);
    expect(dl).toEqual([...dl].sort());
    const reasons = res.excluded.map((e) => `${e.id}: ${e.reason}`).join('\n');
    expect(reasons).toMatch(/big-apple-card-con.*Outside your dates/);
    expect(reasons).toMatch(/poconos.*Cancelled/);
    expect(reasons).toMatch(/great-lakes.*CAD/);
  });

  it('includes a Canadian show once an exchange rate is given, and says so', () => {
    const shows = sampleShows().filter((x) => x.id.startsWith('great-lakes'));
    const s = sampleVendor();
    s.max_drive_hours_per_day = 9;
    const o = { ...sampleWeekend(), dates: { start: '2026-11-13', end: '2026-11-16' }, rates: { CAD_USD: 0.73 } };
    const res = planWeekendRun(shows, s, o);
    const best = res.best!;
    expect(best).not.toBeNull();
    const table = best.money.costs.find((c) => c.kind === 'table')!;
    expect(table.original).toEqual({ amount: 175, currency: 'CAD' });
    expect(table.amount).toBeCloseTo(175 * 0.73, 9);
    expect(best.money.conversions.join(' ')).toMatch(/Converted 175 CAD to 128 USD at 0\.73, the rate you entered\./);
    feasible(best, shows, s, o);
  });

  it('plans by priority score when typical sales are not set', () => {
    const shows = sampleShows();
    const s = sampleVendorNoSales();
    const o = sampleWeekend();
    const res = planWeekendRun(shows, s, o);
    expect(res.best!.objective).toBe('score');
    expect(res.best!.money.profit).toBeNull();
    for (const st of res.best!.stops) expect(st.score).toBeGreaterThan(0);
    feasible(res.best!, shows, s, o);
  });
});

describe('weekend run, vending: exact against brute force on random instances', () => {
  const N = 250;
  it(`matches brute force and passes the independent checks on ${N} instances`, () => {
    let nonEmpty = 0;
    for (let k = 0; k < N; k++) {
      const r = rng(1000 + k);
      const home = { lat: between(r, 39.5, 40.5), lon: between(r, -76, -75) };
      const shows = genShows(r, {
        n: intBetween(r, 2, 8),
        start: '2026-11-13',
        spanDays: 3,
        center: home,
        spreadDeg: pick(r, [0.5, 1.5, 3]),
        multiDay: 0.35,
        zones: ['America/New_York', 'America/New_York', 'America/Chicago'],
      });
      const settings = genVendor(r, home, r() < 0.75);
      const options: WeekendRunOptions = {
        mode: 'vending',
        dates: { start: '2026-11-13', end: '2026-11-15' },
        today: '2026-10-01',
        overnight: r() < 0.25 ? 'home' : 'stay',
        maxShows: r() < 0.25 ? intBetween(r, 1, 2) : undefined,
        end: r() < 0.15 ? { lat: home.lat + 0.5, lon: home.lon + 0.5, name: 'Elsewhere' } : undefined,
      };
      if (options.end && options.overnight === 'home') options.overnight = 'stay';
      const { engine, brute } = weekendSetup(shows, settings, options);
      const dp = engine.solve();
      const bf = bruteVending(engine, brute);
      expect(dp.value).toBeCloseTo(bf, 6);
      const res = planWeekendRun(shows, settings, options);
      if (dp.value > 1e-9) {
        nonEmpty += 1;
        const p = res.best!;
        expect(p).not.toBeNull();
        const problems = verifyPlan(p, shows, { settings, within: options.dates });
        expect(problems, `instance ${k}`).toEqual([]);
        if (p.objective === 'profit') expect(p.money.profit!.mid).toBeCloseTo(dp.value, 4);
        for (const a of res.alternatives) {
          expect(verifyPlan(a, shows, { settings, within: options.dates }), `instance ${k} ${a.title}`).toEqual([]);
          expect(a.value).toBeLessThanOrEqual(p.value + 1e-6);
        }
      } else {
        expect(res.best).toBeNull();
      }
    }
    expect(nonEmpty).toBeGreaterThan(N / 3);
  });
});
