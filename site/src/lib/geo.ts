// Distance and drive time estimates. Straight line distance times a road factor, at a speed that
// is lower on short legs (DESIGN section 6.1). The numbers come from the route planner's own travel
// model, so "about 1 h 20 min" in a list and in a plan are the same.

import { DEFAULT_TRAVEL_MODEL, hoursForRoadMiles } from '../../../planner/src/travel.ts';

export const EARTH_RADIUS_MI = 3958.7613;
export const KM_PER_MILE = 1.609344;
export const ROAD_FACTOR = DEFAULT_TRAVEL_MODEL.roadFactor;

export interface LatLon {
  lat: number;
  lon: number;
}

const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great circle distance in miles. */
export function haversineMiles(a: LatLon, b: LatLon): number;
export function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number;
export function haversineMiles(a: LatLon | number, b: LatLon | number, c?: number, d?: number): number {
  const p1 = typeof a === 'number' ? { lat: a, lon: b as number } : a;
  const p2 = typeof a === 'number' ? { lat: c as number, lon: d as number } : (b as LatLon);
  const dLat = rad(p2.lat - p1.lat);
  const dLon = rad(p2.lon - p1.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(p1.lat)) * Math.cos(rad(p2.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const milesToKm = (mi: number) => mi * KM_PER_MILE;
export const kmToMiles = (km: number) => km / KM_PER_MILE;

export type DistanceUnit = 'mi' | 'km';

/** A distance in miles shown in the chosen unit, like "42 mi" or "68 km". */
export function formatDistance(miles: number, unit: DistanceUnit): string {
  const v = unit === 'km' ? milesToKm(miles) : miles;
  const rounded = v < 10 ? Math.round(v * 10) / 10 : Math.round(v);
  return `${rounded} ${unit}`;
}

/** Average driving speed in mph for a trip whose road distance is the given number of miles. */
export function averageSpeedMph(roadMiles: number): number {
  const hours = hoursForRoadMiles(roadMiles);
  return hours > 0 ? roadMiles / hours : 0;
}

/** Estimated driving time in minutes for a straight line distance in miles. */
export function driveMinutes(straightMiles: number): number {
  if (straightMiles <= 0) return 0;
  return hoursForRoadMiles(straightMiles * ROAD_FACTOR) * 60;
}

/** Whether a country code uses kilometres in this site. */
export function unitForCountry(country: string | null | undefined): DistanceUnit {
  return country === 'CA' ? 'km' : 'mi';
}

/**
 * Rough guess at the country of a point, used only when no listed show is nearby to tell us (the
 * nearest show's country wins first). North of 49 degrees is Canada, apart from Alaska. Below that
 * the border is too crooked for a rule this small, so the answer is the United States and the
 * miles or km toggle covers the rest.
 */
export function guessCountry(lat: number, lon: number): 'US' | 'CA' {
  if (lat >= 49.1) {
    if (lon < -141) return 'US'; // Alaska
    if (lon < -130 && lat > 54.7 && lat < 60) return 'US'; // the Alaska panhandle
    return 'CA';
  }
  return 'US';
}
