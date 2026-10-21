/**
 * Message protocol between the page and the planner worker.
 *
 * The page posts `{ id, type, ...args }` and gets back `{ id, type, ok: true, result, ms }` or
 * `{ id, type, ok: false, error: { code, message } }`. `handlePlannerRequest` is a plain async
 * function, so the same code is tested in Node and runs in the worker. `createPlannerClient`
 * wraps a Worker in typed promises for the page.
 */
import { estimateProfit, type EstimateProfitOptions } from './estimate.js';
import { decodeShareLink, encodeShareLink, googleMapsUrls, type DecodeResult, type MapsLink, type MapsLinkOptions, type SharePayload } from './links.js';
import { OsrmRouteProvider, type FetchLike } from './osrm.js';
import type { ProfitEstimate } from './profit.js';
import { checkRealDriveTimes, type DriveTimeCheck } from './realtimes.js';
import {
  rankForShowGoer,
  rankForVendor,
  type ShowGoerQuery,
  type ShowGoerScore,
  type VendorScore,
  type VendorScoreOptions,
} from './scoring.js';
import { planSeason, type SeasonOptions, type SeasonResult } from './season.js';
import type { PlannerShow, VendorSettings } from './types.js';
import { PlannerError } from './types.js';
import type { Plan } from './vending.js';
import { planWeekendRun, type WeekendRunOptions, type WeekendRunResult } from './weekend.js';

export const PROTOCOL_VERSION = 1;

/** Arguments and result of every call. `shows` may be left out after `setShows`. */
export interface PlannerCalls {
  ping: { args: Record<string, never>; result: { version: number } };
  setShows: { args: { shows: PlannerShow[] }; result: { count: number } };
  rankForShowGoer: { args: { shows?: PlannerShow[]; query: ShowGoerQuery }; result: ShowGoerScore[] };
  rankForVendor: { args: { shows?: PlannerShow[]; settings: VendorSettings; options?: VendorScoreOptions }; result: VendorScore[] };
  estimateProfit: {
    args: { show: PlannerShow | string; settings: VendorSettings; options?: EstimateProfitOptions };
    result: ProfitEstimate;
  };
  weekendRun: { args: { shows?: PlannerShow[]; settings: VendorSettings; options: WeekendRunOptions }; result: WeekendRunResult };
  season: { args: { shows?: PlannerShow[]; settings: VendorSettings; options: SeasonOptions }; result: SeasonResult };
  checkDriveTimes: {
    args: {
      plan: Plan;
      kind: 'weekend' | 'season';
      shows?: PlannerShow[];
      settings: VendorSettings;
      options: WeekendRunOptions | SeasonOptions;
      osrm?: { baseUrl?: string; timeoutMs?: number };
    };
    result: DriveTimeCheck;
  };
  mapsLinks: { args: { plan: Plan; options?: MapsLinkOptions }; result: MapsLink[] };
  encodeShare: { args: { payload: SharePayload; includeStart?: boolean }; result: string };
  decodeShare: { args: { link: string }; result: DecodeResult };
}

export type RequestType = keyof PlannerCalls;
export type RequestId = number | string;

export type PlannerRequest = {
  [K in RequestType]: { id: RequestId; type: K } & PlannerCalls[K]['args'];
}[RequestType];

export type PlannerResponse =
  | { id: RequestId; type: string; ok: true; result: unknown; ms: number; version: number }
  | { id: RequestId; type: string; ok: false; error: { code: string; message: string; detail?: string }; version: number };

export interface WorkerState {
  shows: PlannerShow[] | null;
  byId: Map<string, PlannerShow>;
  osrm: OsrmRouteProvider | null;
  osrmKey: string;
}

export function createWorkerState(): WorkerState {
  return { shows: null, byId: new Map(), osrm: null, osrmKey: '' };
}

function showsFor(args: { shows?: PlannerShow[] }, state: WorkerState): PlannerShow[] {
  if (Array.isArray(args.shows)) return args.shows;
  if (state.shows) return state.shows;
  throw new PlannerError('no_shows', 'No shows were sent to the planner yet.');
}

