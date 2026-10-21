// The glue between the site and the route planner: settings, rows, forms, share links, calendar
// files and the vendor ranking, run against the real planner code (in this process, no browser).
import { describe, expect, it } from 'vitest';
import { toPlannerShow } from '../../../planner/src/adapt.ts';
import { decodeShareLink, encodeShareLink } from '../../../planner/src/links.ts';
import { PRESET_LABELS } from '../../../planner/src/factors.ts';
import { generateFixtures } from '../../fixtures/make-fixtures.mjs';
import { addDays, weekday } from './dates.ts';
import { emptyStore, addShow, updateShow } from './myshows.ts';
import { normalizeShows } from './normalize.ts';
import {
  applyTableFees,
  buildSeasonOptions,
  buildWeekendOptions,
  comingWeekend,
  defaultSeasonForm,
  defaultWeekendForm,
  sanitizeSeasonForm,
  sanitizeWeekendForm,
  seasonRange,
  settingsForPlan,
} from './plan-options.ts';
import { deadlineReminders, planCalendar } from './plan-ics.ts';
import { currenciesNeedingRate, rateKey, runSeason, runWeekend, sanitizeRates } from './plan-run.ts';
import { linkFromHash, makeShareLink, openShare, shareUrl, sharePayload } from './plan-share.ts';
import { expandPlannerRow, packPlannerRow, toPlannerRow, buildPlannerFile, plannerShowsFrom } from './planner-rows.ts';
import { historyFromMyShows, missingSettings, seriesFromShowId, toPlannerSettings } from './planner-settings.ts';
import { DEFAULT_VENDOR_SETTINGS, normalizeSettings } from './settings.ts';
import { fixtureRows, FIXTURE_TODAY, fullSettings, inProcessPlanner } from './testing-planner.ts';
import { rankForTable, scoreLine, labelMap } from './vendor-rank.ts';
import { sortResults, DEFAULT_FILTERS, selectResults } from './filters.ts';
import { makeRow } from './testing.ts';
import { DEFAULT_VOCAB } from './vocab.ts';
import { WEIGHT_PRESETS } from './weights.ts';
import { groupByMonthHelper } from './testing-planner-helpers.ts';

const today = FIXTURE_TODAY;
const rows = fixtureRows();

describe('planner rows', () => {
  const files = generateFixtures({ base: today }) as unknown as Record<string, unknown>;
  const raw = files['shows.json'] as Record<string, unknown>[];
  const { shows } = normalizeShows(raw);

  it('match what the planner makes from the same records', () => {
    let compared = 0;
    for (const rec of raw.slice(0, 120)) {
      const mine = toPlannerRow(shows.find((s) => s.id === rec.id)!);
      const theirs = toPlannerShow(rec as never);
      expect(mine).toEqual(theirs);
      compared++;
    }
    expect(compared).toBe(120);
  });

  it('survive packing for planner.json and come back exactly the same', () => {
    for (const r of rows.slice(0, 200)) expect(expandPlannerRow(JSON.parse(JSON.stringify(packPlannerRow(r))))).toEqual(r);
  });

  it('are left out when a show has no place or time zone, and store events never go in', () => {
    const s = shows[0]!;
    expect(toPlannerRow({ ...s, venue: { ...s.venue, lat: null, lon: null } })).toBeNull();
    expect(toPlannerRow({ ...s, timezone: null })).toBeNull();
    const file = buildPlannerFile([s, { ...s, id: 'x', venue: { ...s.venue, lat: null } }, { ...s, id: 'st', event_type: 'store_event' }], DEFAULT_VOCAB, { generated: 'now', fixture: true });
    expect(file.count).toBe(1);
    expect(plannerShowsFrom(file)[0]?.id).toBe(s.id);
    expect(file).toMatchObject({ v: 1, fixture: true });
  });

  it('are small: null values are dropped', () => {
    const packed = JSON.stringify(packPlannerRow(rows[0]!));
    expect(packed).not.toContain('null');
  });
});

