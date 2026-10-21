// Small helpers for showing a plan: grouping by month, distances in the right unit, money lines.
import type { CostLine } from '../../../planner/src/profit.ts';
import { formatMoney as plannerMoney } from '../../../planner/src/format.ts';
import type { Plan, PlanLeg, PlanStop } from '../../../planner/src/vending.ts';
import { MONTHS_LONG, parseISODate } from './dates.ts';
import { formatDriveTime } from './format.ts';
import type { DistanceUnit } from './geo.ts';

export function monthTitle(date: string): string {
  const p = parseISODate(date);
  return p ? `${MONTHS_LONG[p.m - 1]} ${p.y}` : date;
}

/** Stops grouped by the month they start in, in date order. */
export function stopsByMonth(plan: Plan): { month: string; stops: PlanStop[] }[] {
  const groups: { month: string; stops: PlanStop[] }[] = [];
  for (const s of [...plan.stops].sort((a, b) => (a.firstDate < b.firstDate ? -1 : a.firstDate > b.firstDate ? 1 : 0))) {
    const title = monthTitle(s.firstDate);
    const last = groups[groups.length - 1];
    if (last && last.month === title) last.stops.push(s);
    else groups.push({ month: title, stops: [s] });
  }
  return groups;
}

/** "140 mi, about 2 h 20 min" or "225 km, about 2 h 20 min" */
export function legText(leg: PlanLeg, unit: DistanceUnit): string {
  const distance = unit === 'km' ? `${Math.round(leg.km)} km` : `${Math.round(leg.miles)} mi`;
  return `${distance}, ${formatDriveTime(leg.hours * 60)}`;
}

export function legTitle(leg: PlanLeg): string {
  return `${leg.from.name} to ${leg.to.name}`;
}

export function money(amount: number, currency: string): string {
  return plannerMoney(Math.round(amount * 100) / 100, currency);
}

/** Cost lines in a fixed, sensible order: table, extras, fuel, hotel, food, admission. */
export function orderedCosts(lines: CostLine[]): CostLine[] {
  const order = ['table', 'extras', 'fuel', 'hotel', 'food', 'admission'];
  return [...lines].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

export function deadlinesInOrder(plan: Plan): Plan['deadlines'] {
  return [...plan.deadlines].sort((a, b) => {
    if (a.date === null && b.date === null) return a.name.localeCompare(b.name);
    if (a.date === null) return 1;
    if (b.date === null) return -1;
    return a.date < b.date ? -1 : a.date > b.date ? 1 : a.name.localeCompare(b.name);
  });
}

/** A stop's number on the map and in the lists, as plain text. */
export function stopNumber(plan: Plan, showId: string): number {
  return plan.stops.findIndex((s) => s.showId === showId) + 1;
}

/** The stops of one trip, in order, for drawing its route. */
export function tripStops(plan: Plan): { label: string; stops: PlanStop[] }[] {
  if (plan.trips.length === 0) return [{ label: plan.title, stops: plan.stops }];
  return plan.trips.map((t) => ({ label: t.label, stops: plan.stops.filter((s) => t.showIds.includes(s.showId)) }));
}
