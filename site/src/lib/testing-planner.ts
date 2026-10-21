// For tests: a planner caller that runs the worker's request handler in this process, so the glue
// can be tested end to end without a browser. Also builds planner rows from the sample fixtures.
import { generateFixtures } from '../../fixtures/make-fixtures.mjs';
import { createWorkerState, handlePlannerRequest, PlannerCallError } from '../../../planner/src/protocol.ts';
import type { PlannerShow } from '../../../planner/src/types.ts';
import { normalizeShows } from './normalize.ts';
import type { PlannerCaller } from './plan-run.ts';
import { toPlannerRow } from './planner-rows.ts';
import { DEFAULT_VENDOR_SETTINGS, normalizeSettings, type VendorSettings } from './settings.ts';

export const FIXTURE_TODAY = '2026-10-21';

export function fixtureRows(): PlannerShow[] {
  const files = generateFixtures({ base: FIXTURE_TODAY }) as unknown as Record<string, unknown>;
  const { shows } = normalizeShows(files['shows.json']);
  return shows.map(toPlannerRow).filter((r): r is PlannerShow => r !== null);
}

export function inProcessPlanner(rows: PlannerShow[]): PlannerCaller {
  const state = createWorkerState();
  state.shows = rows;
  state.byId = new Map(rows.map((r) => [r.id, r]));
  let next = 1;
  return {
    async call(type, args) {
      const res = await handlePlannerRequest({ ...args, id: next++, type }, state, {});
      if (!res.ok) throw new PlannerCallError(res.error.code, res.error.message);
      return res.result as never;
    },
  };
}

/** A vendor who has filled everything in, living in Philadelphia. */
export function fullSettings(over: Partial<VendorSettings> = {}): VendorSettings {
  return normalizeSettings({
    ...DEFAULT_VENDOR_SETTINGS,
    home: { postal: '19103', lat: 39.9526, lon: -75.1652, country: 'US' },
    currency: 'USD',
    fuelEconomy: 18,
    fuelPrice: 3.4,
    hotelPerNight: 120,
    foodPerDay: 45,
    maxDrivingHoursPerDay: 8,
    typicalSales: { small: 500, medium: 1200, large: 2500, major: 5000 },
    marginPercent: 40,
    sells: ['pokemon', 'mtg'],
    ...over,
  });
}