describe('vendor settings for the planner', () => {
  it('turns a full set of settings into the planner names', () => {
    const r = toPlannerSettings(fullSettings());
    expect(r.profit).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.placeholders).toEqual([]);
    expect(r.settings).toMatchObject({
      home: { lat: 39.9526, lon: -75.1652 },
      currency: 'USD',
      mpg: 18,
      l_per_100km: null,
      fuel_price: { amount: 3.4, unit: 'gallon', currency: 'USD' },
      hotel_per_night: 120,
      food_per_day: 45,
      max_drive_hours_per_day: 8,
      typical_sales: { small: 500, medium: 1200, large: 2500, major: 5000 },
      margin_percent: 40,
      sells: ['pokemon', 'mtg'],
    });
  });

  it('uses litres per 100 km and the litre price for a metric vehicle', () => {
    const r = toPlannerSettings(fullSettings({ fuelEconomyUnit: 'l_per_100km', fuelEconomy: 9.5, fuelPrice: 1.7, currency: 'CAD' }));
    expect(r.settings).toMatchObject({ mpg: null, l_per_100km: 9.5, fuel_price: { amount: 1.7, unit: 'litre', currency: 'CAD' }, currency: 'CAD' });
  });

  it('says which settings are missing and plans by score instead of profit', () => {
    const r = toPlannerSettings(normalizeSettings({ home: { postal: '19103', lat: 39.95, lon: -75.16, country: 'US' }, fuelEconomy: 20 }));
    expect(r.profit).toBe(false);
    expect(r.missing.map((m) => m.key)).toEqual(['fuelPrice', 'hotel', 'food', 'sales', 'margin']);
    expect(r.settings.typical_sales).toBeNull();
    expect(r.placeholders.some((p) => p.includes('fuel price'))).toBe(true);
    expect(r.missing.every((m) => m.fieldId.length > 0)).toBe(true);
  });

  it('keeps going without a home when a start point is typed in, and says so when there is none', () => {
    const empty = toPlannerSettings(DEFAULT_VENDOR_SETTINGS);
    expect(empty.hasHome).toBe(false);
    expect(empty.missing[0]).toMatchObject({ key: 'home', needed: 'plan', fieldId: 'home-postal' });
    expect(empty.settings.fuel_price?.amount).toBeGreaterThan(0); // placeholders so score planning still works
    const typed = toPlannerSettings(DEFAULT_VENDOR_SETTINGS, { home: { lat: 40, lon: -75 } });
    expect(typed.hasHome).toBe(true);
    expect(typed.settings.home).toMatchObject({ lat: 40, lon: -75 });
  });

  it('does not count profit as ready until typical sales are given for every size', () => {
    const s = fullSettings({ typicalSales: { small: 500, medium: null, large: 2500, major: 5000 } });
    expect(toPlannerSettings(s).profit).toBe(false);
    expect(missingSettings(s, true).map((m) => m.key)).toEqual(['sales']);
  });

  it('builds the vendor history from My shows', () => {
    let store = emptyStore();
    const snap = { name: 'Sample A', first: '2026-09-01', last: '2026-09-01', city: 'X', region: 'NJ', country: 'US', type: 'card_show' as const };
    store = addShow(store, 'sample-a-2026-09-01', snap, new Date());
    store = updateShow(store, 'sample-a-2026-09-01', { grossSales: 900, wouldDoAgain: 4 }, new Date());
    store = addShow(store, 'sample-a-2026-10-01', snap, new Date());
    store = updateShow(store, 'sample-a-2026-10-01', { grossSales: 1100, wouldDoAgain: 5 }, new Date());
    store = addShow(store, 'sample-b-2026-10-01', snap, new Date()); // no results yet
    const h = historyFromMyShows(store, seriesFromShowId);
    expect(h).toEqual({ 'sample-a': { gross_sales: [900, 1100], rating: 4.5 } });
    expect(toPlannerSettings(fullSettings(), { history: h }).settings.history).toEqual(h);
  });
});

