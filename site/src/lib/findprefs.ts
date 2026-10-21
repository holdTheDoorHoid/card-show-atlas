// What the Find page remembers on this device: the chosen place, distance, dates and sort order.
import { isISODate, type DateChip } from './dates.ts';
import type { SortKey } from './filters.ts';
import { DISTANCE_MAX_KM, DISTANCE_MAX_MI, DISTANCE_MIN } from './config.ts';
import { guessCountry, haversineMiles, kmToMiles, milesToKm, type DistanceUnit } from './geo.ts';
import type { IndexRow } from './types.ts';

export interface SavedLocation {
  /** what to show the person: "08837", "M5V" or "your location" */
  label: string;
  lat: number;
  lon: number;
  country: 'US' | 'CA';
  source: 'postal' | 'gps';
}

export function sanitizeLocation(raw: unknown): SavedLocation | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.lat !== 'number' || typeof o.lon !== 'number' || Math.abs(o.lat) > 90 || Math.abs(o.lon) > 180) return null;
  return {
    label: typeof o.label === 'string' && o.label.length < 40 ? o.label : 'your location',
    lat: o.lat,
    lon: o.lon,
    country: o.country === 'CA' ? 'CA' : 'US',
    source: o.source === 'gps' ? 'gps' : 'postal',
  };
}

export interface FindPrefs {
  /** how far, in miles (shown in km in Canada) */
  radiusMi: number;
  /** miles or km chosen by hand; null means follow the country of the place */
  unit: DistanceUnit | null;
  chip: DateChip;
  pickFrom: string | null;
  pickTo: string | null;
  sort: SortKey;
}

export const DEFAULT_FIND_PREFS: FindPrefs = { radiusMi: 100, unit: null, chip: '30days', pickFrom: null, pickTo: null, sort: 'date' };

export function sanitizePrefs(raw: unknown): FindPrefs {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_FIND_PREFS };
  const o = raw as Record<string, unknown>;
  const radius = typeof o.radiusMi === 'number' && Number.isFinite(o.radiusMi) ? o.radiusMi : DEFAULT_FIND_PREFS.radiusMi;
  return {
    radiusMi: Math.min(DISTANCE_MAX_MI, Math.max(DISTANCE_MIN, radius)),
    unit: o.unit === 'km' || o.unit === 'mi' ? o.unit : null,
    chip: o.chip === 'weekend' || o.chip === '2weeks' || o.chip === '30days' || o.chip === 'pick' ? o.chip : DEFAULT_FIND_PREFS.chip,
    pickFrom: typeof o.pickFrom === 'string' && isISODate(o.pickFrom) ? o.pickFrom : null,
    pickTo: typeof o.pickTo === 'string' && isISODate(o.pickTo) ? o.pickTo : null,
    sort: o.sort === 'distance' || o.sort === 'size' || o.sort === 'match' || o.sort === 'date' ? o.sort : 'date',
  };
}

/** The slider's range in the unit being shown. */
export function sliderRange(unit: DistanceUnit): { min: number; max: number; step: number } {
  return { min: DISTANCE_MIN, max: unit === 'km' ? DISTANCE_MAX_KM : DISTANCE_MAX_MI, step: 10 };
}

/** The slider's value for a radius in miles. */
export function sliderValue(radiusMi: number, unit: DistanceUnit): number {
  const { min, max, step } = sliderRange(unit);
  const v = unit === 'km' ? milesToKm(radiusMi) : radiusMi;
  return Math.min(max, Math.max(min, Math.round(v / step) * step));
}

/** The radius in miles for a slider value in the shown unit. */
export function radiusFromSlider(value: number, unit: DistanceUnit): number {
  return Math.min(DISTANCE_MAX_MI, unit === 'km' ? kmToMiles(value) : value);
}

/**
 * Which country a point is in, for choosing miles or km. The nearest listed show decides when one
 * is within 150 miles; otherwise a rough rule is used.
 */
export function countryNear(rows: readonly IndexRow[], lat: number, lon: number): 'US' | 'CA' {
  let best: IndexRow | null = null;
  let bestMiles = 150;
  for (const r of rows) {
    if (!r.ll) continue;
    const d = haversineMiles(lat, lon, r.ll[0], r.ll[1]);
    if (d < bestMiles) {
      bestMiles = d;
      best = r;
    }
  }
  if (best) return best.k === 'CA' ? 'CA' : 'US';
  return guessCountry(lat, lon);
}