/** Runs one request. Never throws; errors come back as `ok: false` with a plain message. */
export async function handlePlannerRequest(
  raw: unknown,
  state: WorkerState,
  deps: { fetch?: FetchLike } = {},
): Promise<PlannerResponse> {
  const t0 = Date.now();
  const req = (raw ?? {}) as { id?: RequestId; type?: string } & Record<string, unknown>;
  const id = req.id ?? 0;
  const type = typeof req.type === 'string' ? req.type : '';
  const done = (result: unknown): PlannerResponse => ({ id, type, ok: true, result, ms: Date.now() - t0, version: PROTOCOL_VERSION });
  try {
    const r = req as PlannerRequest;
    switch (r.type) {
      case 'ping':
        return done({ version: PROTOCOL_VERSION });
      case 'setShows': {
        if (!Array.isArray(r.shows)) throw new PlannerError('bad_request', 'Shows must be a list.');
        state.shows = r.shows;
        state.byId = new Map(r.shows.map((s) => [s.id, s]));
        return done({ count: r.shows.length });
      }
      case 'rankForShowGoer':
        return done(rankForShowGoer(showsFor(r, state), r.query));
      case 'rankForVendor':
        return done(rankForVendor(showsFor(r, state), r.settings, r.options ?? {}));
      case 'estimateProfit': {
        const show = typeof r.show === 'string' ? state.byId.get(r.show) : r.show;
        if (!show) throw new PlannerError('unknown_show', 'That show is not loaded.');
        return done(estimateProfit(show, r.settings, r.options ?? {}));
      }
      case 'weekendRun':
        return done(planWeekendRun(showsFor(r, state), r.settings, r.options));
      case 'season':
        return done(planSeason(showsFor(r, state), r.settings, r.options));
      case 'checkDriveTimes': {
        const f = deps.fetch;
        if (!f) throw new PlannerError('no_fetch', 'Real drive times need a network connection.');
        const key = `${r.osrm?.baseUrl ?? ''}|${r.osrm?.timeoutMs ?? ''}`;
        if (!state.osrm || state.osrmKey !== key) {
          state.osrm = new OsrmRouteProvider({ fetch: f, baseUrl: r.osrm?.baseUrl, timeoutMs: r.osrm?.timeoutMs });
          state.osrmKey = key;
        }
        const shows = showsFor(r, state);
        const request =
          r.kind === 'season'
            ? { kind: 'season' as const, shows, settings: r.settings, options: r.options as SeasonOptions }
            : { kind: 'weekend' as const, shows, settings: r.settings, options: r.options as WeekendRunOptions };
        return done(await checkRealDriveTimes(r.plan, request, state.osrm));
      }
      case 'mapsLinks':
        return done(googleMapsUrls(r.plan, r.options ?? {}));
      case 'encodeShare':
        return done(encodeShareLink(r.payload, { includeStart: r.includeStart }));
      case 'decodeShare':
        return done(decodeShareLink(r.link));
      default:
        throw new PlannerError('unknown_request', `Unknown request "${type}".`);
    }
  } catch (e) {
    if (e instanceof PlannerError) {
      return { id, type, ok: false, error: { code: e.code, message: e.message }, version: PROTOCOL_VERSION };
    }
    return {
      id,
      type,
      ok: false,
      error: { code: 'internal', message: 'Something went wrong while planning.', detail: e instanceof Error ? e.message : String(e) },
      version: PROTOCOL_VERSION,
    };
  }
}

/** The part of a Worker the client needs. A real `Worker` fits. */
export interface WorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
  terminate?(): void;
}

export class PlannerCallError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'PlannerCallError';
  }
}

export interface PlannerClient {
  call<K extends RequestType>(type: K, args: PlannerCalls[K]['args']): Promise<PlannerCalls[K]['result']>;
  /** Stops the worker. Pending calls are rejected. Use it to cancel a long plan, then make a new client. */
  terminate(): void;
}

export function createPlannerClient(worker: WorkerLike): PlannerClient {
  let next = 1;
  const pending = new Map<RequestId, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  worker.addEventListener('message', (ev) => {
    const res = ev.data as PlannerResponse;
    if (!res || typeof res !== 'object' || !('id' in res)) return;
    const p = pending.get(res.id);
    if (!p) return;
    pending.delete(res.id);
    if (res.ok) p.resolve(res.result);
    else p.reject(new PlannerCallError(res.error.code, res.error.message));
  });
  return {
    call(type, args) {
      const id = next++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        worker.postMessage({ ...args, id, type });
      });
    },
    terminate() {
      worker.terminate?.();
      for (const p of pending.values()) p.reject(new PlannerCallError('terminated', 'Planning was stopped.'));
      pending.clear();
    },
  };
}
