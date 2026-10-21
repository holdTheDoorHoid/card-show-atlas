import { describe, expect, it } from 'vitest';
import { averageSpeedMph, driveMinutes, formatDistance, guessCountry, haversineMiles, kmToMiles, milesToKm, unitForCountry } from './geo.ts';
import { formatDriveTime } from './format.ts';

describe('haversineMiles', () => {
  it('is zero for the same point', () => {
    expect(haversineMiles({ lat: 40, lon: -75 }, { lat: 40, lon: -75 })).toBe(0);
  });

  it('knows New York to Philadelphia (about 80 miles)', () => {
    const d = haversineMiles({ lat: 40.7128, lon: -74.006 }, { lat: 39.9526, lon: -75.1652 });
    expect(d).toBeGreaterThan(77);
    expect(d).toBeLessThan(83);
  });

  it('knows Los Angeles to New York (about 2,450 miles)', () => {
    const d = haversineMiles(34.0522, -118.2437, 40.7128, -74.006);
    expect(d).toBeGreaterThan(2430);
    expect(d).toBeLessThan(2470);
  });

  it('is symmetric and handles the date line', () => {
    const a = { lat: 10, lon: 179.5 };
    const b = { lat: 10, lon: -179.5 };
    expect(haversineMiles(a, b)).toBeCloseTo(haversineMiles(b, a), 9);
    expect(haversineMiles(a, b)).toBeLessThan(70);
  });
});

describe('units', () => {
  it('converts between miles and kilometres', () => {
    expect(milesToKm(100)).toBeCloseTo(160.9344, 4);
    expect(kmToMiles(milesToKm(37))).toBeCloseTo(37, 9);
  });

  it('uses km only in Canada', () => {
    expect(unitForCountry('CA')).toBe('km');
    expect(unitForCountry('US')).toBe('mi');
    expect(unitForCountry(null)).toBe('mi');
  });

  it('formats distances in the chosen unit', () => {
    expect(formatDistance(100, 'mi')).toBe('100 mi');
    expect(formatDistance(100, 'km')).toBe('161 km');
    expect(formatDistance(4.26, 'mi')).toBe('4.3 mi');
  });

  it('guesses the country only roughly', () => {
    expect(guessCountry(53.5, -113.5)).toBe('CA'); // Edmonton
    expect(guessCountry(61.2, -149.9)).toBe('US'); // Anchorage
    expect(guessCountry(40.7, -74)).toBe('US');
  });
});

describe('drive time', () => {
  it('is zero at zero distance and grows with distance', () => {
    expect(driveMinutes(0)).toBe(0);
    let last = 0;
    for (const miles of [1, 5, 20, 50, 100, 200, 400]) {
      const t = driveMinutes(miles);
      expect(t).toBeGreaterThan(last);
      last = t;
    }
  });

  it('is slower per mile on short trips than on long ones', () => {
    expect(averageSpeedMph(5)).toBeLessThan(averageSpeedMph(50));
    expect(averageSpeedMph(50)).toBeLessThan(averageSpeedMph(300));
    expect(averageSpeedMph(1000)).toBeLessThanOrEqual(58);
  });

  it('gives a sensible two hour drive for about 100 straight line miles', () => {
    const m = driveMinutes(100);
    expect(m).toBeGreaterThan(110);
    expect(m).toBeLessThan(150);
  });

  it('is shown in plain words', () => {
    expect(formatDriveTime(37)).toBe('about 35 min');
    expect(formatDriveTime(130)).toBe('about 2 h 10 min');
    expect(formatDriveTime(120)).toBe('about 2 h');
    expect(formatDriveTime(1)).toBe('about 5 min');
  });
});
