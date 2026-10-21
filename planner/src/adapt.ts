/**
 * Turns a full show record from DATA_MODEL section 2 into the compact `PlannerShow` row.
 */
import type { Confidence, EventType, PlannerShow, ShowStatus, SizeClass, VendorStatus } from './types.js';

/** The parts of a DATA_MODEL show edition the planner reads. Extra fields are ignored. */
export interface ShowRecord {
  id: string;
  series_id?: string | null;
  name: string;
  event_type: EventType;
  status?: ShowStatus | null;
  days: { date: string; open: string | null; close: string | null }[];
  timezone: string;
  venue: { city?: string | null; region?: string | null; country?: string | null; lat: number; lon: number };
  sells?: { tcg?: string[]; sports?: string[]; other?: string[] } | string[] | null;
  admission?: { free?: boolean | null; adult?: number | null; currency?: string | null } | null;
  size?: { tables?: number | null } | null;
  vendor?: {
    tables?: { label?: string | null; price?: number | null; currency?: string | null }[] | null;
    deadline?: string | null;
    status?: VendorStatus | null;
    setup?: string | null;
    electricity?: string | null;
  } | null;
  estimate?: {
    attendance?: { low: number; mid: number; high: number } | null;
    size_class?: SizeClass | null;
    traffic_per_table?: number | null;
    confidence?: Confidence | null;
  } | null;
}

/** Reads "25 USD extra" style notes into a number in the table currency, when it is that simple. */
function extraFee(text: string | null | undefined, currency: string | null): number | null {
  if (!text) return null;
  const m = /(\d+(?:\.\d+)?)\s*(USD|CAD)?/i.exec(text);
  if (!m) return null;
  if (m[2] && currency && m[2].toUpperCase() !== currency) return null;
  return Number(m[1]);
}

export interface AdaptOptions {
  /** Count the listed electricity fee as an extra cost. Default false. */
  needsElectricity?: boolean;
}

export function toPlannerShow(r: ShowRecord, opts: AdaptOptions = {}): PlannerShow {
  const sells = Array.isArray(r.sells)
    ? r.sells.slice()
    : [...(r.sells?.tcg ?? []), ...(r.sells?.sports ?? []), ...(r.sells?.other ?? [])];
  const priced = (r.vendor?.tables ?? []).filter((t) => typeof t?.price === 'number' && (t.price as number) >= 0);
  priced.sort((a, b) => (a.price as number) - (b.price as number));
  const cheapest = priced[0];
  const currency = cheapest?.currency ?? r.admission?.currency ?? null;
  return {
    id: r.id,
    series_id: r.series_id ?? null,
    name: r.name,
    event_type: r.event_type,
    status: r.status ?? 'scheduled',
    days: r.days.map((d) => ({ date: d.date, open: d.open ?? null, close: d.close ?? null })),
    timezone: r.timezone,
    lat: r.venue.lat,
    lon: r.venue.lon,
    city: r.venue.city ?? null,
    region: r.venue.region ?? null,
    country: r.venue.country ?? null,
    sells,
    estimate: r.estimate
      ? {
          attendance: r.estimate.attendance ?? null,
          size_class: r.estimate.size_class ?? null,
          traffic_per_table: r.estimate.traffic_per_table ?? null,
          confidence: r.estimate.confidence ?? null,
        }
      : null,
    size: { tables: r.size?.tables ?? null },
    vendor: r.vendor
      ? {
          min_table_price: cheapest ? (cheapest.price as number) : null,
          currency,
          deadline: r.vendor.deadline ?? null,
          status: r.vendor.status ?? 'unknown',
          setup: r.vendor.setup ?? null,
          extras: opts.needsElectricity ? extraFee(r.vendor.electricity, currency) : null,
        }
      : null,
    admission: r.admission
      ? { free: r.admission.free ?? null, adult: r.admission.adult ?? null, currency: r.admission.currency ?? null }
      : null,
  };
}
