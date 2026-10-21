import { describe, expect, it } from 'vitest';
import {
  addDays,
  daysBetween,
  formatHours,
  formatRange,
  formatRowDate,
  formatTime,
  isISODate,
  rangeForChip,
  thisWeekend,
  timeZoneAbbreviation,
  todayISO,
  weekday,
} from './dates.ts';

describe('date math', () => {
  it('adds days across month, year and leap day edges', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('counts whole days, not hours, through a daylight saving change', () => {
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2);
    expect(daysBetween('2026-11-01', '2026-10-30')).toBe(-2);
  });

  it('rejects things that are not dates', () => {
    expect(isISODate('2026-02-30')).toBe(false);
    expect(isISODate('2026-2-3')).toBe(false);
    expect(isISODate(20261021)).toBe(false);
    expect(isISODate('2026-10-21')).toBe(true);
  });

  it('knows the weekday', () => {
    expect(weekday('2026-10-21')).toBe(3); // Wednesday
    expect(weekday('2026-11-14')).toBe(6); // Saturday
    expect(weekday('1970-01-01')).toBe(4); // Thursday
  });

  it('reads today from the local clock', () => {
    expect(todayISO(new Date(2026, 9, 21, 23, 59))).toBe('2026-10-21');
    expect(todayISO(new Date(2027, 0, 1, 0, 1))).toBe('2027-01-01');
  });
});

describe('chips', () => {
  it('this weekend is Friday through Sunday', () => {
    expect(thisWeekend('2026-10-21')).toEqual({ from: '2026-10-23', to: '2026-10-25' }); // from a Wednesday
    expect(thisWeekend('2026-10-23')).toEqual({ from: '2026-10-23', to: '2026-10-25' }); // Friday
  });

  it('this weekend shrinks to what is left on Saturday and Sunday', () => {
    expect(thisWeekend('2026-10-24')).toEqual({ from: '2026-10-24', to: '2026-10-25' });
    expect(thisWeekend('2026-10-25')).toEqual({ from: '2026-10-25', to: '2026-10-25' });
  });

  it('builds the other ranges from today', () => {
    expect(rangeForChip('2weeks', '2026-10-21')).toEqual({ from: '2026-10-21', to: '2026-11-04' });
    expect(rangeForChip('30days', '2026-10-21')).toEqual({ from: '2026-10-21', to: '2026-11-20' });
  });

  it('keeps a picked range in order', () => {
    expect(rangeForChip('pick', '2026-10-21', { from: '2026-12-01', to: '2026-11-01' })).toEqual({ from: '2026-12-01', to: '2026-12-01' });
    expect(rangeForChip('pick', '2026-10-21', {})).toEqual({ from: '2026-10-21', to: '2026-11-20' });
  });
});

describe('formatting', () => {
  it('writes ranges without dashes', () => {
    expect(formatRange('2026-11-14')).toBe('Nov 14');
    expect(formatRange('2026-11-14', '2026-11-15')).toBe('Nov 14 to 15');
    expect(formatRange('2026-11-30', '2026-12-01')).toBe('Nov 30 to Dec 1');
    expect(formatRange('2026-12-30', '2027-01-02')).toBe('Dec 30, 2026 to Jan 2, 2027');
    expect(formatRowDate('2026-11-14')).toBe('Sat, Nov 14');
  });

  it('writes times', () => {
    expect(formatTime('09:00')).toBe('9 am');
    expect(formatTime('13:30')).toBe('1:30 pm');
    expect(formatTime('00:00')).toBe('12 am');
    expect(formatTime('12:00')).toBe('12 pm');
    expect(formatHours('09:00', '15:00')).toBe('9 am to 3 pm');
    expect(formatHours('09:00', null)).toBe('opens 9 am');
    expect(formatHours(null, null)).toBe('');
  });

  it('gives the time zone name for the date', () => {
    expect(timeZoneAbbreviation('America/New_York', '2026-11-14')).toMatch(/E[SD]T/);
    expect(timeZoneAbbreviation('America/New_York', '2026-07-14')).toBe('EDT');
    expect(timeZoneAbbreviation(null, '2026-07-14')).toBe('');
    expect(timeZoneAbbreviation('Not/AZone', '2026-07-14')).toBe('');
  });
});

describe('years in dates', () => {
  it('adds the year only when it is not the current one', () => {
    expect(formatRowDate('2027-01-10', '2027-01-10', 2026)).toBe('Sun, Jan 10, 2027');
    expect(formatRowDate('2026-11-14', '2026-11-14', 2026)).toBe('Sat, Nov 14');
    expect(formatRowDate('2027-01-09', '2027-01-10', 2026)).toBe('Jan 9 to 10, 2027');
    expect(formatRange('2027-01-30', '2027-02-01', 2026)).toBe('Jan 30 to Feb 1, 2027');
    expect(formatRange('2026-12-30', '2027-01-02', 2026)).toBe('Dec 30, 2026 to Jan 2, 2027');
    expect(formatRange('2026-11-14', '2026-11-15')).toBe('Nov 14 to 15');
  });
});
