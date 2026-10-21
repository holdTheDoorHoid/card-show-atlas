import { describe, expect, it } from 'vitest';
import { buildCalendar, escapeText, fileNameFor, foldLine, showIcs, zonedToUtcMs } from './ics.ts';
import { makeShow } from './testing.ts';

const now = new Date('2026-10-21T12:00:00Z');

function lines(ics: string): string[] {
  return ics.split('\r\n');
}

/** Undo folding, as a calendar app does. */
function unfold(ics: string): string[] {
  return ics.replace(/\r\n[ \t]/g, '').split('\r\n').filter(Boolean);
}

describe('escaping and folding', () => {
  it('escapes the characters that matter', () => {
    expect(escapeText('a, b; c\\d\ne')).toBe('a\\, b\; c\\\\d\\ne');
  });

  it('folds long lines at 75 octets and never splits a character', () => {
    const long = `SUMMARY:${'Pokémon '.repeat(30)}`;
    const folded = foldLine(long);
    const parts = folded.split('\r\n');
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(75);
    for (const p of parts.slice(1)) expect(p.startsWith(' ')).toBe(true);
    expect(parts.join('').replace(/ /g, '')).toBe(long.replace(/ /g, ''));
    expect(unfoldOne(folded)).toBe(long);
  });
});

function unfoldOne(s: string) {
  return s.replace(/\r\n[ \t]/g, '');
}

describe('time zones', () => {
  it('converts wall clock time to UTC, including daylight saving', () => {
    // 9 am EST (UTC-5) on Nov 14 2026, 9 am EDT (UTC-4) on Jul 14 2026
    expect(new Date(zonedToUtcMs('2026-11-14', '09:00', 'America/New_York') as number).toISOString()).toBe('2026-11-14T14:00:00.000Z');
    expect(new Date(zonedToUtcMs('2026-07-14', '09:00', 'America/New_York') as number).toISOString()).toBe('2026-07-14T13:00:00.000Z');
    expect(new Date(zonedToUtcMs('2026-11-14', '09:00', 'America/Los_Angeles') as number).toISOString()).toBe('2026-11-14T17:00:00.000Z');
    expect(new Date(zonedToUtcMs('2026-11-14', '09:00', 'America/St_Johns') as number).toISOString()).toBe('2026-11-14T12:30:00.000Z');
  });

  it('handles the day daylight saving ends', () => {
    // Nov 1 2026: clocks go back at 2 am. 9 am is EST (UTC-5).
    expect(new Date(zonedToUtcMs('2026-11-01', '09:00', 'America/New_York') as number).toISOString()).toBe('2026-11-01T14:00:00.000Z');
    expect(new Date(zonedToUtcMs('2026-03-08', '09:00', 'America/New_York') as number).toISOString()).toBe('2026-03-08T13:00:00.000Z');
  });

  it('returns null for an unknown zone', () => {
    expect(zonedToUtcMs('2026-11-14', '09:00', 'Nowhere/Land')).toBeNull();
  });
});

describe('a show as a calendar file', () => {
  const show = makeShow();
  const ics = showIcs(show, 'https://holdthedoorhoid.github.io/card-show-atlas/shows/x/', now);
  const text = unfold(ics);

  it('is a valid calendar envelope with CRLF line endings', () => {
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.includes('\n') && !/[^\r]\n/.test(ics)).toBe(true);
    expect(text).toContain('VERSION:2.0');
    expect(text.some((l) => l.startsWith('PRODID:'))).toBe(true);
  });

  it('keeps every line within 75 octets', () => {
    for (const l of lines(ics)) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
  });

  it('writes one event per day with real opening times, in UTC', () => {
    expect(text.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(2);
    expect(text).toContain('DTSTART:20261114T140000Z'); // 9 am EST
    expect(text).toContain('DTEND:20261114T200000Z'); // 3 pm EST
    expect(text).toContain('DTSTART:20261115T150000Z'); // 10 am EST
    expect(text).toContain('UID:sample-edison-card-show-edison-nj-2026-11-14-2026-11-14@card-show-atlas');
    expect(text).toContain('DTSTAMP:20261021T120000Z');
  });

  it('carries the name, place, link and status', () => {
    expect(text).toContain('SUMMARY:Sample Edison Card Show');
    expect(text.some((l) => l.startsWith('LOCATION:Sample Expo Hall\\, 97 Sunfield Ave\\, Edison\\, NJ'))).toBe(true);
    expect(text).toContain('URL:https://holdthedoorhoid.github.io/card-show-atlas/shows/x/');
    expect(text).toContain('STATUS:CONFIRMED');
  });

  it('falls back to one all day event when opening times are not known', () => {
    const noHours = makeShow({ days: [{ date: '2026-11-14', open: null, close: null }, { date: '2026-11-15', open: null, close: null }] });
    const t = unfold(showIcs(noHours, null, now));
    expect(t.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(1);
    expect(t).toContain('DTSTART;VALUE=DATE:20261114');
    expect(t).toContain('DTEND;VALUE=DATE:20261116'); // the end date is the day after the last day
  });

  it('marks cancelled, postponed and tentative shows', () => {
    expect(unfold(showIcs(makeShow({ status: 'cancelled' }), null, now))).toContain('STATUS:CANCELLED');
    expect(unfold(showIcs(makeShow({ status: 'tentative' }), null, now))).toContain('STATUS:TENTATIVE');
    expect(unfold(showIcs(makeShow({ status: 'postponed' }), null, now)).some((l) => l.includes('(postponed)'))).toBe(true);
  });

  it('escapes commas and semicolons in names', () => {
    const t = unfold(showIcs(makeShow({ name: 'Sample Cards, Comics; More' }), null, now));
    expect(t).toContain('SUMMARY:Sample Cards\\, Comics\; More');
  });
});

describe('reminders', () => {
  it('adds an all day event with alarms 7 days and 1 day before', () => {
    const ics = buildCalendar({
      name: 'Test',
      now,
      reminders: [{ uid: 'x-apply', date: '2026-11-03', summary: 'Apply by: Sample Show', description: null, url: null, daysBefore: [1, 7] }],
    });
    const t = unfold(ics);
    expect(t).toContain('DTSTART;VALUE=DATE:20261103');
    expect(t).toContain('DTEND;VALUE=DATE:20261104');
    expect(t.filter((l) => l === 'BEGIN:VALARM')).toHaveLength(2);
    expect(t).toContain('TRIGGER:-P7D');
    expect(t).toContain('TRIGGER:-P1D');
    expect(t.filter((l) => l === 'ACTION:DISPLAY')).toHaveLength(2);
  });
});

describe('file names', () => {
  it('makes safe names', () => {
    expect(fileNameFor('Sample Edison Card Show!', 'ics')).toBe('sample-edison-card-show.ics');
    expect(fileNameFor('???', 'ics')).toBe('card-show.ics');
    expect(fileNameFor('Pokémon/Magic Day', 'json')).toBe('pokemon-magic-day.json');
  });
});
