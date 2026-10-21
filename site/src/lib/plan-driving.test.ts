// The driving and placeholder rules on the Plan page: realistic hotel and food placeholders,
// "How much do you mind driving?", the vendor's time value and the food override.
import { describe, expect, it } from 'vitest';
import { buildSeasonOptions, buildWeekendOptions, defaultSeasonForm, defaultWeekendForm, hasOverrides, NO_OVERRIDES, sanitizeSeasonForm, sanitizeWeekendForm, settingsForPlan } from './plan-options.ts';
import { foodFor, hotelFor, PLACEHOLDER_FOOD, PLACEHOLDER_HOTEL, toPlannerSettings } from './planner-settings.ts';
import { DEFAULT_VENDOR_SETTINGS, normalizeSettings } from './settings.ts';

const home = { lat: 39.951, lon: -75.174, name: '19103' };

describe('placeholders for missing hotel and food', () => {
  it('are realistic, by currency, and listed', () => {
    const us = toPlannerSettings(DEFAULT_VENDOR_SETTINGS, { home });
    expect(us.settings.hotel_per_night).toBe(140);
    expect(us.settings.food_per_day).toBe(35);
    expect(us.placeholders).toContain('hotel 140 USD a night');
    expect(us.placeholders).toContain('food 35 USD a day');
    const ca = toPlannerSettings({ ...DEFAULT_VENDOR_SETTINGS, currency: 'CAD' }, { home });
    expect(ca.settings.hotel_per_night).toBe(180);
    expect(ca.settings.food_per_day).toBe(45);
    expect(ca.placeholders).toContain('hotel 180 CAD a night');
    expect(PLACEHOLDER_HOTEL).toEqual({ USD: 140, CAD: 180 });
    expect(PLACEHOLDER_FOOD).toEqual({ USD: 35, CAD: 45 });
  });

  it('give way to the vendor numbers, including zero', () => {
    const own = toPlannerSettings({ ...DEFAULT_VENDOR_SETTINGS, hotelPerNight: 0, foodPerDay: 20 }, { home });
    expect(own.settings.hotel_per_night).toBe(0);
    expect(own.settings.food_per_day).toBe(20);
    expect(own.placeholders.some((p) => p.startsWith('hotel') || p.startsWith('food'))).toBe(false);
    expect(hotelFor({ ...DEFAULT_VENDOR_SETTINGS, hotelPerNight: 99 })).toEqual({ amount: 99, placeholder: false });
    expect(foodFor(DEFAULT_VENDOR_SETTINGS)).toEqual({ amount: 35, placeholder: true });
  });

  it('can be changed for one plan, food too', () => {
    const o = { ...NO_OVERRIDES, food: 50 };
    expect(hasOverrides(o)).toBe(true);
    expect(settingsForPlan(DEFAULT_VENDOR_SETTINGS, { maxDriveHours: null, sells: null }, o).foodPerDay).toBe(50);
    expect(hasOverrides(NO_OVERRIDES)).toBe(false);
  });
});

describe('the value of the vendor time', () => {
  it('is optional, kept when saved, and passed to the planner only when above zero', () => {
    expect(DEFAULT_VENDOR_SETTINGS.timeValuePerHour).toBeNull();
    expect(normalizeSettings({ timeValuePerHour: 25 }).timeValuePerHour).toBe(25);
    expect(normalizeSettings({ timeValuePerHour: -3 }).timeValuePerHour).toBeNull();
    expect(toPlannerSettings({ ...DEFAULT_VENDOR_SETTINGS, timeValuePerHour: 25 }, { home }).settings.time_value_per_hour).toBe(25);
    expect('time_value_per_hour' in toPlannerSettings(DEFAULT_VENDOR_SETTINGS, { home }).settings).toBe(false);
  });
});

describe('how much do you mind driving', () => {
  const ctx = { today: '2026-10-21', home: null };
  it('defaults to some, is remembered safely, and reaches the planner', () => {
    expect(defaultWeekendForm('2026-10-21').mindDriving).toBe('some');
    expect(defaultSeasonForm('2026-10-21').mindDriving).toBe('some');
    expect(sanitizeWeekendForm({ mindDriving: 'lot' }, '2026-10-21').mindDriving).toBe('lot');
    expect(sanitizeWeekendForm({ mindDriving: 'always' }, '2026-10-21').mindDriving).toBe('some');
    expect(sanitizeSeasonForm({ mindDriving: 'little' }, '2026-10-21').mindDriving).toBe('little');
    const wk = buildWeekendOptions({ ...defaultWeekendForm('2026-10-21'), mindDriving: 'little', startPlace: { lat: 39.95, lon: -75.17, label: '19103', country: 'US' } }, ctx);
    expect(wk.mindDriving).toBe('little');
    expect(buildSeasonOptions({ ...defaultSeasonForm('2026-10-21'), mindDriving: 'lot' }, ctx).mindDriving).toBe('lot');
  });
});
