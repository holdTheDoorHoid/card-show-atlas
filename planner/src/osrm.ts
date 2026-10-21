/**
 * OSRM adapter for "check real drive times" (DESIGN 6.1).
 *
 * The public OSRM demo server allows only light use, so this adapter is deliberately strict:
 * one plan check is exactly one HTTP request (a single `table` call covering every point), it never
 * retries, never loops, refuses a second request while one is in flight or within `minIntervalMs`
 * of the last one, and caches answers so asking again for the same points costs nothing.
 * `fetch` is injected, so tests never touch the network.
 */
import type { LatLon } from './types.js';
import { PlannerError } from './types.js';
import type { LegMatrix, RouteProvider } from './travel.js';

const METERS_PER_MILE = 1609.344;

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init?: { signal?: unknown; headers?: Record<string, string> },
) => Promise<FetchResponseLike>;

export interface OsrmOptions {
  fetch: FetchLike;
  /** Default `https://router.project-osrm.org` (the public demo). */
  baseUrl?: string;
  /** Default `driving`. */
  profile?: string;
  /** Give up after this long. Default 10000. */
  timeoutMs?: number;
  /** Refuse plans with more points than this rather than splitting into several requests. Default 60. */
  maxPoints?: number;
  /** Minimum gap between two requests. Default 1000 (the demo server asks for at most one a second). */
  minIntervalMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

export interface OsrmRoute {
  /** One entry per consecutive pair of points. */
  legs: { miles: number; hours: number }[];
  miles: number;
  hours: number;
}

interface TimerHost {
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
  AbortController?: new () => { signal: unknown; abort(): void };
}

function coordString(points: LatLon[]): string {
  return points.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
}

function isNumberGrid(x: unknown, n: number): x is (number | null)[][] {
  return (
    Array.isArray(x) &&
    x.length === n &&
    x.every((row) => Array.isArray(row) && row.length === n && row.every((v) => v === null || typeof v === 'number'))
  );
}

export class OsrmRouteProvider implements RouteProvider {
  readonly name = 'osrm';
  readonly label = 'Real drive times from OpenStreetMap routing (OSRM)';
  private readonly fetchFn: FetchLike;
  private readonly baseUrl: string;
  private readonly profile: string;
  private readonly timeoutMs: number;
  private readonly maxPoints: number;
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private inFlight = false;
  private lastRequestAt = -Infinity;
  private readonly cache = new Map<string, unknown>();
  /** Number of HTTP requests made so far. Useful for tests and for a usage note in the UI. */
  requestCount = 0;

  constructor(opts: OsrmOptions) {
    if (typeof opts.fetch !== 'function') {
      throw new PlannerError('no_fetch', 'The routing adapter needs a fetch function.');
    }
    // Call it as a plain function: a browser's native fetch throws when called as a method of
    // another object.
    const f = opts.fetch;
    this.fetchFn = (url, init) => f(url, init);
    this.baseUrl = (opts.baseUrl ?? 'https://router.project-osrm.org').replace(/\/+$/, '');
    this.profile = opts.profile ?? 'driving';
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxPoints = opts.maxPoints ?? 60;
    this.minIntervalMs = opts.minIntervalMs ?? 1000;
    this.now = opts.now ?? (() => Date.now());
  }

  /** URL of the single table request for these points (exposed for tests and debugging). */
  tableUrl(points: LatLon[]): string {
    return `${this.baseUrl}/table/v1/${this.profile}/${coordString(points)}?annotations=duration,distance`;
  }

  routeUrl(points: LatLon[]): string {
    return `${this.baseUrl}/route/v1/${this.profile}/${coordString(points)}?overview=false&steps=false`;
  }

