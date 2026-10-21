/**
 * Plain language checks on vendor settings before planning.
 */
import { isValidTimeZone } from './time.js';
import type { VendorSettings } from './types.js';
import { PlannerError } from './types.js';

function isNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

export interface SettingsNeeds {
  needFuel?: boolean;
  needHome?: boolean;
}

/** Throws a `PlannerError` with a short message when a setting the planner needs is missing or wrong. */
export function validateSettings(s: VendorSettings, needs: SettingsNeeds = {}): void {
  if (!s || typeof s !== 'object') throw new PlannerError('bad_settings', 'Vendor settings are missing.');
  if (needs.needHome) {
    if (!s.home || !isNum(s.home.lat) || !isNum(s.home.lon) || Math.abs(s.home.lat) > 90 || Math.abs(s.home.lon) > 180) {
      throw new PlannerError('no_home', 'Add your home location in settings.');
    }
  }
  if (s.home?.timezone && !isValidTimeZone(s.home.timezone)) {
    throw new PlannerError('bad_timezone', 'The time zone for your home is not valid.');
  }
  if (!isNum(s.max_drive_hours_per_day) || s.max_drive_hours_per_day <= 0 || s.max_drive_hours_per_day > 24) {
    throw new PlannerError('bad_settings', 'Maximum driving hours per day must be between 0 and 24.');
  }
  if (!isNum(s.hotel_per_night) || s.hotel_per_night < 0) {
    throw new PlannerError('bad_settings', 'Hotel price per night must be zero or more.');
  }
  if (!isNum(s.food_per_day) || s.food_per_day < 0) {
    throw new PlannerError('bad_settings', 'Food per day must be zero or more.');
  }
  if (!isNum(s.margin_percent) || s.margin_percent < 0 || s.margin_percent > 100) {
    throw new PlannerError('bad_settings', 'Margin on sales must be between 0 and 100 percent.');
  }
  if (s.typical_sales) {
    for (const k of ['small', 'medium', 'large', 'major'] as const) {
      const v = s.typical_sales[k];
      if (!isNum(v) || v < 0) throw new PlannerError('bad_settings', 'Typical sales must be zero or more for every show size.');
    }
  }
  if (!Array.isArray(s.sells)) throw new PlannerError('bad_settings', 'What you sell must be a list.');
  if (needs.needFuel !== false) {
    if (!s.fuel_price || !isNum(s.fuel_price.amount) || s.fuel_price.amount < 0) {
      throw new PlannerError('no_fuel_price', 'Add a fuel price in your settings.');
    }
    if (s.fuel_price.unit !== 'gallon' && s.fuel_price.unit !== 'litre') {
      throw new PlannerError('bad_settings', 'Fuel price must be per gallon or per litre.');
    }
    const mpgOk = isNum(s.mpg) && s.mpg > 0;
    const lOk = isNum(s.l_per_100km) && s.l_per_100km > 0;
    if (!mpgOk && !lOk) {
      throw new PlannerError('no_fuel_use', 'Add your miles per gallon or litres per 100 km in your settings.');
    }
  }
}
