import { describe, expect, it } from 'vitest';
import { countryNear, DEFAULT_FIND_PREFS, radiusFromSlider, sanitizeLocation, sanitizePrefs, sliderRange, sliderValue } from './findprefs.ts';
import { makeRow } from './testing.ts';

describe('saved place', () => {
  it('keeps a good place and drops a bad one', () => {
    expect(sanitizeLocation({ label: '08837', lat: 40.5, lon: -74.4, country: 'US', source: 'postal' })).toEqual({ label: '08837', lat: 40.5, lon: -74.4, country: 'US', source: 'postal' });
    expect(sanitizeLocation({ lat: 99, lon: 0 })).toBeNull();
    expect(sanitizeLocation({ lat: '40', lon: 0 })).toBeNull();
    expect(sanitizeLocation(null)).toBeNull();
    expect(sanitizeLocation({ lat: 45, lon: -75, country: 'CA' })?.country).toBe('CA');
  });
});

describe('saved preferences', () => {
  it('falls back to the defaults and clamps the distance', () => {
    expect(sanitizePrefs(null)).toEqual(DEFAULT_FIND_PREFS);
    expect(sanitizePrefs({ radiusMi: 5 }).radiusMi).toBe(10);
    expect(sanitizePrefs({ radiusMi: 9000 }).radiusMi).toBe(500);
    expect(sanitizePrefs({ chip: 'bogus', sort: 'bogus', unit: 'furlongs' })).toMatchObject({ chip: '30days', sort: 'date', unit: null });
    expect(sanitizePrefs({ chip: 'pick', pickFrom: '2026-11-01', pickTo: 'tomorrow' })).toMatchObject({ chip: 'pick', pickFrom: '2026-11-01', pickTo: null });
  });
});

describe('the distance slider', () => {
  it('runs from 10 to 500 miles, or 10 to 800 km', () => {
    expect(sliderRange('mi')).toEqual({ min: 10, max: 500, step: 10 });
    expect(sliderRange('km')).toEqual({ min: 10, max: 800, step: 10 });
  });

  it('converts between the radius in miles and what the slider shows', () => {
    expect(sliderValue(100, 'mi')).toBe(100);
    expect(sliderValue(100, 'km')).toBe(160);
    expect(sliderValue(500, 'km')).toBe(800);
    expect(radiusFromSlider(160, 'km')).toBeCloseTo(99.4, 1);
    expect(radiusFromSlider(100, 'mi')).toBe(100);
    expect(radiusFromSlider(800, 'km')).toBeLessThanOrEqual(500);
  });
});

describe('which country a point is in', () => {
  const rows = [makeRow({ i: 'a', k: 'CA', ll: [43.65, -79.38] }), makeRow({ i: 'b', k: 'US', ll: [42.89, -78.88] })];
  it('uses the nearest show when one is close', () => {
    expect(countryNear(rows, 43.7, -79.4)).toBe('CA'); // near Toronto
    expect(countryNear(rows, 42.9, -78.9)).toBe('US'); // near Buffalo
  });
  it('falls back to a rough rule when no show is near', () => {
    expect(countryNear([], 53.5, -113.5)).toBe('CA');
    expect(countryNear([], 35, -100)).toBe('US');
  });
});
