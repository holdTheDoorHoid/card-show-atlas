/**
 * Travel model (DESIGN 6.1). Straight line distance times a road factor, driven at a speed that is
 * lower on short legs. Fast enough to compare thousands of options. Real drive times can be swapped
 * in through a `RouteProvider` (see `osrm.ts`) and handed back to the planners as known legs.
 */
import type { LatLon } from './types.js';
import { PlannerError } from './types.js';

export const KM_PER_MILE = 1.609344;
const EARTH_RADIUS_MILES = 3958.7613;

export interface SpeedBand {
  /** Length of this band in road miles. */
  miles: number;
  /** Speed while inside this band. */
  mph: number;
}

/**
 * Time on a leg is the sum over bands: the first `bands[0].miles` road miles at `bands[0].mph`, the
 * next band after that, and everything beyond the last band at `cruiseMph`. Because time is built
 * up mile by mile, a longer leg never takes less time than a shorter one, and the average speed of
 * a short leg is lower than that of a long one.
 */
export interface TravelModel {
  roadFactor: number;
  bands: SpeedBand[];
  cruiseMph: number;
  /** Fixed time added to every leg between two different places (parking, loading). Default 0. */
  overheadMinutes: number;
}

export const DEFAULT_TRAVEL_MODEL: TravelModel = {
  roadFactor: 1.25,
  bands: [
    { miles: 5, mph: 25 },
    { miles: 15, mph: 40 },
    { miles: 40, mph: 55 },
  ],
  cruiseMph: 63,
  overheadMinutes: 0,
};

export type LegSource = 'estimate' | 'osrm' | 'given';

export interface Leg {
  miles: number;
  km: number;
  hours: number;
  source: LegSource;
}

export function resolveTravelModel(partial?: Partial<TravelModel> | null): TravelModel {
  const m: TravelModel = { ...DEFAULT_TRAVEL_MODEL, ...(partial ?? {}) };
  if (!(m.roadFactor >= 1 && m.roadFactor < 5)) {
    throw new PlannerError('bad_travel_model', 'Road factor must be between 1 and 5.');
  }
  if (!(m.cruiseMph > 0)) throw new PlannerError('bad_travel_model', 'Cruise speed must be above zero.');
  for (const b of m.bands) {
    if (!(b.miles > 0) || !(b.mph > 0)) {
      throw new PlannerError('bad_travel_model', 'Each speed band needs a length and a speed above zero.');
    }
  }
  if (!(m.overheadMinutes >= 0)) throw new PlannerError('bad_travel_model', 'Overhead cannot be negative.');
  return m;
}

/** Great circle distance in miles. */
export function haversineMiles(a: LatLon, b: LatLon): number {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Hours to drive a number of road miles under the model. */
export function hoursForRoadMiles(roadMiles: number, model: TravelModel = DEFAULT_TRAVEL_MODEL): number {
  if (!(roadMiles > 0)) return 0;
  let left = roadMiles;
  let hours = 0;
  for (const band of model.bands) {
    const d = Math.min(left, band.miles);
    hours += d / band.mph;
    left -= d;
    if (left <= 0) break;
  }
  if (left > 0) hours += left / model.cruiseMph;
  return hours + model.overheadMinutes / 60;
}

/** Writes estimated road miles and hours into `out` without allocating. */
export function estimateInto(a: LatLon, b: LatLon, model: TravelModel, out: { miles: number; hours: number }): void {
  const straight = haversineMiles(a, b);
  if (straight < 1e-6) {
    out.miles = 0;
    out.hours = 0;
    return;
  }
  const miles = straight * model.roadFactor;
  out.miles = miles;
  out.hours = hoursForRoadMiles(miles, model);
}

/** Estimated leg between two points. */
export function estimateLeg(a: LatLon, b: LatLon, model: TravelModel = DEFAULT_TRAVEL_MODEL): Leg {
  const straight = haversineMiles(a, b);
  if (straight < 1e-6) return { miles: 0, km: 0, hours: 0, source: 'estimate' };
  const miles = straight * model.roadFactor;
  return { miles, km: miles * KM_PER_MILE, hours: hoursForRoadMiles(miles, model), source: 'estimate' };
}

/** A full table of legs between points, as returned by a route provider. Null where no route exists. */
export interface LegMatrix {
  points: LatLon[];
  miles: (number | null)[][];
  hours: (number | null)[][];
  source: LegSource;
}

/**
 * Something that can produce drive times between points. The estimate provider is synchronous in
 * spirit but exposes the same async shape as the OSRM adapter so the two can be swapped.
 */
export interface RouteProvider {
  readonly name: string;
  /** Plain label for the UI, for example "Estimated drive times". */
  readonly label: string;
  table(points: LatLon[]): Promise<LegMatrix>;
}

export class EstimateRouteProvider implements RouteProvider {
  readonly name = 'estimate';
  readonly label = 'Estimated drive times';
  readonly model: TravelModel;

  constructor(model?: Partial<TravelModel>) {
    this.model = resolveTravelModel(model);
  }

  leg(a: LatLon, b: LatLon): Leg {
    return estimateLeg(a, b, this.model);
  }

  async table(points: LatLon[]): Promise<LegMatrix> {
    const miles = points.map((a) => points.map((b) => this.leg(a, b).miles));
    const hours = points.map((a) => points.map((b) => this.leg(a, b).hours));
    return { points, miles, hours, source: 'estimate' };
  }
}

function pointKey(p: LatLon): string {
  return `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
}

/**
 * Travel function used by the planners: known legs (for example real drive times from a plan
 * check) win, everything else is estimated. Results are cached per pair.
 */
export class Travel {
  readonly model: TravelModel;
  private readonly known = new Map<string, Leg>();
  private readonly cache = new Map<string, Leg>();

  constructor(model?: Partial<TravelModel> | null, knownLegs?: LegMatrix | LegMatrix[] | null) {
    this.model = resolveTravelModel(model);
    const list = knownLegs ? (Array.isArray(knownLegs) ? knownLegs : [knownLegs]) : [];
    for (const m of list) this.addMatrix(m);
  }

  addMatrix(m: LegMatrix): void {
    for (let i = 0; i < m.points.length; i++) {
      for (let j = 0; j < m.points.length; j++) {
        const mi = m.miles[i]?.[j];
        const h = m.hours[i]?.[j];
        if (mi === null || mi === undefined || h === null || h === undefined) continue;
        if (!Number.isFinite(mi) || !Number.isFinite(h) || mi < 0 || h < 0) continue;
        this.known.set(`${pointKey(m.points[i]!)}>${pointKey(m.points[j]!)}`, {
          miles: mi,
          km: mi * KM_PER_MILE,
          hours: h,
          source: m.source,
        });
      }
    }
    this.cache.clear();
  }

  leg(a: LatLon, b: LatLon): Leg {
    // The estimate is cheaper than a string keyed lookup, so only known legs go through the map.
    if (this.known.size === 0) return estimateLeg(a, b, this.model);
    const key = `${pointKey(a)}>${pointKey(b)}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const leg = this.known.get(key) ?? estimateLeg(a, b, this.model);
    if (this.cache.size > 500_000) this.cache.clear();
    this.cache.set(key, leg);
    return leg;
  }

  hasKnown(): boolean {
    return this.known.size > 0;
  }

  /** Miles and hours into `out`, without allocating when no known legs are loaded. */
  fill(a: LatLon, b: LatLon, out: { miles: number; hours: number }): void {
    if (this.known.size === 0) {
      estimateInto(a, b, this.model, out);
      return;
    }
    const l = this.leg(a, b);
    out.miles = l.miles;
    out.hours = l.hours;
  }
}
