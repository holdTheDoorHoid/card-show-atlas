import { describe, expect, it } from 'vitest';
import {
  addDays,
  dateFromEpochDay,
  epochDay,
  isValidDate,
  isValidTime,
  isValidTimeZone,
  localDate,
  localTime,
  monthIndex,
  parseTime,
  toZonedIso,
  weekdayOf,
  zoneOffsetMs,
  zonedTimeToInstant,
} from '../src/time.js';
import { PlannerError } from '../src/types.js';
import { rng } from './gen.js';

const H = 3_600_000;

describe('zonedTimeToInstant', () => {
  it('converts plain winter and summer times', () => {
    expect(zonedTimeToInstant('2026-11-14', '09:00', 'America/New_York')).toBe(Date.UTC(2026, 10, 14, 14, 0));
    expect(zonedTimeToInstant('2026-07-04', '09:00', 'America/New_York')).toBe(Date.UTC(2026, 6, 4, 13, 0));
    expect(zonedTimeToInstant('2026-11-14', '09:00', 'America/Chicago')).toBe(Date.UTC(2026, 10, 14, 15, 0));
    expect(zonedTimeToInstant('2026-11-14', '09:00', 'America/Los_Angeles')).toBe(Date.UTC(2026, 10, 14, 17, 0));
    expect(zonedTimeToInstant('2026-11-14', '09:00', 'America/Halifax')).toBe(Date.UTC(2026, 10, 14, 13, 0));
  });

  it('handles half hour zones and zones without daylight saving', () => {
    expect(zonedTimeToInstant('2026-11-14', '09:00', 'America/St_Johns')).toBe(Date.UTC(2026, 10, 14, 12, 30));
    expect(zonedTimeToInstant('2026-07-14', '09:00', 'America/St_Johns')).toBe(Date.UTC(2026, 6, 14, 11, 30));
    // Saskatchewan stays on CST all year; Arizona on MST.
    expect(zonedTimeToInstant('2026-07-14', '09:00', 'America/Regina')).toBe(Date.UTC(2026, 6, 14, 15, 0));
    expect(zonedTimeToInstant('2026-01-14', '09:00', 'America/Regina')).toBe(Date.UTC(2026, 0, 14, 15, 0));
    expect(zonedTimeToInstant('2026-07-14', '09:00', 'America/Phoenix')).toBe(Date.UTC(2026, 6, 14, 16, 0));
  });

  it('is an hour apart across the Central and Eastern boundary for the same wall time', () => {
    const chicago = zonedTimeToInstant('2026-11-14', '10:00', 'America/Chicago');
    const indy = zonedTimeToInstant('2026-11-14', '10:00', 'America/Indiana/Indianapolis');
    expect(chicago - indy).toBe(H);
  });

  it('fall back: a repeated time resolves to the earlier one unless asked otherwise', () => {
    // 2026-11-01 01:30 happens twice in New York.
    expect(zonedTimeToInstant('2026-11-01', '01:30', 'America/New_York')).toBe(Date.UTC(2026, 10, 1, 5, 30));
    expect(zonedTimeToInstant('2026-11-01', '01:30', 'America/New_York', 'earlier')).toBe(Date.UTC(2026, 10, 1, 5, 30));
    expect(zonedTimeToInstant('2026-11-01', '01:30', 'America/New_York', 'later')).toBe(Date.UTC(2026, 10, 1, 6, 30));
  });

  it('spring forward: a skipped time is pushed forward by the gap', () => {
    // 2027-03-14 02:30 does not exist in New York.
    expect(zonedTimeToInstant('2027-03-14', '02:30', 'America/New_York')).toBe(Date.UTC(2027, 2, 14, 7, 30));
    expect(toZonedIso(zonedTimeToInstant('2027-03-14', '02:30', 'America/New_York'), 'America/New_York')).toBe('2027-03-14T03:30:00-04:00');
    expect(zonedTimeToInstant('2027-03-14', '02:30', 'America/New_York', 'earlier')).toBe(Date.UTC(2027, 2, 14, 6, 30));
  });

  it('measures the long and short days of a daylight saving change', () => {
    const fallDay = zonedTimeToInstant('2026-11-02', '00:00', 'America/New_York') - zonedTimeToInstant('2026-11-01', '00:00', 'America/New_York');
    const springDay = zonedTimeToInstant('2027-03-15', '00:00', 'America/New_York') - zonedTimeToInstant('2027-03-14', '00:00', 'America/New_York');
    expect(fallDay).toBe(25 * H);
    expect(springDay).toBe(23 * H);
    // Same day in Regina is always 24 hours.
    expect(zonedTimeToInstant('2026-11-02', '00:00', 'America/Regina') - zonedTimeToInstant('2026-11-01', '00:00', 'America/Regina')).toBe(24 * H);
    // Times after the change on the change day use the new offset.
    expect(zonedTimeToInstant('2026-11-01', '07:30', 'America/New_York')).toBe(Date.UTC(2026, 10, 1, 12, 30));
    expect(zonedTimeToInstant('2027-03-14', '07:30', 'America/New_York')).toBe(Date.UTC(2027, 2, 14, 11, 30));
  });

  it('accepts 24:00 as the end of the day', () => {
    expect(zonedTimeToInstant('2026-11-14', '24:00', 'America/New_York')).toBe(zonedTimeToInstant('2026-11-15', '00:00', 'America/New_York'));
  });

  it('round trips random instants in many zones', () => {
    const zones = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'America/Halifax', 'America/St_Johns', 'America/Regina', 'America/Toronto', 'America/Vancouver', 'Europe/London', 'Australia/Lord_Howe', 'Pacific/Kiritimati'];
    const r = rng(5);
    for (let i = 0; i < 2000; i++) {
      const zone = zones[Math.floor(r() * zones.length)]!;
      const t = Math.floor((Date.UTC(2026, 0, 1) + r() * 2 * 365 * 24 * H) / 60_000) * 60_000;
      const d = localDate(t, zone);
      const tm = localTime(t, zone);
      const back = zonedTimeToInstant(d, tm, zone);
      // A repeated wall time maps to the earlier instant; otherwise it is exact.
      if (back !== t) {
        expect(back).toBeLessThan(t);
        expect(zonedTimeToInstant(d, tm, zone, 'later')).toBe(t);
      }
    }
  });

  it('reports offsets and ISO strings with the offset', () => {
    expect(zoneOffsetMs(Date.UTC(2026, 10, 14, 12), 'America/New_York')).toBe(-5 * H);
    expect(zoneOffsetMs(Date.UTC(2026, 6, 14, 12), 'America/New_York')).toBe(-4 * H);
    expect(toZonedIso(Date.UTC(2026, 10, 14, 12, 30), 'America/New_York')).toBe('2026-11-14T07:30:00-05:00');
    expect(toZonedIso(Date.UTC(2026, 10, 14, 12, 30), 'America/St_Johns')).toBe('2026-11-14T09:00:00-03:30');
  });

  it('rejects bad input with plain errors', () => {
    expect(() => zonedTimeToInstant('2026-02-30', '09:00', 'America/New_York')).toThrow(PlannerError);
    expect(() => zonedTimeToInstant('2026-11-14', '9 am', 'America/New_York')).toThrow(/not a time/);
    expect(() => zonedTimeToInstant('2026-11-14', '09:00', 'Mars/Olympus')).toThrow(/Unknown time zone/);
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('Nope/Nope')).toBe(false);
  });
});

describe('calendar helpers', () => {
  it('validates dates and times', () => {
    expect(isValidDate('2028-02-29')).toBe(true);
    expect(isValidDate('2026-02-29')).toBe(false);
    expect(isValidDate('2026-13-01')).toBe(false);
    expect(isValidDate('2026-1-01')).toBe(false);
    expect(isValidTime('00:00')).toBe(true);
    expect(isValidTime('24:00')).toBe(true);
    expect(isValidTime('24:30')).toBe(false);
    expect(isValidTime('7:05')).toBe(true);
    expect(parseTime('7:05')).toBe(425);
  });

  it('counts days, weekdays and months', () => {
    expect(epochDay('1970-01-01')).toBe(0);
    expect(dateFromEpochDay(epochDay('2026-11-14'))).toBe('2026-11-14');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(weekdayOf('2026-11-14')).toBe(6);
    expect(weekdayOf('2026-11-15')).toBe(0);
    expect(monthIndex('2027-01-09') - monthIndex('2026-12-31')).toBe(1);
  });
});