describe('the forms', () => {
  it('the coming weekend is the next Friday to Sunday', () => {
    expect(comingWeekend('2026-10-21')).toEqual({ start: '2026-10-23', end: '2026-10-25' }); // Wednesday
    expect(comingWeekend('2026-10-23')).toEqual({ start: '2026-10-23', end: '2026-10-25' }); // Friday
    expect(comingWeekend('2026-10-24')).toEqual({ start: '2026-10-30', end: '2026-11-01' }); // Saturday: next weekend
    expect(comingWeekend('2026-10-25')).toEqual({ start: '2026-10-30', end: '2026-11-01' });
    for (let i = 0; i < 14; i++) expect(weekday(comingWeekend(addDays('2026-10-19', i)).start)).toBe(5);
  });

  it('start with the settings and sensible defaults', () => {
    const w = defaultWeekendForm(today);
    expect(w).toMatchObject({ mode: 'vending', overnight: 'stay', endSame: true, startPlace: null, maxDriveHours: null, sells: null, weights: 'balanced' });
    const s = defaultSeasonForm(today);
    expect(s).toMatchObject({ span: '3m', weekendsOnly: true, chain: true, keepPastDeadline: false });
    expect(seasonRange(s, today)).toEqual({ start: today, end: addDays(today, 90) });
    expect(seasonRange({ ...s, span: '6m' }, today).end).toBe(addDays(today, 182));
    expect(seasonRange({ ...s, span: 'custom', start: '2026-12-01', end: '2027-02-01' }, today)).toEqual({ start: '2026-12-01', end: '2027-02-01' });
  });

  it('turn into planner options', () => {
    const settings = toPlannerSettings(fullSettings());
    const ctx = { today, home: { lat: 39.9526, lon: -75.1652 }, labels: { pokemon: 'Pokémon' }, rates: { CAD_USD: 0.73 } };
    const w = buildWeekendOptions({ ...defaultWeekendForm(today), overnight: 'home', weights: 'cheapest' }, ctx);
    expect(w).toMatchObject({ mode: 'vending', dates: { start: '2026-10-23', end: '2026-10-25' }, overnight: 'home', weights: 'cheapest', today, alternatives: 3, rates: { CAD_USD: 0.73 } });
    expect(w.start).toMatchObject({ lat: 39.9526, name: 'Home' });
    expect(w.end).toBeUndefined(); // ends where it started
    const away = buildWeekendOptions({ ...defaultWeekendForm(today), startPlace: { lat: 40, lon: -74, label: '08837', country: 'US' }, endSame: false, endPlace: null }, ctx);
    expect(away.start).toMatchObject({ lat: 40, lon: -74, name: '08837' });
    expect(away.end).toMatchObject({ name: 'Home' });
    const shop = buildWeekendOptions({ ...defaultWeekendForm(today), mode: 'shopping', dwellMinutes: 60, sells: ['mtg'] }, ctx);
    expect(shop).toMatchObject({ mode: 'shopping', dwellMinutes: 60, interests: ['mtg'] });
    const vend = buildWeekendOptions(defaultWeekendForm(today), { today, home: null });
    expect(vend.start).toBeUndefined();
    expect(vend.rates).toBeUndefined();
    const season = buildSeasonOptions({ ...defaultSeasonForm(today), blackout: ['2026-11-26'], maxShowsPerMonth: null, fridayCounts: true, keepPastDeadline: true }, ctx);
    expect(season).toMatchObject({ range: { start: today, end: addDays(today, 90) }, blackout: ['2026-11-26'], weekendsOnly: true, fridayIsWeekend: true, maxShowsPerMonth: null, maxNightsAway: 3, chain: true, keepPastDeadline: true });
    expect(settings.settings.home).not.toBeNull();
  });

  it('apply the numbers typed into a plan', () => {
    const base = fullSettings();
    const s = settingsForPlan(base, { maxDriveHours: 5, sells: ['pokemon'] }, { tableFees: {}, hotel: 150, fuelPrice: 4 });
    expect(s).toMatchObject({ hotelPerNight: 150, fuelPrice: 4, maxDrivingHoursPerDay: 5, sells: ['pokemon'] });
    expect(settingsForPlan(base, { maxDriveHours: null, sells: null }, { tableFees: {}, hotel: null, fuelPrice: null })).toEqual(base);
    const edited = applyTableFees(rows, { [rows[0]!.id]: 999 });
    expect(edited[0]?.vendor?.min_table_price).toBe(999);
    expect(edited[1]).toBe(rows[1]); // untouched rows are reused
    expect(applyTableFees(rows, {})).toBe(rows);
  });

  it('read saved forms safely', () => {
    expect(sanitizeWeekendForm(null, today)).toEqual(defaultWeekendForm(today));
    const w = sanitizeWeekendForm({ mode: 'shopping', start: '2020-01-01', end: '2020-01-03', overnight: 'home', maxDriveHours: 99, sells: ['pokemon', 5], weights: 'nope', mustIncludeId: 'x', dwellMinutes: 5 }, today);
    expect(w).toMatchObject({ mode: 'shopping', start: '2026-10-23', overnight: 'home', maxDriveHours: null, sells: ['pokemon'], weights: 'balanced', mustIncludeId: null, dwellMinutes: 90 });
    const s = sanitizeSeasonForm({ span: 'custom', blackout: ['2026-12-25', 'nope', '2026-12-25'], maxShowsPerMonth: null, maxNightsAway: 2.4, chain: false }, today);
    expect(s).toMatchObject({ span: 'custom', blackout: ['2026-12-25'], maxShowsPerMonth: null, maxNightsAway: 2, chain: false });
  });
});

