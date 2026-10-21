/**
 * Independent checks on a finished plan. This does not reuse the search code: it recomputes
 * opening hours, setup and teardown, drive times and costs from the raw inputs and reports every
 * problem in plain words. An empty list means the plan is feasible:
 *
 *  * never two places at once (drives and show time never overlap, and each drive starts where
 *    the previous one ended),
 *  * never over the daily driving cap, never outside the daily driving window,
 *  * vending: at the table from setup on day one to teardown on the last day, one show per day;
 *    shopping: every visit inside opening hours and at least the dwell time long,
 *  * hotel nights, food days and fuel match the money shown.
 */
import { sortedDays } from './candidates.js';
import { fuelCostPerMile, vendorCurrency } from './profit.js';
import { epochDay, isValidTime, localDate, MS_PER_HOUR, zonedTimeToInstant } from './time.js';
import { haversineMiles, Travel, type LegMatrix, type TravelModel } from './travel.js';
import type { ExchangeRates, LatLon, PlannerShow, PlanningRules, VendorSettings } from './types.js';
import { DEFAULT_RULES } from './types.js';
import type { Plan } from './vending.js';

export interface VerifyOptions {
  settings: VendorSettings;
  rules?: Partial<PlanningRules>;
  travel?: Partial<TravelModel>;
  knownLegs?: LegMatrix | LegMatrix[];
  rates?: ExchangeRates;
  /** Dates the whole trip must stay inside (weekend run). */
  within?: { start: string; end: string };
  blackout?: string[];
  /** Shopping: minutes at each show. Default 90. */
  dwellMinutes?: number;
  /** Shopping: the money check counts admission for this many people. Default 1. */
  people?: number;
}

const TOL_MS = 1000;
const TOL_H = 1e-6;

interface Interval {
  start: number;
  end: number;
  kind: 'drive' | 'show';
  what: string;
  from?: LatLon;
  to?: LatLon;
  at?: LatLon;
  legIndex?: number;
  segIndex?: number;
  segCount?: number;
}

function near(a: LatLon, b: LatLon): boolean {
  return haversineMiles(a, b) < 0.05;
}

