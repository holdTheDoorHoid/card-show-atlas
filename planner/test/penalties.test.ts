import { describe, expect, it } from 'vitest';
import { planWeekendRun, verifyPlan, type Plan, type PlannerShow, type VendorSettings, type WeekendRunOptions } from '../src/index.js';
import { DRIVING_PENALTIES } from '../src/common.js';
import { atLeastAsGood, keepBestOnTop } from '../src/weekend.js';
import { genShows, genVendor, intBetween, pick, rng } from './gen.js';
import { mk, PHILLY, vendor } from './helpers.js';

// Places around Philadelphia, as in the real case that prompted these rules.
const MOORESTOWN = { lat: 39.9688, lon: -74.9488, city: 'Moorestown' };
const OAKS = { lat: 40.1301, lon: -75.4569, city: 'Oaks' };
const BORDENTOWN = { lat: 40.1462, lon: -74.7118, city: 'Bordentown' };
const HARTFORD = { lat: 41.7658, lon: -72.6734, city: 'Hartford' };
const BLASDELL = { lat: 42.7973, lon: -78.8234, city: 'Blasdell' };

function noSales(over: Partial<VendorSettings> = {}): VendorSettings {
  return vendor({ typical_sales: null, hotel_per_night: 140, food_per_day: 35, max_drive_hours_per_day: 8, sells: ['pokemon'], ...over });
}

describe('score mode counts driving and nights', () => {
  const shows = [
    mk('near-small', { days: [['2026-11-14', '09:00', '16:00']], ...OAKS, mid: 250, size: 'small', price: 80 }),
    mk('far-major', { days: [['2026-11-14', '09:00', '16:00']], ...HARTFORD, mid: 15000, size: 'major', price: 80 }),
  ];
  const run = (mindDriving: 'little' | 'some' | 'lot') =>
    planWeekendRun(shows, noSales(), { mode: 'vending', dates: { start: '2026-11-13', end: '2026-11-15' }, today: '2026-10-21', mindDriving, weights: 'biggest_crowds' }).best!;

  it('keeps a plan local when driving matters, and says why in plain words', () => {
    const p = run('some');
    expect(p.objective).toBe('score');
    expect(p.stops.map((s) => s.showId)).toEqual(['near-small']);
    expect(run('lot').stops.map((s) => s.showId)).toEqual(['near-small']);
    expect(p.scoreLine).toMatch(/^Plan score \d+: shows worth \d+, minus \d+ for (\d+ h )?(\d+ min )?of driving$/);
  });

  it('drives farther for a bigger show when driving matters only a little', () => {
    const p = run('little');
    expect(p.stops.map((s) => s.showId)).toEqual(['far-major']);
    expect(p.scoreLine).toMatch(/minus \d+ for .* of driving and \d+ for 1 hotel night$/);
  });

  it('documents the numbers it uses', () => {
    expect(DRIVING_PENALTIES).toEqual({
      little: { perDriveHour: 2, perHotelNight: 5 },
      some: { perDriveHour: 10, perHotelNight: 25 },
      lot: { perDriveHour: 20, perHotelNight: 50 },
    });
  });
});

describe('profit mode can count the vendor time', () => {
  it('adds a time line and lowers profit by exactly the hours times the rate', () => {
    const shows = [mk('pgh', { days: [['2026-11-14', '10:00', '16:00']], lat: 40.4406, lon: -79.9959, mid: 4000, size: 'large' })];
    const base = vendor({ max_drive_hours_per_day: 7 });
    const o: WeekendRunOptions = { mode: 'vending', dates: { start: '2026-11-13', end: '2026-11-15' }, today: '2026-10-21' };
    const a = planWeekendRun(shows, base, o).best!;
    const b = planWeekendRun(shows, { ...base, time_value_per_hour: 25 }, o).best!;
    const line = b.money.costs.find((c) => c.kind === 'time')!;
    expect(line.label).toBe('Your time driving');
    expect(line.amount).toBeCloseTo(b.driveHours * 25, 6);
    expect(line.detail).toMatch(/ at 25 USD an hour$/);
    expect(a.money.costs.some((c) => c.kind === 'time')).toBe(false);
    expect(b.money.profit!.mid).toBeCloseTo(b.value, 4);
    expect(b.money.profit!.mid).toBeCloseTo(a.money.profit!.mid - line.amount, 4);
  });
});