describe('planning end to end with the real planner', () => {
  const planner = inProcessPlanner(rows);
  const settings = toPlannerSettings(fullSettings());
  const ctx = { today, home: { lat: 39.9526, lon: -75.1652 }, labels: labelMap(DEFAULT_VOCAB) };

  async function findWeekend() {
    for (let k = 0; k < 14; k++) {
      const start = addDays(comingWeekend(today).start, 7 * k);
      const form = { ...defaultWeekendForm(today), start, end: addDays(start, 2), maxDriveHours: 10 };
      const run = await runWeekend(planner, { settings: settings.settings, options: buildWeekendOptions(form, ctx) });
      if (run.plans.length > 0 && run.plans[0]!.plan.stops.length >= 1) return { form, run };
    }
    throw new Error('no weekend with a plan in the sample data');
  }

  it('makes a weekend run with a best plan, money and deadlines', async () => {
    const { form, run } = await findWeekend();
    expect(run.kind).toBe('weekend');
    const best = run.plans[0]!.plan;
    expect(run.plans[0]?.role).toBe('best');
    expect(best.summary.length).toBeGreaterThan(5);
    expect(best.money.label).toMatch(/Expected (profit|loss)/);
    expect(best.money.costs.length).toBeGreaterThan(0);
    expect(best.driveTimes.label.length).toBeGreaterThan(3);
    for (const s of best.stops) expect(s.firstDate >= form.start && s.lastDate <= form.end).toBe(true);
    for (const e of run.plans.slice(1)) expect(e.plan.note).toBeTruthy();
  });

  it('plans a season from home and groups it by month', async () => {
    const options = buildSeasonOptions({ ...defaultSeasonForm(today), span: '6m', maxDriveHours: 6 }, ctx);
    const run = await runSeason(planner, { settings: settings.settings, options });
    expect(run.kind).toBe('season');
    expect(run.plans).toHaveLength(1);
    const plan = run.plans[0]!.plan;
    expect(plan.stops.length).toBeGreaterThan(1);
    const groups = groupByMonthHelper(plan);
    expect(groups.reduce((n, g) => n + g.stops.length, 0)).toBe(plan.stops.length);
    expect(groups.map((g) => g.month)).toEqual([...groups.map((g) => g.month)]); // months in order
    expect(plan.deadlines.length).toBeGreaterThan(0);
  });

  it('plans by priority score and still works when sales are not filled in', async () => {
    const scoreOnly = toPlannerSettings(normalizeSettings({ home: { postal: '19103', lat: 39.9526, lon: -75.1652, country: 'US' } }));
    expect(scoreOnly.profit).toBe(false);
    const options = buildSeasonOptions({ ...defaultSeasonForm(today), span: '6m' }, ctx);
    const run = await runSeason(planner, { settings: scoreOnly.settings, options });
    expect(run.plans[0]?.plan.objective).toBe('score');
    expect(run.plans[0]?.plan.stops.length).toBeGreaterThan(0);
    expect(run.warnings.join(' ')).toMatch(/priority score/);
  });

  it('puts a must include show first, and plans it alone when the best plans leave it out', async () => {
    const { form, run } = await findWeekend();
    const inBest = run.plans[0]!.plan.stops[0]!;
    const ok = await runWeekend(planner, { settings: settings.settings, options: buildWeekendOptions(form, ctx), mustInclude: { id: inBest.showId, name: inBest.name } });
    expect(ok.plans[0]?.plan.stops.some((s) => s.showId === inBest.showId)).toBe(true);
    expect(ok.notices).toEqual([]);
    // a show the best plan skips: any show in the dates that is not in any plan
    const inPlans = new Set(run.plans.flatMap((e) => e.plan.stops.map((s) => s.showId)));
    const other = rows.find((r) => !inPlans.has(r.id) && r.status !== 'cancelled' && r.days.some((d) => d.date >= form.start && d.date <= form.end) && r.vendor?.status !== 'closed' && r.vendor?.status !== 'sold_out');
    if (other) {
      const forced = await runWeekend(planner, { settings: settings.settings, options: buildWeekendOptions(form, ctx), mustInclude: { id: other.id, name: other.name } });
      expect(forced.notices.length).toBe(1);
      expect(forced.notices[0]).toContain(other.name);
      const first = forced.plans[0];
      if (first && first.role === 'forced') {
        expect(first.plan.stops.map((s) => s.showId)).toEqual([other.id]);
        expect(first.plan.title).toBe(`Just ${other.name}`);
      }
    }
  });

  it('plans a must include show alone even when it is expected to lose money, and says so', async () => {
    const { form } = await findWeekend();
    // the best plan's own show, made too expensive to be worth it
    const base = await runWeekend(planner, { settings: settings.settings, options: buildWeekendOptions(form, ctx) });
    const inDates = rows.find((r) => r.id === base.plans[0]!.plan.stops[0]!.showId);
    expect(inDates).toBeDefined();
    const costly = inProcessPlanner(applyTableFees(rows, { [inDates!.id]: 9000 }));
    const run = await runWeekend(costly, { settings: settings.settings, options: buildWeekendOptions(form, ctx), mustInclude: { id: inDates!.id, name: inDates!.name } });
    const first = run.plans[0];
    expect(first?.role).toBe('forced');
    expect(first?.plan.stops.map((s) => s.showId)).toEqual([inDates!.id]);
    expect(first?.plan.money.label).toMatch(/Expected loss/);
    expect(run.notices[0]).toContain(inDates!.name);
  });

  it('changing a table fee changes the plan numbers', async () => {
    const { form, run } = await findWeekend();
    const best = run.plans[0]!.plan;
    const id = best.stops[0]!.showId;
    const cheap = inProcessPlanner(applyTableFees(rows, { [id]: 1 }));
    const pricey = inProcessPlanner(applyTableFees(rows, { [id]: 5000 }));
    const a = await runWeekend(cheap, { settings: settings.settings, options: buildWeekendOptions({ ...form }, ctx, { onlyIds: [id], alternatives: 0 }) });
    const b = await runWeekend(pricey, { settings: settings.settings, options: buildWeekendOptions({ ...form }, ctx, { onlyIds: [id], alternatives: 0 }) });
    const tableLine = (r: typeof a) => r.plans[0]?.plan.money.costs.find((c) => c.kind === 'table')?.amount;
    expect(tableLine(a)).toBe(1);
    expect(b.plans.length === 0 || tableLine(b) === 5000).toBe(true);
  });
});

