import { describe, expect, it } from 'vitest';
import {
  createPlannerClient,
  createWorkerState,
  handlePlannerRequest,
  PROTOCOL_VERSION,
  toPlannerShow,
  type FetchLike,
  type PlannerResponse,
  type ShowRecord,
  type WorkerLike,
} from '../src/index.js';
import { PlannerCallError } from '../src/protocol.js';
import { estimateLeg } from '../src/travel.js';
import { sampleSeason, sampleShows, sampleVendor, sampleWeekend } from './fixtures.js';

declare const structuredClone: <T>(x: T) => T;

/** An in memory worker: messages go through structured clone, like a real Worker. */
function fakeWorker(fetch?: FetchLike): WorkerLike & { posted: number } {
  const state = createWorkerState();
  const listeners: ((ev: { data: unknown }) => void)[] = [];
  const w = {
    posted: 0,
    postMessage(msg: unknown) {
      w.posted += 1;
      const data = structuredClone(msg);
      void handlePlannerRequest(data, state, { fetch }).then((res) => {
        const out = structuredClone(res);
        for (const l of listeners) l({ data: out });
      });
    },
    addEventListener(_type: 'message', l: (ev: { data: unknown }) => void) {
      listeners.push(l);
    },
    terminate() {},
  };
  return w;
}

describe('worker protocol', () => {
  it('answers ping with the protocol version', async () => {
    const res = await handlePlannerRequest({ id: 1, type: 'ping' }, createWorkerState());
    expect(res).toMatchObject({ id: 1, ok: true, result: { version: PROTOCOL_VERSION } });
  });

  it('caches shows once and plans without resending them', async () => {
    const state = createWorkerState();
    const set = await handlePlannerRequest({ id: 'a', type: 'setShows', shows: sampleShows() }, state);
    expect(set).toMatchObject({ ok: true, result: { count: 18 } });
    const res = (await handlePlannerRequest({ id: 'b', type: 'weekendRun', settings: sampleVendor(), options: sampleWeekend() }, state)) as Extract<PlannerResponse, { ok: true }>;
    expect(res.ok).toBe(true);
    expect((res.result as { best: { stops: unknown[] } }).best.stops.length).toBeGreaterThan(0);
    const profit = await handlePlannerRequest({ id: 'c', type: 'estimateProfit', show: 'lehigh-valley-card-show-allentown-pa-2026-11-14', settings: sampleVendor(), options: { today: '2026-10-21' } }, state);
    expect(profit.ok).toBe(true);
  });

  it('returns plain errors with codes instead of throwing', async () => {
    const state = createWorkerState();
    const bad = await handlePlannerRequest({ id: 2, type: 'weekendRun', shows: [], settings: sampleVendor(), options: { mode: 'vending', dates: { start: '2026-11-15', end: '2026-11-14' } } }, state);
    expect(bad).toMatchObject({ ok: false, error: { code: 'bad_date', message: 'The end date is before the start date.' } });
    const unknown = await handlePlannerRequest({ id: 3, type: 'teleport' }, state);
    expect(unknown).toMatchObject({ ok: false, error: { code: 'unknown_request' } });
    const noShows = await handlePlannerRequest({ id: 4, type: 'season', settings: sampleVendor(), options: sampleSeason() }, state);
    expect(noShows).toMatchObject({ ok: false, error: { code: 'no_shows' } });
    const garbage = await handlePlannerRequest(null, state);
    expect(garbage.ok).toBe(false);
  });

  it('works end to end through a client with structured clone', async () => {
    const worker = fakeWorker();
    const client = createPlannerClient(worker);
    await client.call('setShows', { shows: sampleShows() });
    const season = await client.call('season', { settings: sampleVendor(), options: sampleSeason() });
    expect(season.plan.stops.length).toBeGreaterThan(0);
    const ranked = await client.call('rankForVendor', { settings: sampleVendor(), options: { today: '2026-10-21' } });
    expect(ranked.length).toBe(18);
    const links = await client.call('mapsLinks', { plan: season.plan });
    expect(links.length).toBe(season.plan.trips.length);
    const share = await client.call('encodeShare', { payload: { mode: 'season', showIds: season.plan.stops.map((s) => s.showId), settings: {} } });
    const decoded = await client.call('decodeShare', { link: share });
    expect(decoded.ok).toBe(true);
    await expect(client.call('season', { settings: { ...sampleVendor(), home: null }, options: sampleSeason() })).rejects.toBeInstanceOf(PlannerCallError);
  });

  it('checks real drive times with one request through the worker', async () => {
    let calls = 0;
    const fetch: FetchLike = async (url) => {
      calls += 1;
      const coords = decodeURIComponent(url.split('/table/v1/driving/')[1]!.split('?')[0]!).split(';').map((c) => {
        const [lon, lat] = c.split(',').map(Number);
        return { lat: lat!, lon: lon! };
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 'Ok',
          durations: coords.map((a) => coords.map((b) => estimateLeg(a, b).hours * 3600)),
          distances: coords.map((a) => coords.map((b) => estimateLeg(a, b).miles * 1609.344)),
        }),
      };
    };
    const client = createPlannerClient(fakeWorker(fetch));
    await client.call('setShows', { shows: sampleShows() });
    const run = await client.call('weekendRun', { settings: sampleVendor(), options: sampleWeekend() });
    const check = await client.call('checkDriveTimes', { plan: run.best!, kind: 'weekend', settings: sampleVendor(), options: sampleWeekend() });
    expect(calls).toBe(1);
    expect(check.ok).toBe(true);
    expect(check.plan!.driveTimes.source).toBe('osrm');
  });

  it('rejects pending calls when terminated', async () => {
    const silent: WorkerLike = { postMessage() {}, addEventListener() {}, terminate() {} };
    const client = createPlannerClient(silent);
    const p = client.call('ping', {});
    client.terminate();
    await expect(p).rejects.toMatchObject({ code: 'terminated' });
  });
});

