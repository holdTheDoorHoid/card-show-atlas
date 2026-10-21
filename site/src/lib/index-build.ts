// Builds the compact client index from full show records, and reads rows back.
// Used by scripts/prepare-data.mjs (before the build) and by the tests. No Node or browser APIs.
import { addDays, daysBetween } from './dates.ts';
import type { IndexFile, IndexRow, Show, Vocab } from './types.ts';

const VERIF_CODE: Record<Show['verification'], IndexRow['vf']> = {
  organizer_confirmed: 'o',
  listed: 'l',
  community: 'c',
  unverified: 'u',
};

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** Every date a show is on, from a row. */
export function rowDays(row: IndexRow): string[] {
  if (row.ds && row.ds.length > 0) return row.ds;
  if (!row.e || row.e === row.d) return [row.d];
  const out: string[] = [];
  const n = daysBetween(row.d, row.e);
  for (let i = 0; i <= n; i++) out.push(addDays(row.d, i));
  return out;
}

export function rowLastDay(row: IndexRow): string {
  return row.e ?? row.d;
}

/** Does the show have any day inside from..to (inclusive)? */
export function rowOverlaps(row: IndexRow, from: string, to: string): boolean {
  const last = rowLastDay(row);
  if (last < from || row.d > to) return false;
  if (!row.ds || row.ds.length === 0) return true;
  return row.ds.some((d) => d >= from && d <= to);
}

export function vendorInfoKnown(show: Show): boolean {
  const v = show.vendor;
  return v.tables.length > 0 || v.application_url !== null || v.deadline !== null || v.status !== 'unknown';
}

export function lowestTablePrice(show: Show): number | null {
  const prices = show.vendor.tables.map((t) => t.price).filter((p): p is number => p !== null);
  return prices.length ? Math.min(...prices) : null;
}

export function toRow(show: Show, opts: { withLink?: boolean } = {}): IndexRow {
  const dates = show.days.map((d) => d.date);
  const first = dates[0] as string;
  const last = dates[dates.length - 1] as string;
  const row: IndexRow = {
    i: show.id,
    n: show.name,
    t: show.event_type,
    d: first,
    c: show.venue.city,
    r: show.venue.region,
    k: show.venue.country,
    vf: VERIF_CODE[show.verification],
  };
  if (last !== first) row.e = last;
  const unbroken = dates.length === daysBetween(first, last) + 1;
  if (!unbroken) row.ds = dates;
  if (show.venue.lat !== null && show.venue.lon !== null) row.ll = [round4(show.venue.lat), round4(show.venue.lon)];
  if (show.venue.geo_precision !== 'address') row.g = show.venue.geo_precision;
  if (show.status !== 'scheduled') row.st = show.status;
  if (show.estimate) {
    // A rough guess from the event type alone is not shown as a size: the badge would look like a fact.
    if (show.estimate.basis !== 'type_default') row.sz = show.estimate.size_class;
    row.at = Math.round(show.estimate.attendance.mid);
  }
  const sl = [...show.sells.tcg, ...show.sells.sports, ...show.sells.other];
  if (sl.length > 0) row.sl = sl;
  if (show.mix !== 'unknown') row.mx = show.mix;
  if (show.admission.free === true || show.admission.adult === 0) row.fr = 1;
  else if (show.admission.adult !== null) row.ad = show.admission.adult;
  if (show.admission.currency !== 'USD') row.cu = show.admission.currency;
  if (vendorInfoKnown(show)) {
    row.vs = show.vendor.status;
    const low = lowestTablePrice(show);
    if (low !== null) row.vp = low;
    if (show.vendor.deadline) row.vd = show.vendor.deadline;
  }
  if (opts.withLink) {
    const link = show.links.official ?? show.organizer.url;
    if (link) row.u = link;
  }
  return row;
}

export function buildIndex(
  shows: Show[],
  vocab: Vocab,
  meta: { generated: string; fixture: boolean; withLink?: boolean },
): IndexFile {
  const rows = shows.map((s) => toRow(s, { withLink: meta.withLink })).sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : a.i < b.i ? -1 : a.i > b.i ? 1 : 0));
  return { v: 1, generated: meta.generated, fixture: meta.fixture, count: rows.length, vocab, rows };
}

export function emptyIndex(vocab: Vocab, generated: string): IndexFile {
  return { v: 1, generated, fixture: false, count: 0, vocab, rows: [] };
}

/** Real shows only: store events are a separate layer and never appear on show pages or in the main index. */
export function splitStoreEvents(shows: Show[]): { shows: Show[]; storeEvents: Show[] } {
  return {
    shows: shows.filter((s) => s.event_type !== 'store_event'),
    storeEvents: shows.filter((s) => s.event_type === 'store_event'),
  };
}