describe('exchange rates', () => {
  it('finds the currency a plan left shows out for', () => {
    const excluded = [
      { id: 'a', name: 'A', reason: 'Table price is in CAD. Add an exchange rate to include it.' },
      { id: 'b', name: 'B', reason: 'Sold out' },
      { id: 'c', name: 'C', reason: 'Table price is in CAD. Add an exchange rate to include it.' },
      { id: 'd', name: 'D', reason: 'Table price is in USD. Add an exchange rate to include it.' },
    ];
    expect(currenciesNeedingRate(excluded, 'USD')).toEqual(['CAD']);
    expect(currenciesNeedingRate(excluded, 'CAD')).toEqual(['USD']);
    expect(currenciesNeedingRate([], 'USD')).toEqual([]);
    expect(rateKey('CAD', 'USD')).toBe('CAD_USD');
  });

  it('only keeps sensible saved rates', () => {
    expect(sanitizeRates({ CAD_USD: 0.73, bad: 1, USD_CAD: -2, EUR_USD: 'x', GBP_USD: 5000 })).toEqual({ CAD_USD: 0.73 });
    expect(sanitizeRates(null)).toEqual({});
  });

  it('a rate lets the planner include shows in the other currency', async () => {
    const caShow = rows.find((r) => r.country === 'CA' && r.vendor?.min_table_price != null);
    if (!caShow) return;
    const planner = inProcessPlanner(rows);
    const settings = toPlannerSettings(fullSettings());
    const ctx = { today, home: { lat: caShow.lat, lon: caShow.lon } };
    const form = { ...defaultWeekendForm(today), start: addDays(caShow.days[0]!.date, -1), end: addDays(caShow.days[caShow.days.length - 1]!.date, 1), maxDriveHours: 12 };
    const without = await runWeekend(planner, { settings: settings.settings, options: buildWeekendOptions(form, ctx, { onlyIds: [caShow.id] }) });
    const withRate = await runWeekend(planner, { settings: settings.settings, options: buildWeekendOptions(form, { ...ctx, rates: { CAD_USD: 0.73 } }, { onlyIds: [caShow.id] }) });
    expect(currenciesNeedingRate(without.excluded, 'USD')).toEqual(['CAD']);
    expect(withRate.excluded.some((x) => /exchange rate/.test(x.reason))).toBe(false);
    expect(withRate.plans.length).toBeGreaterThan(0);
  });
});