describe('DATA_MODEL adapter', () => {
  it('turns the documented example record into a planner row', () => {
    const record: ShowRecord = {
      id: 'garden-state-card-show-edison-nj-2026-11-14',
      series_id: 'garden-state-card-show-edison-nj',
      name: 'Garden State Card Show',
      event_type: 'card_show',
      status: 'scheduled',
      days: [
        { date: '2026-11-14', open: '09:00', close: '15:00' },
        { date: '2026-11-15', open: '10:00', close: '14:00' },
      ],
      timezone: 'America/New_York',
      venue: { city: 'Edison', region: 'NJ', country: 'US', lat: 40.5187, lon: -74.3518 },
      sells: { tcg: ['pokemon', 'mtg', 'one_piece'], sports: ['baseball', 'basketball', 'football'], other: ['comics'] },
      admission: { free: false, adult: 5, currency: 'USD' },
      size: { tables: 120 },
      vendor: {
        tables: [
          { label: '8 ft table', price: 150, currency: 'USD' },
          { label: '6 ft table', price: 120, currency: 'USD' },
        ],
        deadline: '2026-10-31',
        status: 'open',
        setup: '07:00',
        electricity: '25 USD extra',
      },
      estimate: { attendance: { low: 400, mid: 700, high: 1100 }, size_class: 'medium', traffic_per_table: 5.8, confidence: 'estimated' },
    };
    const row = toPlannerShow(record);
    expect(row.sells).toEqual(['pokemon', 'mtg', 'one_piece', 'baseball', 'basketball', 'football', 'comics']);
    expect(row.vendor).toEqual({ min_table_price: 120, currency: 'USD', deadline: '2026-10-31', status: 'open', setup: '07:00', extras: null });
    expect(row.lat).toBe(40.5187);
    expect(row.city).toBe('Edison');
    expect(toPlannerShow(record, { needsElectricity: true }).vendor!.extras).toBe(25);
    expect(toPlannerShow({ ...record, vendor: null, estimate: null }).vendor).toBeNull();
  });
});