describe('a shopping weekend from Philadelphia stays local', () => {
  // The shape of the real case: shows close to home, a good one in Hartford (about 4 h) and an
  // ordinary one near Buffalo (about 7 h), over a Friday to Sunday.
  const shows: PlannerShow[] = [
    mk('moorestown-fri', { days: [['2026-10-23', '10:00', '18:00']], ...MOORESTOWN, mid: 500, size: 'small' }),
    mk('oaks-sat', { days: [['2026-10-24', '09:00', '15:00']], ...OAKS, mid: 450, size: 'small' }),
    mk('bordentown-sun', { days: [['2026-10-25', '09:00', '14:00']], ...BORDENTOWN, mid: 400, size: 'small' }),
    mk('hartford-fri', { days: [['2026-10-23', '10:00', '19:00']], ...HARTFORD, mid: 2500, size: 'large' }),
    mk('blasdell-sat', { days: [['2026-10-24', '09:00', '16:00']], ...BLASDELL, mid: 600, size: 'medium' }),
  ];
  const settings = noSales();
  const o: WeekendRunOptions = { mode: 'shopping', dates: { start: '2026-10-23', end: '2026-10-25' }, today: '2026-10-21', start: { ...PHILLY, name: '19103' }, interests: ['pokemon'] };

  it('does not drive to Buffalo to shop for 90 minutes', () => {
    const res = planWeekendRun(shows, settings, o);
    const best = res.best!;
    expect(best.stops.map((s) => s.showId)).not.toContain('blasdell-sat');
    expect(best.driveHours).toBeLessThan(6);
    expect(best.hotelNights).toBe(0);
    expect(res.excluded.find((e) => e.id === 'blasdell-sat')!.reason).toMatch(/away, and not at least one and a half times as good as the best show within 3 h$/);
    expect(verifyPlan(best, shows, { settings, within: o.dates })).toEqual([]);
    for (const a of res.alternatives) expect(atLeastAsGood(a, best)).toBe(false);
  });

  it('sleeps at home in stay mode when that is better than a hotel', () => {
    const local = shows.filter((s) => !/hartford|blasdell/.test(s.id));
    const best = planWeekendRun(local, settings, { ...o, overnight: 'stay' }).best!;
    expect(best.stops.length).toBe(3);
    expect(best.hotelNights).toBe(0);
    expect(best.nights.every((n) => n.where === 'home')).toBe(true);
  });

  it('lists each night once, outside the day items', () => {
    const best = planWeekendRun(shows, settings, { ...o, mindDriving: 'little', farHours: 10 }).best!;
    for (const d of best.days) expect(d.items.some((x) => /^Night:/.test(x))).toBe(false);
    const dates = best.nights.map((n) => n.date);
    expect(new Set(dates).size).toBe(dates.length);
  });

  it('never plans a single drive longer than the daily limit', () => {
    const best = planWeekendRun(shows, settings, { ...o, mindDriving: 'little', farHours: 10 }).best!;
    for (const l of best.legs) expect(l.hours).toBeLessThanOrEqual(settings.max_drive_hours_per_day + 1e-9);
  });
});

