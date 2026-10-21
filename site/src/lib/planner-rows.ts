// Rows for the route planner. The planner reads a compact `PlannerShow` per show (see
// planner/src/types.ts). This file builds them from the site's normalized shows, and packs and
// unpacks them for planner.json. It mirrors planner/src/adapt.ts (toPlannerShow); a test keeps the
// two in step. Node and browser safe: only types are imported from the planner, so the prepare
// script can use this file without loading the planner.
import type { PlannerShow } from '../../../planner/src/types.ts';
import type { Show, Vocab } from './types.ts';

export type { PlannerShow };

/** A show the planner can use: it needs a place on the map and a time zone. */
export function toPlannerRow(show: Show): PlannerShow | null {
  const { lat, lon } = show.venue;
  if (lat === null || lon === null || !show.timezone || show.days.length === 0) return null;
  const priced = show.vendor.tables
    .filter((t) => typeof t.price === 'number' && (t.price as number) >= 0)
    .sort((a, b) => (a.price as number) - (b.price as number));
  const cheapest = priced[0];
  const currency = cheapest?.currency ?? show.admission.currency ?? null;
  return {
    id: show.id,
    series_id: show.series_id,
    name: show.name,
    event_type: show.event_type,
    status: show.status,
    days: show.days.map((d) => ({ date: d.date, open: d.open, close: d.close })),
    timezone: show.timezone,
    lat,
    lon,
    city: show.venue.city,
    region: show.venue.region,
    country: show.venue.country,
    sells: [...show.sells.tcg, ...show.sells.sports, ...show.sells.other],
    estimate: show.estimate
      ? {
          attendance: show.estimate.attendance,
          size_class: show.estimate.size_class,
          traffic_per_table: show.estimate.traffic_per_table,
          confidence: show.estimate.confidence,
        }
      : null,
    size: { tables: show.size.tables },
    vendor: {
      min_table_price: cheapest ? (cheapest.price as number) : null,
      currency,
      deadline: show.vendor.deadline,
      status: show.vendor.status,
      setup: show.vendor.setup,
      extras: null,
    },
    admission: { free: show.admission.free, adult: show.admission.adult, currency: show.admission.currency },
  };
}

// ---------- packing ----------

/** Drop null values to keep planner.json small. `expandPlannerRow` puts them back. */
export function packPlannerRow(row: PlannerShow): Record<string, unknown> {
  return JSON.parse(JSON.stringify(row, (_k, v) => (v === null ? undefined : v))) as Record<string, unknown>;
}

type Obj = Record<string, unknown>;
const n = (v: unknown) => (v === undefined ? null : v);

/** The exact `PlannerShow` shape the planner expects, from a packed row. */
export function expandPlannerRow(p: Obj): PlannerShow {
  const est = p.estimate as Obj | undefined;
  const size = p.size as Obj | undefined;
  const vendor = p.vendor as Obj | undefined;
  const adm = p.admission as Obj | undefined;
  return {
    id: p.id as string,
    series_id: n(p.series_id) as string | null,
    name: p.name as string,
    event_type: p.event_type as PlannerShow['event_type'],
    status: (n(p.status) as PlannerShow['status']) ?? 'scheduled',
    days: ((p.days as Obj[]) ?? []).map((d) => ({ date: d.date as string, open: n(d.open) as string | null, close: n(d.close) as string | null })),
    timezone: p.timezone as string,
    lat: p.lat as number,
    lon: p.lon as number,
    city: n(p.city) as string | null,
    region: n(p.region) as string | null,
    country: n(p.country) as string | null,
    sells: (p.sells as string[]) ?? [],
    estimate: est
      ? {
          attendance: n(est.attendance) as { low: number; mid: number; high: number } | null,
          size_class: n(est.size_class) as never,
          traffic_per_table: n(est.traffic_per_table) as number | null,
          confidence: n(est.confidence) as never,
        }
      : null,
    size: size ? { tables: n(size.tables) as number | null } : null,
    vendor: vendor
      ? {
          min_table_price: n(vendor.min_table_price) as number | null,
          currency: n(vendor.currency) as string | null,
          deadline: n(vendor.deadline) as string | null,
          status: n(vendor.status) as never,
          setup: n(vendor.setup) as string | null,
          extras: n(vendor.extras) as number | null,
        }
      : null,
    admission: adm ? { free: n(adm.free) as boolean | null, adult: n(adm.adult) as number | null, currency: n(adm.currency) as string | null } : null,
  };
}

// ---------- the file ----------

export interface PlannerFile {
  v: 1;
  generated: string;
  fixture: boolean;
  count: number;
  vocab: Vocab;
  /** packed rows, see `packPlannerRow` */
  rows: Record<string, unknown>[];
}

/** Shows that cannot be planned (no place or time zone) are left out; the count says how many. */
export function buildPlannerFile(shows: Show[], vocab: Vocab, meta: { generated: string; fixture: boolean }): PlannerFile {
  const rows: Record<string, unknown>[] = [];
  for (const s of shows) {
    if (s.event_type === 'store_event') continue;
    const row = toPlannerRow(s);
    if (row) rows.push(packPlannerRow(row));
  }
  rows.sort((a, b) => ((a.days as { date: string }[])[0]?.date ?? '').localeCompare((b.days as { date: string }[])[0]?.date ?? '') || String(a.id).localeCompare(String(b.id)));
  return { v: 1, generated: meta.generated, fixture: meta.fixture, count: rows.length, vocab, rows };
}

export function plannerShowsFrom(file: PlannerFile): PlannerShow[] {
  return file.rows.map(expandPlannerRow);
}
