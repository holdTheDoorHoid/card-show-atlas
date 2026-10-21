// A plan as a calendar file: each show (with its real hours and time zone) and a reminder 7 days
// and 1 day before each application deadline.
import type { PlannerShow } from '../../../planner/src/types.ts';
import type { Plan } from '../../../planner/src/vending.ts';
import { formatMonthDay } from './dates.ts';
import { buildCalendar, type IcsReminder, type IcsShow } from './ics.ts';
import { absoluteUrl, showPath } from './urls.ts';

export const DEADLINE_REMINDER_DAYS = [7, 1];

export function icsShowFromPlanner(row: PlannerShow, stopNotes: string[] = []): IcsShow {
  const place = [row.city, row.region].filter(Boolean).join(', ');
  const lines = [`Planned with Card Show Atlas: ${absoluteUrl(showPath(row.id))}`, ...stopNotes, 'Check the organizer before you travel.'];
  return {
    id: row.id,
    name: row.name,
    days: row.days.map((d) => ({ date: d.date, open: d.open, close: d.close })),
    timezone: row.timezone,
    location: place || null,
    url: absoluteUrl(showPath(row.id)),
    description: lines.join('\n'),
    status: row.status ?? 'scheduled',
  };
}

export function deadlineReminders(plan: Plan, today: string): IcsReminder[] {
  const out: IcsReminder[] = [];
  for (const d of plan.deadlines) {
    if (!d.date || d.date < today) continue;
    out.push({
      uid: `${d.showId}-apply`,
      date: d.date,
      summary: `Apply by: ${d.name}`,
      description: `${d.label}. ${formatMonthDay(d.date, true)}.`,
      url: absoluteUrl(showPath(d.showId)),
      daysBefore: DEADLINE_REMINDER_DAYS,
    });
  }
  return out;
}

/** The calendar for a plan. Stops whose row is not known are left out of the show events (their deadlines are kept). */
export function planCalendar(plan: Plan, rows: Map<string, PlannerShow>, opts: { today: string; now: Date; name?: string }): string {
  const shows = plan.stops.flatMap((s) => {
    const row = rows.get(s.showId);
    return row ? [icsShowFromPlanner(row, [s.hoursLabel])] : [];
  });
  return buildCalendar({ name: opts.name ?? plan.title, now: opts.now, shows, reminders: deadlineReminders(plan, opts.today) });
}
