import { describe, expect, it } from 'vitest';
import { convert, estimateProfit, estimateSales, fuelCostPerMile, MoneyBag, rateFor } from '../src/index.js';
import { addShowCosts, CostSheet, showFixedCost } from '../src/profit.js';
import { estimateLeg } from '../src/travel.js';
import { sampleShows, sampleVendor, sampleVendorCanada } from './fixtures.js';
import { genShows, genVendor, rng } from './gen.js';
import { mk, PHILLY, vendor } from './helpers.js';

const ALLENTOWN = { lat: 40.6084, lon: -75.4902 };

describe('money', () => {
  it('uses only rates the user gave, in either direction', () => {
    expect(rateFor('USD', 'USD')).toBe(1);
    expect(rateFor('CAD', 'USD')).toBeNull();
    expect(rateFor('CAD', 'USD', { CAD_USD: 0.73 })).toBe(0.73);
    expect(rateFor('USD', 'CAD', { CAD_USD: 0.8 })).toBeCloseTo(1.25, 12);
    expect(rateFor('CAD', 'USD', { CAD_USD: -1 })).toBeNull();
    expect(convert(150, 'CAD', 'USD', { CAD_USD: 0.73 })!.note).toBe('Converted 150 CAD to 110 USD at 0.73, the rate you entered.');
    expect(convert(150, 'CAD', 'USD')).toBeNull();
  });

  it('keeps sums apart by currency', () => {
    const bag = new MoneyBag().add(10, 'USD').add(5, 'CAD').add(2, 'USD');
    expect(bag.toObject()).toEqual({ CAD: 5, USD: 12 });
  });
});

describe('sales estimate', () => {
  const s = vendor({ typical_sales: { small: 500, medium: 1000, large: 2000, major: 4000 } });

  it('starts from typical sales for the size class', () => {
    const e = estimateSales(mk('m', { days: [['2026-11-14', '09:00', '15:00']], ...ALLENTOWN, size: 'medium', tpt: 6 }), s)!;
    expect(e.mid).toBeCloseTo(1000, 9);
    expect(e.sizeClass).toBe('medium');
    expect(e.explain[0]).toBe('Your typical sales at a medium show: 1,000 USD.');
  });

  it('adjusts for traffic per table, within bounds', () => {
    const busy = estimateSales(mk('b', { days: [['2026-11-14', '09:00', '15:00']], ...ALLENTOWN, tpt: 24 }), s)!;
    expect(busy.trafficFactor).toBeCloseTo(1.5, 9);
    const quiet = estimateSales(mk('q', { days: [['2026-11-14', '09:00', '15:00']], ...ALLENTOWN, tpt: 1.5 }), s)!;
    expect(quiet.trafficFactor).toBeCloseTo(0.6, 9);
    const mild = estimateSales(mk('mi', { days: [['2026-11-14', '09:00', '15:00']], ...ALLENTOWN, tpt: 8 }), s)!;
    expect(mild.trafficFactor).toBeCloseTo(Math.sqrt(8 / 6), 9);
  });

  it('blends in the vendor history at the series, more with more shows', () => {
    const show = mk('h', { days: [['2026-11-14', '09:00', '15:00']], ...ALLENTOWN, series: 'series-x' });
    const one = estimateSales(show, { ...s, history: { 'series-x': { gross_sales: [2000] } } })!;
    expect(one.historyWeight).toBeCloseTo(0.5, 12);
    expect(one.mid).toBeCloseTo(1500, 9);
    const three = estimateSales(show, { ...s, history: { 'series-x': { gross_sales: [2000, 2000, 2000] } } })!;
    expect(three.historyWeight).toBeCloseTo(0.75, 12);
    expect(three.mid).toBeCloseTo(1750, 9);
  });

  it('cuts sales when little of what the vendor sells is there', () => {
    const show = mk('sports', { days: [['2026-11-14', '09:00', '15:00']], ...ALLENTOWN, sells: ['baseball'] });
    const e = estimateSales(show, s)!;
    expect(e.matchFactor).toBeCloseTo(0.5, 12);
    expect(e.mid).toBeCloseTo(500, 9);
    expect(e.explain.join(' ')).toMatch(/sales are cut 50 percent/);
    const off = estimateSales(show, s, { matchFloor: 1 })!;
    expect(off.mid).toBeCloseTo(1000, 9);
    const unknown = estimateSales({ ...show, sells: [] }, s)!;
    expect(unknown.matchFactor).toBe(1);
  });

  it('reads the range from the attendance range', () => {
    const e = estimateSales(mk('r', { days: [['2026-11-14', '09:00', '15:00']], ...ALLENTOWN, mid: 1000 }), s)!;
    expect(e.low).toBeCloseTo(1000 * 0.6 ** 0.7, 9);
    expect(e.high).toBeCloseTo(1000 * 1.5 ** 0.7, 9);
    expect(e.rangeFrom).toBe('attendance');
    const rough = estimateSales({ ...mk('x', { days: [['2026-11-14', '09:00', '15:00']], ...ALLENTOWN }), estimate: null, size: { tables: 50 } }, s)!;
    expect(rough.rangeFrom).toBe('rough');
    expect(rough.low).toBeCloseTo(600, 9);
    expect(rough.high).toBeCloseTo(1400, 9);
  });

  it('returns null without typical sales', () => {
    expect(estimateSales(mk('n', { days: [['2026-11-14', '09:00', '15:00']], ...ALLENTOWN }), { ...s, typical_sales: null })).toBeNull();
  });
});

