/**
 * Which shows can be planned at all, and why the others are left out. Every exclusion carries a
 * short plain reason so the UI can show "Sold out" or "Deadline passed (Oct 1)".
 */
import { epochDay, isValidDate, isValidTime, isValidTimeZone, weekdayOf } from './time.js';
import { formatShortDate } from './format.js';
import type { PlannerShow } from './types.js';

export interface Excluded {
  id: string;
  name: string;
  reason: string;
}

export interface ShowFlags {
  /** Only a waitlist spot is possible. */
  waitlist: boolean;
  /** Date announced but not confirmed. */
  tentative: boolean;
  deadlinePassed: boolean;
  /** Plain notes such as "Waitlist only" or "Date not confirmed". */
  notes: string[];
}

export interface Candidate {
  show: PlannerShow;
  flags: ShowFlags;
  /** Listed days sorted by date, duplicates removed. */
  days: PlannerShow['days'];
}

export interface CandidateRules {
  rangeStart: string;
  rangeEnd: string;
  today: string;
  /** Vending checks table status and deadlines; shopping does not. */
  purpose: 'vending' | 'shopping';
  blackout?: string[];
  weekendsOnly?: boolean;
  /** Count Friday as a weekend day when `weekendsOnly` is set. Default false. */
  fridayIsWeekend?: boolean;
  /** Keep shows whose deadline passed and mark them "waitlist only" instead of leaving them out. */
  keepPastDeadline?: boolean;
  includeStoreEvents?: boolean;
  /** Show ids to leave out (for example "skip this one"). */
  skipIds?: string[];
  /** Only these ids (used when rechecking a plan). */
  onlyIds?: string[];
}

export function validShowShape(show: PlannerShow): string | null {
  if (!show || typeof show.id !== 'string' || show.id.length === 0) return 'Missing id';
  if (!Array.isArray(show.days) || show.days.length === 0) return 'No dates listed';
  for (const d of show.days) {
    if (!d || typeof d.date !== 'string' || !isValidDate(d.date)) return 'A date is not valid';
    if (d.open !== null && d.open !== undefined && !isValidTime(d.open)) return 'An opening time is not valid';
    if (d.close !== null && d.close !== undefined && !isValidTime(d.close)) return 'A closing time is not valid';
  }
  if (typeof show.timezone !== 'string' || !isValidTimeZone(show.timezone)) return 'Time zone is missing';
  if (!(Math.abs(show.lat) <= 90 && Math.abs(show.lon) <= 180) || !Number.isFinite(show.lat) || !Number.isFinite(show.lon)) {
    return 'Location is missing';
  }
  return null;
}

export function sortedDays(show: PlannerShow): PlannerShow['days'] {
  const seen = new Map<string, PlannerShow['days'][number]>();
  for (const d of show.days) if (!seen.has(d.date)) seen.set(d.date, d);
  return [...seen.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function filterCandidates(
  shows: PlannerShow[],
  rules: CandidateRules,
): { kept: Candidate[]; excluded: Excluded[] } {
  const kept: Candidate[] = [];
  const excluded: Excluded[] = [];
  const start = epochDay(rules.rangeStart);
  const end = epochDay(rules.rangeEnd);
  const today = epochDay(rules.today);
  const blackout = new Set((rules.blackout ?? []).filter(isValidDate).map(epochDay));
  const skip = new Set(rules.skipIds ?? []);
  const only = rules.onlyIds ? new Set(rules.onlyIds) : null;
  const seenIds = new Set<string>();
  const weekend = new Set(rules.fridayIsWeekend ? [5, 6, 0] : [6, 0]);

  for (const show of shows) {
    const out = (reason: string) => excluded.push({ id: String(show?.id ?? ''), name: String(show?.name ?? ''), reason });
    const bad = validShowShape(show);
    if (bad) {
      out(bad);
      continue;
    }
    if (only && !only.has(show.id)) continue;
    if (seenIds.has(show.id)) continue;
    seenIds.add(show.id);
    if (skip.has(show.id)) {
      out('Skipped');
      continue;
    }
    if (show.status === 'cancelled') {
      out('Cancelled');
      continue;
    }
    if (show.status === 'postponed') {
      out('Postponed');
      continue;
    }
    if (show.event_type === 'store_event' && !rules.includeStoreEvents) {
      out('Store event (that layer is off)');
      continue;
    }
    const days = sortedDays(show);
    const dayNums = days.map((d) => epochDay(d.date));
    const flags: ShowFlags = { waitlist: false, tentative: show.status === 'tentative', deadlinePassed: false, notes: [] };

    if (rules.purpose === 'vending') {
      if (dayNums[0]! < start || dayNums[dayNums.length - 1]! > end) {
        out('Outside your dates');
        continue;
      }
    } else if (!dayNums.some((d) => d >= start && d <= end)) {
      out('Outside your dates');
      continue;
    }
    const relevant = rules.purpose === 'vending' ? days : days.filter((_, i) => dayNums[i]! >= start && dayNums[i]! <= end);
    const black = relevant.find((d) => blackout.has(epochDay(d.date)));
    if (black && (rules.purpose === 'vending' || relevant.every((d) => blackout.has(epochDay(d.date))))) {
      out(`On a blackout date (${formatShortDate(black.date)})`);
      continue;
    }
    if (rules.weekendsOnly && !relevant.every((d) => weekend.has(weekdayOf(d.date)))) {
      out('Not on a weekend');
      continue;
    }
    if (dayNums[dayNums.length - 1]! < today) {
      out('Already over');
      continue;
    }

    if (rules.purpose === 'vending') {
      const status = show.vendor?.status ?? 'unknown';
      if (status === 'sold_out') {
        out('Sold out');
        continue;
      }
      if (status === 'closed') {
        out('Applications closed');
        continue;
      }
      const deadline = show.vendor?.deadline ?? null;
      const passed = deadline !== null && isValidDate(deadline) && epochDay(deadline) < today;
      if (passed) {
        flags.deadlinePassed = true;
        if (status === 'waitlist' || rules.keepPastDeadline) {
          flags.waitlist = true;
          flags.notes.push(`Deadline passed (${formatShortDate(deadline)}), waitlist only`);
        } else {
          out(`Deadline passed (${formatShortDate(deadline)})`);
          continue;
        }
      } else if (status === 'waitlist') {
        flags.waitlist = true;
        flags.notes.push('Waitlist only');
      }
      if (dayNums[0]! < today) {
        out('Already started');
        continue;
      }
    }
    if (flags.tentative) flags.notes.push('Date not confirmed');
    kept.push({ show, flags, days });
  }
  return { kept, excluded };
}
