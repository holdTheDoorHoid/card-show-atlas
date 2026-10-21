// Logic for the map's time window bar: a 12 month timeline with a window you drag along it.
import { MAX_WINDOW_DAYS, TIMELINE_DAYS } from './config.ts';
import { addDays, MONTHS_SHORT, formatMonthDay, parseISODate } from './dates.ts';
import { rowDays, rowOverlaps } from './index-build.ts';
import type { IndexRow } from './types.ts';

export interface TimeWindow {
  /** days after today that the window starts (0 is today) */
  start: number;
  /** how many days wide, 1 to 92 */
  width: number;
}

export const DEFAULT_WINDOW: TimeWindow = { start: 0, width: 7 };

export function clampWindow(w: TimeWindow, total: number = TIMELINE_DAYS): TimeWindow {
  const width = Math.min(Math.max(1, Math.round(w.width)), Math.min(MAX_WINDOW_DAYS, total));
  const start = Math.min(Math.max(0, Math.round(w.start)), total - width);
  return { start, width };
}

export function moveWindow(w: TimeWindow, deltaDays: number, total: number = TIMELINE_DAYS): TimeWindow {
  return clampWindow({ start: w.start + deltaDays, width: w.width }, total);
}

/** Change the width but keep the start where it is, unless that would run off the end. */
export function resizeWindow(w: TimeWindow, width: number, total: number = TIMELINE_DAYS): TimeWindow {
  return clampWindow({ start: w.start, width }, total);
}

/** The window's first and last date. */
export function windowDates(today: string, w: TimeWindow): { from: string; to: string } {
  return { from: addDays(today, w.start), to: addDays(today, w.start + w.width - 1) };
}

/** Step forward one week for the play button. `done` is true when the window has reached the end. */
export function stepWeek(w: TimeWindow, total: number = TIMELINE_DAYS): { window: TimeWindow; done: boolean } {
  const next = moveWindow(w, 7, total);
  const done = next.start === w.start || next.start + next.width >= total;
  return { window: next, done };
}

/** Which day of the timeline a pointer is over, from the track's left edge and width in pixels. */
export function dayFromPointer(clientX: number, trackLeft: number, trackWidth: number, total: number = TIMELINE_DAYS): number {
  if (trackWidth <= 0) return 0;
  const frac = (clientX - trackLeft) / trackWidth;
  return Math.min(total - 1, Math.max(0, Math.floor(frac * total)));
}

/**
 * Where the window goes while dragging. `grabOffset` is how many days into the window the pointer
 * grabbed it, so the window does not jump under the finger.
 */
export function dragTo(w: TimeWindow, pointerDay: number, grabOffset: number, total: number = TIMELINE_DAYS): TimeWindow {
  return clampWindow({ start: pointerDay - grabOffset, width: w.width }, total);
}

/** Number of shows on each of the next `total` days (a multi day show counts on each of its days). */
export function dayCounts(rows: IndexRow[], today: string, total: number = TIMELINE_DAYS): number[] {
  const counts = new Array<number>(total).fill(0);
  const end = addDays(today, total - 1);
  const t = parseISODate(today);
  if (!t) return counts;
  const base = Date.UTC(t.y, t.m - 1, t.d);
  for (const row of rows) {
    if (row.d > end || (row.e ?? row.d) < today) continue;
    for (const day of rowDays(row)) {
      if (day < today || day > end) continue;
      const p = parseISODate(day);
      if (!p) continue;
      const idx = Math.round((Date.UTC(p.y, p.m - 1, p.d) - base) / 86400000);
      if (idx >= 0 && idx < total) counts[idx] = (counts[idx] ?? 0) + 1;
    }
  }
  return counts;
}

export function rowsInWindow(rows: IndexRow[], today: string, w: TimeWindow): IndexRow[] {
  const { from, to } = windowDates(today, w);
  return rows.filter((r) => rowOverlaps(r, from, to));
}

/** Month labels along the timeline: the day offset where each month starts, and its name. */
export function monthMarks(today: string, total: number = TIMELINE_DAYS): { offset: number; label: string }[] {
  const t = parseISODate(today);
  if (!t) return [];
  const marks: { offset: number; label: string }[] = [{ offset: 0, label: MONTHS_SHORT[t.m - 1] as string }];
  let y = t.y;
  let m = t.m;
  for (;;) {
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    const offset = Math.round((Date.UTC(y, m - 1, 1) - Date.UTC(t.y, t.m - 1, t.d)) / 86400000);
    if (offset >= total) break;
    marks.push({ offset, label: m === 1 ? `Jan ${y}` : (MONTHS_SHORT[m - 1] as string) });
  }
  return marks;
}

/** "Nov 14 to 20" for the window's summary line. */
export function describeWindow(today: string, w: TimeWindow): string {
  const { from, to } = windowDates(today, w);
  if (from === to) return formatMonthDay(from);
  const a = parseISODate(from);
  const b = parseISODate(to);
  if (a && b && a.m === b.m && a.y === b.y) return `${MONTHS_SHORT[a.m - 1]} ${a.d} to ${b.d}`;
  return `${formatMonthDay(from)} to ${formatMonthDay(to)}`;
}

export const WIDTH_PRESETS: { label: string; days: number }[] = [
  { label: '1 day', days: 1 },
  { label: '1 week', days: 7 },
  { label: '2 weeks', days: 14 },
  { label: '1 month', days: 30 },
  { label: '3 months', days: 92 },
];