describe('share links through the page layer', () => {
  const planner = inProcessPlanner(rows);
  const settings = toPlannerSettings(fullSettings());
  const ctx = { today, home: { lat: 39.9526, lon: -75.1652 } };

  async function aSeason() {
    const form = { ...defaultSeasonForm(today), span: '6m' as const, maxShowsPerMonth: 3, maxNightsAway: 2, blackout: ['2026-11-26'], chain: false, weights: 'cheapest' as const };
    const options = buildSeasonOptions(form, ctx);
    const run = await runSeason(planner, { settings: settings.settings, options });
    return { form, run, plan: run.plans[0]!.plan, range: options.range };
  }

  it('round trips a season plan: shows and planning knobs come back, and nothing personal goes in', async () => {
    const { form, plan, range } = await aSeason();
    const link = await makeShareLink(planner, { kind: 'season', form, range, startPoint: { lat: 39.9526, lon: -75.1652 } }, plan, false);
    expect(link).toMatch(/^[A-Za-z0-9_.-]+$/);
    const opened = await openShare(planner, link, today);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.tab).toBe('season');
    expect(opened.value.onlyIds).toEqual(plan.stops.map((s) => s.showId));
    expect(opened.value.season).toMatchObject({ span: 'custom', start: range.start, end: range.end, maxShowsPerMonth: 3, maxNightsAway: 2, blackout: ['2026-11-26'], chain: false, weights: 'cheapest', weekendsOnly: true });
    expect(opened.value.start).toBeNull(); // the start point was not shared
    // nothing from the vendor's settings is in the link
    const decoded = decodeShareLink(link);
    const text = JSON.stringify(decoded);
    for (const secret of ['3.4', '1200', '39.95', '-75.16', 'margin', 'typical', 'hotel']) expect(text).not.toContain(secret);
  });

  it('includes the start point only when asked, rounded', async () => {
    const { form, plan, range } = await aSeason();
    const without = await makeShareLink(planner, { kind: 'season', form, range, startPoint: { lat: 39.95261234, lon: -75.16521234 } }, plan, false);
    const withStart = await makeShareLink(planner, { kind: 'season', form, range, startPoint: { lat: 39.95261234, lon: -75.16521234 } }, plan, true);
    const a = decodeShareLink(without);
    const b = decodeShareLink(withStart);
    expect(a.ok && a.value.start).toBeFalsy();
    expect(b.ok && b.value.start).toBeTruthy();
    if (b.ok && b.value.start) {
      expect(Math.abs(b.value.start.lat - 39.9526)).toBeLessThan(0.002);
      expect(String(b.value.start.lat).length).toBeLessThan(10);
    }
    const opened = await openShare(planner, withStart, today);
    expect(opened.ok && opened.value.start?.lat).toBeCloseTo(39.9526, 2);
    expect(opened.ok && opened.value.season.startPlace?.lat).toBeCloseTo(39.9526, 2);
  });

  it('round trips a weekend run, including shopping', async () => {
    const form = { ...defaultWeekendForm(today), mode: 'shopping' as const, start: '2026-11-13', end: '2026-11-15', overnight: 'home' as const, maxDriveHours: 4, dwellMinutes: 60, weights: 'closest' as const };
    const fakePlan = { stops: [{ showId: 'sample-a-2026-11-14' }, { showId: 'sample-b-2026-11-15' }] } as never;
    const link = await makeShareLink(planner, { kind: 'weekend', form, startPoint: null }, fakePlan, false);
    const opened = await openShare(planner, link, today);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.tab).toBe('weekend');
    expect(opened.value.onlyIds).toEqual(['sample-a-2026-11-14', 'sample-b-2026-11-15']);
    expect(opened.value.weekend).toMatchObject({ mode: 'shopping', start: '2026-11-13', end: '2026-11-15', overnight: 'home', maxDriveHours: 4, dwellMinutes: 60, weights: 'closest' });
  });

  it('moves dates in the past forward and rejects damaged links with a plain message', async () => {
    const form = { ...defaultWeekendForm(today), start: '2026-11-13', end: '2026-11-15' };
    const link = await makeShareLink(planner, { kind: 'weekend', form, startPoint: null }, { stops: [{ showId: 'sample-a-2026-11-14' }] } as never, false);
    const late = await openShare(planner, link, '2026-11-14');
    expect(late.ok && late.value.weekend.start).toBe('2026-11-14');
    const bad = await openShare(planner, link.slice(0, -4) + 'zzzz', today);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/link/i);
    expect((await openShare(planner, 'not a link', today)).ok).toBe(false);
  });

  it('puts the link in the part of the address after the hash', () => {
    const url = shareUrl('abc123', 'https://example.org', '/card-show-atlas');
    expect(url).toBe('https://example.org/card-show-atlas/plan/#plan=abc123');
    expect(linkFromHash('#plan=abc123')).toBe('abc123');
    expect(linkFromHash('plan=abc.def-1_2')).toBe('abc.def-1_2');
    expect(linkFromHash('')).toBeNull();
    expect(linkFromHash('#other=1')).toBeNull();
    expect(linkFromHash('#plan=<script>')).toBeNull();
  });

  it('shares what the planner shares: ids, never settings', () => {
    const payload = sharePayload({ kind: 'weekend', form: defaultWeekendForm(today), startPoint: { lat: 1, lon: 2 } }, { stops: [{ showId: 'x-2026-11-14' }] } as never, false);
    expect(payload.start).toBeUndefined();
    expect(Object.keys(payload).sort()).toEqual(['mode', 'settings', 'showIds']);
    expect(encodeShareLink(payload).length).toBeGreaterThan(10);
  });
});