describe('fuel', () => {
  it('works in miles per gallon and in litres per 100 km', () => {
    const us = fuelCostPerMile(vendor({ mpg: 25, fuel_price: { amount: 3.5, unit: 'gallon' } }));
    expect(us.perMile).toBeCloseTo(0.14, 12);
    expect(us.describe).toBe('25 mpg, 3.50 USD a gallon');
    const ca = fuelCostPerMile(sampleVendorCanada());
    // 9.5 L/100 km is 0.15289 L a mile, at 1.55 CAD a litre.
    expect(ca.perMile).toBeCloseTo((9.5 / 100) * 1.609344 * 1.55, 12);
    const mixed = fuelCostPerMile(vendor({ mpg: 25, fuel_price: { amount: 1, unit: 'litre' } }));
    expect(mixed.perMile).toBeCloseTo(3.785411784 / 25, 12);
  });

  it('never mixes currencies without a rate', () => {
    const s = vendor({ fuel_price: { amount: 1.6, unit: 'litre', currency: 'CAD' }, mpg: 25 });
    expect(() => fuelCostPerMile(s)).toThrow(/Fuel price is in CAD and your other amounts are in USD/);
    expect(fuelCostPerMile(s, { CAD_USD: 0.75 }).perMile).toBeCloseTo((1.6 * 3.785411784 * 0.75) / 25, 12);
  });
});

