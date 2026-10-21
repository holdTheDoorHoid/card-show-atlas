import { describe, expect, it } from 'vitest';
import {
  clampWindow,
  dayCounts,
  dayFromPointer,
  DEFAULT_WINDOW,
  describeWindow,
  dragTo,
  monthMarks,
  moveWindow,
  resizeWindow,
  rowsInWindow,
  stepWeek,
  windowDates,
} from './timewindow.ts';
import { makeRow } from './testing.ts';
import { addDays as addDaysISO } from './dates.ts';
import { rowOverlaps } from './index-build.ts';

const today = '2026-10-21';

describe('time window', () => {
  it('starts as seven days from today', () => {
    expect(DEFAULT_WINDOW).toEqual({ start: 0, width: 7 });
    expect(windowDates(today, DEFAULT_WINDOW)).toEqual({ from: '2026-10-21', to: '2026-10-27' });
  });

  it('keeps the width between one day and three months', () => {
    expect(clampWindow({ start: 0, width: 0 }).width).toBe(1);
    expect(clampWindow({ start: 0, width: 500 }).width).toBe(92);
    expect(resizeWindow({ start: 10, width: 7 }, 30)).toEqual({ start: 10, width: 30 });
  });

  it('cannot slide off either end of the 12 month timeline', () => {
    expect(moveWindow({ start: 3, width: 7 }, -10)).toEqual({ start: 0, width: 7 });
    expect(moveWindow({ start: 350, width: 7 }, 40)).toEqual({ start: 358, width: 7 });
    // widening near the end pushes the start back so the window still fits
    expect(resizeWindow({ start: 358, width: 7 }, 30)).toEqual({ start: 335, width: 30 });
  });

  it('steps a week at a time and says when it has reached the end', () => {
    const first = stepWeek({ start: 0, width: 7 });
    expect(first.window.start).toBe(7);
    expect(first.done).toBe(false);
    const last = stepWeek({ start: 352, width: 7 });
    expect(last.window.start).toBe(358);
    expect(last.done).toBe(true);
    expect(stepWeek({ start: 358, width: 7 }).done).toBe(true);
  });

  it('turns a pointer position into a day, clamped to the track', () => {
    expect(dayFromPointer(100, 100, 365)).toBe(0);
    expect(dayFromPointer(100 + 182.5, 100, 365)).toBe(182);
    expect(dayFromPointer(-50, 100, 365)).toBe(0);
    expect(dayFromPointer(9999, 100, 365)).toBe(364);
    expect(dayFromPointer(10, 0, 0)).toBe(0);
  });

  it('drags without jumping under the finger', () => {
    // grabbed 3 days into a 7 day window; pointer now over day 50
    expect(dragTo({ start: 20, width: 7 }, 50, 3)).toEqual({ start: 47, width: 7 });
    expect(dragTo({ start: 20, width: 7 }, 1, 3)).toEqual({ start: 0, width: 7 });
  });

  it('describes the window in words', () => {
    expect(describeWindow(today, DEFAULT_WINDOW)).toBe('Oct 21 to 27');
    expect(describeWindow(today, { start: 10, width: 1 })).toBe('Oct 31');
    expect(describeWindow(today, { start: 7, width: 30 })).toBe('Oct 28 to Nov 26');
  });
});

describe('day counts (the histogram)', () => {
  const rows = [
    makeRow({ i: 'today', d: '2026-10-21' }),
    makeRow({ i: 'two-day', d: '2026-10-22', e: '2026-10-23' }),
    makeRow({ i: 'same-day', d: '2026-10-22' }),
    makeRow({ i: 'gap', d: '2026-10-24', e: '2026-10-26', ds: ['2026-10-24', '2026-10-26'] }),
    makeRow({ i: 'past', d: '2026-10-01' }),
    makeRow({ i: 'too-far', d: '2028-01-01' }),
    makeRow({ i: 'overlaps-start', d: '2026-10-19', e: '2026-10-21' }),
  ];

  it('counts each show on each day it is on', () => {
    const counts = dayCounts(rows, today);
    expect(counts).toHaveLength(365);
    expect(counts[0]).toBe(2); // today, plus the show that ends today
    expect(counts[1]).toBe(2); // two-day and same-day
    expect(counts[2]).toBe(1); // second day of two-day
    expect(counts[3]).toBe(1); // first day of gap show
    expect(counts[4]).toBe(0); // the gap
    expect(counts[5]).toBe(1);
  });

  it('leaves out past shows and shows beyond the timeline', () => {
    const counts = dayCounts(rows, today);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(2 + 2 + 1 + 1 + 1);
  });

  it('picks the shows inside the window', () => {
    const inWindow = rowsInWindow(rows, today, { start: 1, width: 2 }).map((r) => r.i);
    expect(inWindow).toEqual(['two-day', 'same-day']);
    expect(rowsInWindow(rows, today, { start: 4, width: 1 }).map((r) => r.i)).toEqual([]); // the gap day
    expect(rowsInWindow(rows, today, { start: 2, width: 2 }).map((r) => r.i)).toEqual(['two-day', 'gap']);
  });
});

describe('month marks', () => {
  it('labels the start of each month along the timeline', () => {
    const marks = monthMarks(today);
    expect(marks[0]).toEqual({ offset: 0, label: 'Oct' });
    expect(marks[1]).toEqual({ offset: 11, label: 'Nov' });
    expect(marks.some((m) => m.label === 'Jan 2027')).toBe(true);
    expect(marks.length).toBeGreaterThanOrEqual(12);
    expect(marks.every((m) => m.offset < 365)).toBe(true);
  });
});

describe('finding the window in sorted rows (the fast path)', () => {
  it('gives the same answer as checking every row', () => {
    let seed = 11;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const rows = Array.from({ length: 3000 }, (_, k) => {
      const offset = Math.floor(rnd() * 380) - 10;
      const span = rnd() < 0.3 ? Math.floor(rnd() * 4) : 0; // some multi day shows, up to four days
      const d = addDaysISO(today, offset);
      return makeRow({ i: `r${k}`, d, ...(span ? { e: addDaysISO(d, span) } : {}) });
    }).sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    for (const w of [{ start: 0, width: 7 }, { start: 100, width: 1 }, { start: 359, width: 6 }, { start: 30, width: 92 }, { start: 200, width: 14 }]) {
      const { from, to } = windowDates(today, w);
      const naive = rows.filter((r) => rowOverlaps(r, from, to)).map((r) => r.i);
      expect(rowsInWindow(rows, today, w).map((r) => r.i)).toEqual(naive);
    }
  });

  it('still works when the rows are not sorted', () => {
    const rows = [makeRow({ i: 'b', d: '2026-10-25' }), makeRow({ i: 'a', d: '2026-10-22' })];
    expect(rowsInWindow(rows, today, { start: 0, width: 7 }).map((r) => r.i)).toEqual(['b', 'a']);
  });
});