describe('the far stop rule', () => {
  const settings = noSales();
  const base: WeekendRunOptions = { mode: 'shopping', dates: { start: '2026-10-24', end: '2026-10-24' }, today: '2026-10-21', start: { ...PHILLY, name: '19103' }, mindDriving: 'little' };
  it('keeps a far show only when it is clearly better than the best near one', () => {
    const near = mk('near', { days: [['2026-10-24', '09:00', '17:00']], ...OAKS, mid: 300, size: 'small', sells: ['baseball'] });
    const farGood = mk('far-good', { days: [['2026-10-24', '09:00', '19:00']], ...HARTFORD, mid: 9000, size: 'major' });
    const farPlain = mk('far-plain', { days: [['2026-10-24', '09:00', '19:00']], ...HARTFORD, mid: 300, size: 'small', sells: ['baseball'] });
    const res = planWeekendRun([near, farGood, farPlain], settings, base);
    const ids = res.excluded.map((e) => e.id);
    expect(ids).toContain('far-plain');
    expect(ids).not.toContain('far-good');
    expect(planWeekendRun([farPlain], settings, base).excluded.map((e) => e.id)).not.toContain('far-plain');
  });
});

describe('an alternative that is at least as good becomes the best plan', () => {
  // The exact shape from the real case: the best plan drives 973 miles in 17 h with two hotel
  // nights, and the "No hotel nights" alternative has the same four stops in 11 h 10 min, cheaper.
  const shape = (title: string, value: number, miles: number, hours: number, cost: number, hotels: number): Plan =>
    ({
      kind: 'shopping',
      title,
      summary: '',
      stops: [1, 2, 3, 4].map((i) => ({ showId: `s${i}`, firstDate: '2026-10-23' })),
      legs: [],
      days: [],
      nights: [],
      trips: [],
      money: { totalCost: cost, currency: 'USD', costs: [], profit: null },
      deadlines: [],
      warnings: [],
      departDate: '2026-10-23',
      returnDate: '2026-10-25',
      hotelNights: hotels,
      driveHours: hours,
      miles,
      value,
      objective: 'visits',
      scoreLine: null,
      driveTimes: { source: 'estimate', label: '' },
    }) as unknown as Plan;

  it('swaps them and drops the beaten plan', () => {
    const best = shape('Best plan', 205, 973, 17, 182, 2);
    const noHotel = shape('No hotel nights', 205, 576, 11 + 1 / 6, 118, 0);
    const fewer = shape('One fewer stop', 150, 400, 8, 90, 0);
    const out = keepBestOnTop(best, [fewer, noHotel]);
    expect(out.best.miles).toBe(576);
    expect(out.best.title).toBe('Best plan');
    expect(out.alternatives.map((p) => p.title)).toEqual(['One fewer stop']);
    for (const a of out.alternatives) expect(atLeastAsGood(a, out.best)).toBe(false);
  });

  it('leaves real trade offs alone', () => {
    const best = shape('Best plan', 205, 973, 17, 182, 2);
    const fewer = shape('One fewer stop', 150, 400, 8, 90, 0);
    expect(keepBestOnTop(best, [fewer]).best).toBe(best);
  });

  it('never happens on random weekend runs, vending or shopping', () => {
    for (let k = 0; k < 60; k++) {
      const r = rng(50_000 + k);
      const shows = genShows(r, { n: intBetween(r, 3, 14), start: '2026-11-13', spanDays: 3, center: PHILLY, spreadDeg: pick(r, [0.5, 2, 4]), multiDay: 0.3 });
      const settings = genVendor(r, PHILLY, r() < 0.5);
      const o: WeekendRunOptions = {
        mode: r() < 0.5 ? 'shopping' : 'vending',
        dates: { start: '2026-11-13', end: '2026-11-15' },
        today: '2026-10-21',
        overnight: r() < 0.3 ? 'home' : 'stay',
        mindDriving: pick(r, ['little', 'some', 'lot'] as const),
        exactLimit: 8,
      };
      const res = planWeekendRun(shows, settings, o);
      if (!res.best) continue;
      for (const a of res.alternatives) expect(atLeastAsGood(a, res.best), `instance ${k} ${a.title}`).toBe(false);
    }
  });
});