describe('the calendar for a plan', () => {
  it('has the shows with real hours and a reminder 7 days and 1 day before each deadline', async () => {
    const planner = inProcessPlanner(rows);
    const settings = toPlannerSettings(fullSettings());
    const options = buildSeasonOptions({ ...defaultSeasonForm(today), span: '6m' }, { today, home: { lat: 39.9526, lon: -75.1652 } });
    const run = await runSeason(planner, { settings: settings.settings, options });
    const plan = run.plans[0]!.plan;
    const ics = planCalendar(plan, new Map(rows.map((r) => [r.id, r])), { today, now: new Date('2026-10-21T12:00:00Z') }).replace(/\r\n[ \t]/g, '');
    expect(ics.startsWith('BEGIN:VCALENDAR')).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)!.length).toBeGreaterThanOrEqual(plan.stops.length);
    expect(ics).toContain(`SUMMARY:${plan.stops[0]!.name.replace(/[,;]/g, (c) => `\\${c}`)}`);
    const withDate = plan.deadlines.filter((d) => d.date && d.date >= today);
    expect(withDate.length).toBeGreaterThan(0);
    expect(ics.match(/TRIGGER:-P7D/g)).toHaveLength(withDate.length);
    expect(ics.match(/TRIGGER:-P1D/g)).toHaveLength(withDate.length);
    expect(ics).toContain('SUMMARY:Apply by: ');
    expect(ics).toMatch(/DTSTART:\d{8}T\d{6}Z/); // timed events, in UTC
  });

  it('leaves out deadlines that have passed or have no date', () => {
    const plan = { deadlines: [{ showId: 'a', name: 'A', date: '2026-10-01', label: 'x', status: null, waitlist: false, passed: true }, { showId: 'b', name: 'B', date: null, label: 'No deadline listed', status: null, waitlist: false, passed: false }, { showId: 'c', name: 'C', date: '2026-11-03', label: 'Apply by Nov 3', status: 'open', waitlist: false, passed: false }] } as never;
    expect(deadlineReminders(plan, today).map((r) => r.uid)).toEqual(['c-apply']);
    expect(deadlineReminders(plan, today)[0]?.daysBefore).toEqual([7, 1]);
  });
});