export function verifyPlan(plan: Plan, shows: PlannerShow[], opts: VerifyOptions): string[] {
  const problems: string[] = [];
  const rules: PlanningRules = { ...DEFAULT_RULES, ...(opts.rules ?? {}) };
  const settings = opts.settings;
  const cap = settings.max_drive_hours_per_day;
  const travel = new Travel(opts.travel, opts.knownLegs);
  const byId = new Map(shows.map((s) => [s.id, s]));
  const blackout = new Set((opts.blackout ?? []).map(epochDay));
  const intervals: Interval[] = [];
  const dwellMs = (opts.dwellMinutes ?? 90) * 60_000;

  // Drives.
  plan.legs.forEach((leg, li) => {
    if (plan.kind === 'shopping' && leg.hours > cap + TOL_H) problems.push(`The drive to ${leg.to.name} is longer than your daily limit.`);
    const sum = leg.segments.reduce((a, s) => a + s.hours, 0);
    if (Math.abs(sum - leg.hours) > 1e-6) problems.push(`Drive to ${leg.to.name} is split into parts that do not add up.`);
    if (leg.source === 'estimate') {
      const again = travel.leg(leg.from, leg.to);
      if (Math.abs(again.hours - leg.hours) > 1e-6) problems.push(`Drive to ${leg.to.name} does not match the travel model.`);
    }
    leg.segments.forEach((sg, si) => {
      if (Math.abs((sg.arriveMs - sg.departMs) / MS_PER_HOUR - sg.hours) > 1e-6) {
        problems.push(`A drive to ${leg.to.name} has times that do not match its length.`);
      }
      const early = zonedTimeToInstant(sg.date, plan.kind === 'shopping' ? rules.shoppingDayStart : rules.earliestDrive, sg.timezone);
      const late = zonedTimeToInstant(sg.date, rules.latestDrive, sg.arriveZone ?? sg.timezone);
      if (sg.departMs < early - TOL_MS) problems.push(`A drive on ${sg.date} starts before the driving window.`);
      if (sg.arriveMs > late + TOL_MS) problems.push(`A drive on ${sg.date} ends after the driving window.`);
      if (localDate(sg.departMs, sg.timezone) !== sg.date) problems.push(`A drive is filed under ${sg.date} but happens on another day.`);
      if (blackout.has(epochDay(sg.date))) problems.push(`Driving on a blackout date (${sg.date}).`);
      if (opts.within && (sg.date < opts.within.start || sg.date > opts.within.end)) problems.push(`Driving on ${sg.date}, outside the trip dates.`);
      intervals.push({
        start: sg.departMs,
        end: sg.arriveMs,
        kind: 'drive',
        what: `drive to ${leg.to.name}`,
        from: leg.from,
        to: leg.to,
        legIndex: li,
        segIndex: si,
        segCount: leg.segments.length,
      });
    });
  });

  // Daily cap.
  const perDay = new Map<string, number>();
  for (const l of plan.legs) for (const sg of l.segments) perDay.set(sg.date, (perDay.get(sg.date) ?? 0) + sg.hours);
  for (const [d, h] of perDay) if (h > cap + TOL_H) problems.push(`${d} has ${h.toFixed(2)} hours of driving, over the ${cap} hour limit.`);

  // Show time, recomputed from the show data.
  const usedDates = new Map<string, string>();
  for (const st of plan.stops) {
    const show = byId.get(st.showId);
    if (!show) {
      problems.push(`Unknown show ${st.showId}.`);
      continue;
    }
    const days = sortedDays(show);
    if (plan.kind === 'vending') {
      if (st.dates.join() !== days.map((d) => d.date).join()) problems.push(`${show.name} is not booked for all of its days.`);
      days.forEach((d, i) => {
        const open = zonedTimeToInstant(d.date, d.open ?? rules.defaultOpen, show.timezone);
        let close = zonedTimeToInstant(d.date, d.close ?? rules.defaultClose, show.timezone);
        if (close <= open) close = open + 4 * MS_PER_HOUR;
        const setup = show.vendor?.setup;
        const arriveBy =
          i === 0
            ? setup && isValidTime(setup)
              ? Math.min(zonedTimeToInstant(d.date, setup, show.timezone), open)
              : open - rules.setupLeadMinutes * 60_000
            : open - rules.laterDayLeadMinutes * 60_000;
        const leave = i === days.length - 1 ? close + rules.teardownMinutes * 60_000 : close;
        intervals.push({ start: arriveBy, end: leave, kind: 'show', what: show.name, at: show });
        const other = usedDates.get(d.date);
        if (other && other !== show.id) problems.push(`Two shows on ${d.date}.`);
        usedDates.set(d.date, show.id);
        if (blackout.has(epochDay(d.date))) problems.push(`${show.name} is on a blackout date.`);
        if (opts.within && (d.date < opts.within.start || d.date > opts.within.end)) problems.push(`${show.name} is outside the trip dates.`);
      });
      const vs = show.vendor?.status;
      if (vs === 'sold_out' || vs === 'closed') problems.push(`${show.name} is ${vs === 'sold_out' ? 'sold out' : 'closed to vendors'}.`);
    } else {
      const day = days.find((d) => d.date === st.firstDate);
      if (!day) {
        problems.push(`${show.name} is not open on ${st.firstDate}.`);
        continue;
      }
      const open = zonedTimeToInstant(day.date, day.open ?? rules.defaultOpen, show.timezone);
      const close = zonedTimeToInstant(day.date, day.close ?? rules.defaultClose, show.timezone);
      if (st.arriveMs < open - TOL_MS) problems.push(`Visit to ${show.name} starts before it opens.`);
      if (st.leaveMs > close + TOL_MS) problems.push(`Visit to ${show.name} ends after it closes.`);
      if (st.leaveMs - st.arriveMs < dwellMs - TOL_MS) problems.push(`Visit to ${show.name} is shorter than the time you set.`);
      intervals.push({ start: st.arriveMs, end: st.leaveMs, kind: 'show', what: show.name, at: show });
    }
  }
  if (plan.kind === 'shopping') {
    const ids = plan.stops.map((s) => s.showId);
    if (new Set(ids).size !== ids.length) problems.push('A show is visited twice.');
  }

  // Never two places at once, and each move starts where the last one ended.
  intervals.sort((a, b) => a.start - b.start || (a.kind === 'drive' ? -1 : 1));
  for (let i = 1; i < intervals.length; i++) {
    const p = intervals[i - 1]!;
    const c = intervals[i]!;
    if (c.start < p.end - TOL_MS) problems.push(`Two places at once: ${p.what} overlaps ${c.what}.`);
  }
  let loc: LatLon | null = plan.start;
  let onRoad: number | null = null;
  for (const it of intervals) {
    if (it.kind === 'drive') {
      if (it.segIndex === 0) {
        if (onRoad !== null) problems.push(`A new drive starts before the last one finished (${it.what}).`);
        if (!loc || !near(loc, it.from!)) problems.push(`The ${it.what} does not start where you are.`);
      } else if (onRoad !== it.legIndex) {
        problems.push(`A drive is picked up out of order (${it.what}).`);
      }
      if (it.segIndex === it.segCount! - 1) {
        loc = it.to!;
        onRoad = null;
      } else {
        loc = null;
        onRoad = it.legIndex!;
      }
    } else if (!loc || !near(loc, it.at!)) {
      problems.push(`Not at ${it.what} when it starts.`);
    }
  }
  if (onRoad !== null) problems.push('The plan ends on the road.');
  if (loc && !near(loc, plan.end)) problems.push('The plan does not end at the end point.');

  // Nights at home must really be at home.
  for (const n of plan.nights) {
    const endOfDay = zonedTimeToInstant(n.date, '23:59', plan.stops[0]?.timezone ?? 'UTC');
    let where: LatLon | null = plan.start;
    for (const it of intervals) {
      if (it.kind !== 'drive' || it.start > endOfDay) continue;
      where = it.segIndex === it.segCount! - 1 ? it.to! : null;
    }
    if (n.where === 'home' && (!where || (!near(where, plan.start) && !near(where, plan.end)))) {
      problems.push(`Night of ${n.date} is marked home but you are not home.`);
    }
    if (n.where === 'hotel' && where && near(where, plan.start) && near(plan.start, plan.end)) {
      problems.push(`Night of ${n.date} is a hotel night but you are home.`);
    }
  }

  // Money matches the itinerary.
  const hotel = plan.nights.filter((n) => n.where === 'hotel').length;
  if (hotel !== plan.hotelNights) problems.push('Hotel nights do not match the nights listed.');
  const activeDays = new Set<string>();
  for (const l of plan.legs) for (const sg of l.segments) activeDays.add(sg.date);
  for (const st of plan.stops) for (const d of st.dates) activeDays.add(d);
  const hotelDates = new Set(plan.nights.filter((n) => n.where === 'hotel').map((n) => epochDay(n.date)));
  const allDays = new Set<number>([...[...activeDays].map(epochDay), ...[...hotelDates].map((d) => d + 1)]);
  const foodDays = [...allDays].length;
  const line = (kind: string) => plan.money.costs.filter((c) => c.kind === kind).reduce((a, c) => a + c.amount, 0);
  const cur = vendorCurrency(settings);
  if (plan.stops.length > 0) {
    if (Math.abs(line('hotel') - hotel * settings.hotel_per_night) > 0.01) problems.push(`Hotel cost does not match ${hotel} nights.`);
    if (Math.abs(line('food') - foodDays * settings.food_per_day) > 0.01) problems.push(`Food cost does not match ${foodDays} days away.`);
    try {
      const fuel = fuelCostPerMile(settings, opts.rates);
      const miles = plan.legs.reduce((a, l) => a + l.miles, 0);
      if (Math.abs(line('fuel') - miles * fuel.perMile) > 0.01) problems.push('Fuel cost does not match the miles driven.');
    } catch {
      // No fuel price: nothing to compare.
    }
    if (plan.money.currency !== cur) problems.push('Money is not in your currency.');
  }
  return problems;
}
