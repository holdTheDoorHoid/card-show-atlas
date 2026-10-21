import { describe, expect, it } from 'vitest';
import {
  decodeShareLink,
  estimateProfit,
  planSeason,
  planWeekendRun,
  rankForShowGoer,
  rankForVendor,
  PlannerError,
  type PlannerShow,
  type VendorSettings,
} from '../src/index.js';
import { sampleSeason, sampleShopping, sampleShows, sampleVendor, sampleVendorCanada, sampleVendorNoSales, sampleWeekend } from './fixtures.js';
import { allStrings, mk, vendor } from './helpers.js';
import readme from '../README.md?raw';

const sources = import.meta.glob('../src/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** Dashes used as punctuation: em dash, en dash, a hyphen with spaces around it, or a double hyphen. */
const DASH = /[–—]| - |\s--\s|^-\s/m;

function offenders(strings: string[]): string[] {
  return [...new Set(strings.filter((s) => DASH.test(s)))];
}

function errorMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof PlannerError) return e.message;
    throw e;
  }
  return '';
}

describe('writing rules', () => {
  it('no dashes as punctuation in anything the planner returns', () => {
    const shows = sampleShows();
    const out: unknown[] = [];
    out.push(planWeekendRun(shows, sampleVendor(), sampleWeekend()));
    out.push(planWeekendRun(shows, sampleVendorNoSales(), sampleWeekend()));
    out.push(planWeekendRun(shows, sampleVendor(), sampleShopping()));
    out.push(planWeekendRun(shows, sampleVendor(), { ...sampleWeekend(), rates: { CAD_USD: 0.73 }, dates: { start: '2026-11-13', end: '2026-11-16' } }));
    out.push(planSeason(shows, sampleVendor(), sampleSeason()));
    out.push(planSeason(shows, sampleVendorNoSales(), sampleSeason()));
    out.push(planSeason(shows, sampleVendorCanada(), { ...sampleSeason(), rates: { CAD_USD: 0.73 } }));
    out.push(rankForVendor(shows, sampleVendor(), { today: '2026-10-21' }));
    out.push(rankForVendor(shows, sampleVendorNoSales(), { today: '2026-10-21', weights: 'closest' }));
    out.push(rankForShowGoer(shows, { origin: sampleVendor().home!, interests: ['pokemon'], today: '2026-10-21' }));
    for (const s of shows) {
      try {
        out.push(estimateProfit(s, sampleVendor(), { today: '2026-10-21' }));
      } catch (e) {
        out.push((e as Error).message);
      }
    }
    const loss = mk('loss', { days: [['2026-11-14', null, null]], lat: 40.44, lon: -79.99, price: 900, size: 'small' });
    out.push(estimateProfit(loss, vendor({ typical_sales: { small: 50, medium: 100, large: 200, major: 400 } }), { today: '2026-10-21' }));
    out.push(decodeShareLink('nope'), decodeShareLink('abc.def'));
    const strings = allStrings(out);
    expect(strings.length).toBeGreaterThan(500);
    expect(offenders(strings)).toEqual([]);
  });

  it('no dashes as punctuation in error messages', () => {
    const s = sampleVendor();
    const shows = sampleShows();
    const bad: (() => unknown)[] = [
      () => planWeekendRun(shows, s, { mode: 'vending', dates: { start: '2026-11-15', end: '2026-11-14' } }),
      () => planWeekendRun(shows, s, { mode: 'vending', dates: { start: '2026-11-01', end: '2026-11-30' } }),
      () => planWeekendRun(shows, { ...s, home: null }, sampleWeekend()),
      () => planWeekendRun(shows, { ...s, max_drive_hours_per_day: 0 }, sampleWeekend()),
      () => planWeekendRun(shows, { ...s, fuel_price: null }, sampleWeekend()),
      () => planWeekendRun(shows, { ...s, mpg: null, l_per_100km: null }, sampleWeekend()),
      () => planWeekendRun(shows, { ...s, margin_percent: 120 }, sampleWeekend()),
      () => planWeekendRun(shows, { ...s, fuel_price: { amount: 1.5, unit: 'litre', currency: 'CAD' } } as VendorSettings, sampleWeekend()),
      () => planWeekendRun(shows, s, { ...sampleWeekend(), end: { lat: 41, lon: -74 }, overnight: 'home' }),
      () => planWeekendRun(shows, s, { ...sampleWeekend(), rules: { earliestDrive: '5am' } }),
      () => planSeason(shows, s, { ...sampleSeason(), maxShowsPerMonth: -1 }),
      () => planSeason(shows, { ...s, typical_sales: null }, { ...sampleSeason(), objective: 'profit' }),
      () => rankForVendor(shows, s, { weights: { cost: -1 } }),
      () => estimateProfit({ ...shows[0]!, timezone: 'Nowhere/Land' } as PlannerShow, s, { today: '2026-10-21' }),
    ];
    const messages = bad.map(errorMessage);
    expect(messages.every((m) => m.length > 0)).toBe(true);
    expect(offenders(messages)).toEqual([]);
  });

  it('no dashes as punctuation in the README', () => {
    expect(readme.length).toBeGreaterThan(5000);
    const lines = readme.split('\n').filter((l) => DASH.test(l));
    expect(lines).toEqual([]);
  });

  it('no em or en dashes anywhere in the source, and no spaced hyphen inside quoted text', () => {
    const problems: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      if (/[–—]/.test(text)) problems.push(`${file}: em or en dash`);
      const literals = text.match(/'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g) ?? [];
      for (const lit of literals) {
        const plain = lit.replace(/\$\{[^}]*\}/g, '');
        if (/ - |\s--\s/.test(plain)) problems.push(`${file}: ${lit}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