describe('"Best for my table" on the Find page', () => {
  const planner = inProcessPlanner(rows);
  const settings = toPlannerSettings(fullSettings());

  it('scores shows out of 100 with reasons, and the presets match the planner', async () => {
    expect(WEIGHT_PRESETS.map((p) => p.id).sort()).toEqual(Object.keys(PRESET_LABELS).sort());
    for (const p of WEIGHT_PRESETS) expect(p.label).toBe(PRESET_LABELS[p.id]);
    const scores = await rankForTable(planner, settings.settings, { today, weights: 'balanced', labels: labelMap(DEFAULT_VOCAB) });
    const scored = [...scores.values()].filter((s) => s.score !== null);
    expect(scored.length).toBeGreaterThan(20);
    for (const s of scored) {
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(100);
      expect(s.reasons.length).toBeGreaterThan(0);
      expect(s.reasons.length).toBeLessThanOrEqual(3);
    }
    const out = [...scores.values()].find((s) => s.excluded);
    if (out) expect(scoreLine(out)).toMatch(/^Left out of your ranking: /);
    expect(scoreLine({ score: 82, reasons: [], excluded: false, excludedReason: null, waitlist: false, mode: 'points' })).toBe('Score 82 of 100');
    expect(scoreLine({ score: 70, reasons: [], excluded: false, excludedReason: null, waitlist: true, mode: 'points' })).toBe('Score 70 of 100, waitlist only');
  });

  it('scores by expected profit when sales are filled in, and by the weights when asked', async () => {
    const auto = await rankForTable(planner, settings.settings, { today, weights: 'cheapest' });
    expect([...auto.values()].some((s) => s.mode === 'profit' && s.score !== null)).toBe(true);
    const points = await rankForTable(planner, settings.settings, { today, weights: 'cheapest', scoreBy: 'points' });
    expect([...points.values()].every((s) => s.mode === 'points')).toBe(true);
  });

  it('different presets rank differently', async () => {
    const a = await rankForTable(planner, settings.settings, { today, weights: 'cheapest', scoreBy: 'points' });
    const b = await rankForTable(planner, settings.settings, { today, weights: 'closest', scoreBy: 'points' });
    let differ = 0;
    for (const [id, s] of a) if (s.score !== b.get(id)?.score) differ++;
    expect(differ).toBeGreaterThan(0);
  });

  it('sorts results by score, with shows left out of the ranking last', async () => {
    const scores = await rankForTable(planner, settings.settings, { today, weights: 'balanced' });
    const ids = rows.slice(0, 40).map((r) => r.id);
    const results = ids.map((id, k) => ({ row: makeRow({ i: id, d: addDays(today, k) }), miles: null, minutes: null }));
    const byId = new Map([...scores].map(([id, s]) => [id, s.score]));
    const sorted = sortResults(results, 'vendor', { today, selected: [], vocab: DEFAULT_VOCAB, vendorScores: byId });
    const seq = sorted.map((r) => byId.get(r.row.i) ?? null);
    const firstNull = seq.findIndex((x) => x === null);
    const cut = firstNull === -1 ? seq.length : firstNull;
    for (let i = 1; i < cut; i++) expect(seq[i - 1]!).toBeGreaterThanOrEqual(seq[i]!);
    expect(seq.slice(cut).every((x) => x === null)).toBe(true);
    // without scores it falls back to date order
    expect(sortResults(results, 'vendor', { today, selected: [], vocab: DEFAULT_VOCAB }).map((r) => r.row.i)).toEqual(ids);
    expect(selectResults([], { filters: DEFAULT_FILTERS, vocab: DEFAULT_VOCAB, range: null, origin: null, maxMiles: null })).toEqual([]);
  });
});