  /** All pairs drive times in one request. */
  async table(points: LatLon[]): Promise<LegMatrix> {
    this.checkPoints(points, 1);
    const url = this.tableUrl(points);
    const body = await this.getJson(url);
    const b = body as { code?: unknown; durations?: unknown; distances?: unknown };
    if (b.code !== 'Ok') throw new PlannerError('routing_failed', 'The routing service could not find routes for these stops.');
    if (!isNumberGrid(b.durations, points.length) || !isNumberGrid(b.distances, points.length)) {
      throw new PlannerError('routing_bad_reply', 'The routing service sent an answer we could not read.');
    }
    const hours = b.durations.map((row) => row.map((s) => (s === null ? null : s / 3600)));
    const miles = b.distances.map((row) => row.map((m) => (m === null ? null : m / METERS_PER_MILE)));
    return { points, hours, miles, source: 'osrm' };
  }

  /** One route through the points in order, in one request. */
  async route(points: LatLon[]): Promise<OsrmRoute> {
    this.checkPoints(points, 2);
    const body = await this.getJson(this.routeUrl(points));
    const b = body as { code?: unknown; routes?: { legs?: { duration?: unknown; distance?: unknown }[] }[] };
    const r = Array.isArray(b.routes) ? b.routes[0] : undefined;
    if (b.code !== 'Ok' || !r || !Array.isArray(r.legs) || r.legs.length !== points.length - 1) {
      throw new PlannerError('routing_failed', 'The routing service could not find a route through these stops.');
    }
    const legs = r.legs.map((l) => {
      if (typeof l.duration !== 'number' || typeof l.distance !== 'number') {
        throw new PlannerError('routing_bad_reply', 'The routing service sent an answer we could not read.');
      }
      return { hours: l.duration / 3600, miles: l.distance / METERS_PER_MILE };
    });
    return {
      legs,
      hours: legs.reduce((s, l) => s + l.hours, 0),
      miles: legs.reduce((s, l) => s + l.miles, 0),
    };
  }

  private checkPoints(points: LatLon[], min: number): void {
    if (points.length < min) throw new PlannerError('routing_no_points', 'There are no stops to check.');
    if (points.length > this.maxPoints) {
      throw new PlannerError(
        'routing_too_many_points',
        `This plan has ${points.length} stops. Real drive times can be checked for up to ${this.maxPoints} at once.`,
      );
    }
    for (const p of points) {
      if (!(Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180)) {
        throw new PlannerError('routing_bad_point', 'One of the stops has no valid location.');
      }
    }
  }

  private async getJson(url: string): Promise<unknown> {
    if (this.cache.has(url)) return this.cache.get(url);
    if (this.inFlight) throw new PlannerError('routing_busy', 'Already checking drive times. Please wait.');
    if (this.now() - this.lastRequestAt < this.minIntervalMs) {
      throw new PlannerError('routing_busy', 'Please wait a moment before checking again.');
    }
    this.inFlight = true;
    this.lastRequestAt = this.now();
    this.requestCount += 1;
    const host = globalThis as unknown as TimerHost;
    const controller = host.AbortController ? new host.AbortController() : null;
    let timer: unknown = null;
    try {
      const timeout = new Promise<never>((_, reject) => {
        if (host.setTimeout) {
          timer = host.setTimeout(() => {
            controller?.abort();
            reject(new PlannerError('routing_timeout', 'The routing service took too long to answer.'));
          }, this.timeoutMs);
        }
      });
      const res = await Promise.race([this.fetchFn(url, controller ? { signal: controller.signal } : undefined), timeout]);
      if (!res.ok) {
        throw new PlannerError(
          res.status === 429 ? 'routing_rate_limited' : 'routing_http',
          res.status === 429
            ? 'The routing service is busy right now. Estimates are shown instead.'
            : `The routing service answered with an error (${res.status}).`,
        );
      }
      const body = await res.json();
      if (this.cache.size > 20) this.cache.clear();
      this.cache.set(url, body);
      return body;
    } catch (e) {
      if (e instanceof PlannerError) throw e;
      throw new PlannerError('routing_unavailable', 'The routing service could not be reached.');
    } finally {
      if (timer !== null) host.clearTimeout?.(timer);
      this.inFlight = false;
    }
  }
}