describe('profit estimate for one show', () => {
  it('itemizes every cost and the range, from the sample settings', () => {
    const show = sampleShows().find((x) => x.id === 'delaware-valley-tcg-fest-cherry-hill-nj-2026-11-15')!;
    const s = sampleVendor();
    const e = estimateProfit(show, s, { today: '2026-10-21' });
    const kinds = e.costs.map((c) => c.kind);
    expect(kinds).toEqual(['table', 'extras', 'fuel', 'food']);
    expect(e.costs[0]!.amount).toBe(95);
    const leg = estimateLeg(s.home!, show);
    expect(e.costs[2]!.amount).toBeCloseTo((2 * leg.miles * 3.4) / 22, 9);
    expect(e.costs[3]!.amount).toBe(45);
    expect(e.totalCost).toBeCloseTo(e.costs.reduce((a, c) => a + c.amount, 0), 9);
    expect(e.contribution!.mid).toBeCloseTo(e.sales!.mid * 0.4, 9);
    expect(e.profit!.mid).toBeCloseTo(e.contribution!.mid - e.totalCost!, 9);
    expect(e.profit!.low).toBeLessThan(e.profit!.mid);
    expect(e.profit!.high).toBeGreaterThan(e.profit!.mid);
    expect(e.label).toMatch(/^Expected profit about [\d,]+ USD \([\d,]+ to [\d,]+\)$/);
    expect(e.notes[0]).toBe('This is an estimate with a range, not a promise.');
  });

  it('adds hotel nights when the show is too far for a same day trip', () => {
    const show = mk('pgh', { days: [['2026-11-14', '10:00', '16:00']], lat: 40.4406, lon: -79.9959 });
    const e = estimateProfit(show, vendor({ max_drive_hours_per_day: 7 }), { today: '2026-10-21' });
    const hotel = e.costs.find((c) => c.kind === 'hotel')!;
    expect(hotel.amount).toBe(120);
    expect(hotel.detail).toBe('1 night at 120 USD');
  });

  it('keeps currencies apart without a rate, and converts with one', () => {
    const show = sampleShows().find((x) => x.id.startsWith('great-lakes'))!;
    const s = sampleVendor();
    s.max_drive_hours_per_day = 9;
    const split = estimateProfit(show, s, { today: '2026-10-21' });
    expect(split.profit).toBeNull();
    expect(split.totalCost).toBeNull();
    expect(Object.keys(split.costsByCurrency).sort()).toEqual(['CAD', 'USD']);
    expect(split.costsByCurrency.CAD).toBe(175);
    expect(split.notes.join(' ')).toMatch(/Some costs are in CAD\. Enter an exchange rate to see one total\./);
    expect(split.label).toBe('Costs are in more than one currency');
    const one = estimateProfit(show, s, { today: '2026-10-21', rates: { USD_CAD: 1 / 0.73 } });
    expect(one.profit).not.toBeNull();
    const table = one.costs.find((c) => c.kind === 'table')!;
    expect(table.currency).toBe('USD');
    expect(table.original).toEqual({ amount: 175, currency: 'CAD' });
    expect(one.conversions[0]).toMatch(/^Converted 175 CAD to 128 USD at 0\.73, the rate you entered\.$/);
  });

  it('marks an assumed table price', () => {
    const show = { ...mk('np', { days: [['2026-11-14', '09:00', '15:00']], ...ALLENTOWN, price: null }) };
    const e = estimateProfit(show, vendor(), { today: '2026-10-21' });
    const t = e.costs.find((c) => c.kind === 'table')!;
    expect(t.assumed).toBe(true);
    expect(t.detail).toBe('Price not listed, assumed 100 USD');
  });

  it('labels losses in words, not with a minus sign', () => {
    const show = mk('tiny', { days: [['2026-11-14', '09:00', '15:00']], lat: 40.4406, lon: -79.9959, size: 'small', price: 400 });
    const e = estimateProfit(show, vendor({ typical_sales: { small: 100, medium: 200, large: 300, major: 400 } }), { today: '2026-10-21' });
    expect(e.label).toMatch(/^Expected loss about [\d,]+ USD \(a loss of [\d,]+ to [\d,]+\)$/);
  });

  it('agrees with the cost sheet for the fixed costs on random shows', () => {
    const r = rng(11);
    const shows = genShows(r, { n: 300, start: '2026-11-01', spanDays: 30, center: PHILLY, spreadDeg: 2 });
    for (const show of shows) {
      const s = genVendor(r, PHILLY);
      const sheet = new CostSheet('USD', null);
      addShowCosts(sheet, show, s);
      expect(showFixedCost(show, s, null)).toBeCloseTo(sheet.total()!, 9);
    }
  });
});
