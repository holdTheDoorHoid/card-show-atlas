import { describe, expect, it } from 'vitest';
import { DEFAULT_VENDOR_SETTINGS, fuelCostPerMile, missingForProfit, normalizeSettings } from './settings.ts';

describe('vendor settings', () => {
  it('starts with sensible empty defaults', () => {
    const s = normalizeSettings(undefined);
    expect(s).toEqual(DEFAULT_VENDOR_SETTINGS);
    expect(s.maxDrivingHoursPerDay).toBe(8);
    expect(s.home).toEqual({ postal: '', lat: null, lon: null, country: null });
  });

  it('has exactly the fields the planner needs', () => {
    expect(Object.keys(DEFAULT_VENDOR_SETTINGS).sort()).toEqual([
      'currency',
      'foodPerDay',
      'fuelEconomy',
      'fuelEconomyUnit',
      'fuelPrice',
      'home',
      'hotelPerNight',
      'marginPercent',
      'maxDrivingHoursPerDay',
      'sells',
      'typicalSales',
      'version',
    ]);
    expect(Object.keys(DEFAULT_VENDOR_SETTINGS.typicalSales).sort()).toEqual(['large', 'major', 'medium', 'small']);
  });

  it('keeps the currency to the two the data uses', () => {
    expect(normalizeSettings({ currency: 'CAD' }).currency).toBe('CAD');
    expect(normalizeSettings({ currency: 'EUR' }).currency).toBe('USD');
    expect(normalizeSettings({}).currency).toBe('USD');
  });

  it('accepts numbers typed as text and rejects nonsense', () => {
    const s = normalizeSettings({ fuelEconomy: '22.5', hotelPerNight: 'abc', foodPerDay: -3, marginPercent: 140, maxDrivingHoursPerDay: 0, sells: ['pokemon', 5, ''] });
    expect(s.fuelEconomy).toBe(22.5);
    expect(s.hotelPerNight).toBeNull();
    expect(s.foodPerDay).toBeNull();
    expect(s.marginPercent).toBe(100);
    expect(s.maxDrivingHoursPerDay).toBe(1);
    expect(s.sells).toEqual(['pokemon']);
  });

  it('works out fuel cost per mile for mpg and for litres per 100 km', () => {
    const us = normalizeSettings({ fuelEconomyUnit: 'mpg', fuelEconomy: 20, fuelPrice: 3.6 });
    expect(fuelCostPerMile(us)).toBeCloseTo(0.18, 6);
    const ca = normalizeSettings({ fuelEconomyUnit: 'l_per_100km', fuelEconomy: 10, fuelPrice: 1.7 });
    expect(fuelCostPerMile(ca)).toBeCloseTo(0.1 * 1.609344 * 1.7, 6);
    expect(fuelCostPerMile(DEFAULT_VENDOR_SETTINGS)).toBeNull();
  });

  it('says what is still missing before a profit estimate', () => {
    expect(missingForProfit(DEFAULT_VENDOR_SETTINGS)).toEqual(['your home postal code', 'your fuel economy', 'the fuel price', 'your margin on sales', 'typical sales at a show']);
    const ready = normalizeSettings({ home: { postal: '08837', lat: 40.5, lon: -74.4, country: 'US' }, fuelEconomy: 18, fuelPrice: 3.4, marginPercent: 40, typicalSales: { small: 500 } });
    expect(missingForProfit(ready)).toEqual([]);
  });
});
