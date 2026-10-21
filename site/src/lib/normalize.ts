// Turn a record from shows.json into a complete `Show`, and check a record against DATA_MODEL.
// The pipeline is written separately, so this is forgiving about missing optional parts and strict
// about the few things the site cannot work without.
import { isISODate } from './dates.ts';
import {
  EVENT_TYPES,
  GEO_PRECISIONS,
  SHOW_STATUSES,
  SIZE_CLASSES,
  VENDOR_STATUSES,
  VERIFICATIONS,
  type Admission,
  type Estimate,
  type EstimateBasis,
  type EstimateConfidence,
  type Mix,
  type Organizer,
  type Sells,
  type Show,
  type ShowDay,
  type ShowLinks,
  type SizeInfo,
  type SourceRef,
  type VendorInfo,
  type Venue,
} from './types.ts';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []);
const oneOf = <T extends string>(list: readonly T[], v: unknown): T | null => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null);
const time = (v: unknown): string | null => (typeof v === 'string' && /^\d{1,2}:\d{2}$/.test(v) ? v.padStart(5, '0') : null);

function normalizeDays(v: unknown): ShowDay[] {
  if (!Array.isArray(v)) return [];
  const out: ShowDay[] = [];
  for (const d of v) {
    if (typeof d === 'string' && isISODate(d)) out.push({ date: d, open: null, close: null });
    else if (isObj(d) && isISODate(d.date)) out.push({ date: d.date, open: time(d.open), close: time(d.close) });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out.filter((d, i) => i === 0 || d.date !== out[i - 1]?.date);
}

function normalizeVenue(v: unknown): Venue | null {
  if (!isObj(v)) return null;
  const city = str(v.city);
  const region = str(v.region);
  if (!city || !region) return null;
  const lat = num(v.lat);
  const lon = num(v.lon);
  const validPoint = lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  return {
    name: str(v.name),
    address: str(v.address),
    city,
    region: region.toUpperCase(),
    postal: str(v.postal),
    country: (str(v.country) ?? 'US').toUpperCase(),
    lat: validPoint ? lat : null,
    lon: validPoint ? lon : null,
    geo_precision: oneOf(GEO_PRECISIONS, v.geo_precision) ?? 'city',
  };
}

function normalizeSells(v: unknown): Sells {
  const o = isObj(v) ? v : {};
  return { tcg: strList(o.tcg), sports: strList(o.sports), other: strList(o.other) };
}

export function deriveMix(s: Sells): Mix {
  const tcg = s.tcg.length > 0;
  const sports = s.sports.length > 0;
  if (tcg && sports) return 'mixed';
  if (tcg) return 'tcg';
  if (sports) return 'sports';
  return 'unknown';
}

function normalizeAdmission(v: unknown): Admission {
  const o = isObj(v) ? v : {};
  const adult = num(o.adult);
  const free = typeof o.free === 'boolean' ? o.free : adult === 0 ? true : null;
  return { free, adult, child: num(o.child), currency: str(o.currency) ?? 'USD', notes: str(o.notes) };
}

function normalizeSize(v: unknown): SizeInfo {
  const o = isObj(v) ? v : {};
  let reported: SizeInfo['reported_attendance'] = null;
  if (isObj(o.reported_attendance)) {
    const value = num(o.reported_attendance.value);
    if (value !== null) reported = { value, year: num(o.reported_attendance.year), source_url: str(o.reported_attendance.source_url) };
  }
  return {
    tables: num(o.tables),
    booths: num(o.booths),
    venue_sqft: num(o.venue_sqft),
    players: num(o.players),
    reported_attendance: reported,
    first_year: num(o.first_year),
    edition: num(o.edition),
  };
}

function normalizeVendor(v: unknown): VendorInfo {
  const o = isObj(v) ? v : {};
  const tables = Array.isArray(o.tables)
    ? o.tables.filter(isObj).map((t) => ({
        label: str(t.label) ?? 'Table',
        price: num(t.price),
        currency: str(t.currency) ?? 'USD',
        notes: str(t.notes),
      }))
    : [];
  const opens = str(o.opens);
  const deadline = str(o.deadline);
  return {
    tables,
    application_url: str(o.application_url),
    opens: opens && isISODate(opens) ? opens : null,
    deadline: deadline && isISODate(deadline) ? deadline : null,
    status: oneOf(VENDOR_STATUSES, o.status) ?? 'unknown',
    electricity: str(o.electricity),
    setup: str(o.setup),
    contact: str(o.contact),
    notes: str(o.notes),
  };
}

function normalizeOrganizer(v: unknown): Organizer {
  const o = isObj(v) ? v : {};
  return { name: str(o.name), promoter_id: str(o.promoter_id), url: str(o.url) };
}

function normalizeLinks(v: unknown): ShowLinks {
  const o = isObj(v) ? v : {};
  return { official: str(o.official), tickets: str(o.tickets), facebook: str(o.facebook), instagram: str(o.instagram) };
}

function normalizeSources(v: unknown): SourceRef[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isObj).flatMap((s) => {
    const source = str(s.source);
    return source ? [{ source, url: str(s.url), retrieved: str(s.retrieved), fields: strList(s.fields) }] : [];
  });
}

function normalizeEstimate(v: unknown): Estimate | null {
  if (!isObj(v) || !isObj(v.attendance)) return null;
  const low = num(v.attendance.low);
  const mid = num(v.attendance.mid);
  const high = num(v.attendance.high);
  const sizeClass = oneOf(SIZE_CLASSES, v.size_class);
  if (low === null || mid === null || high === null || !sizeClass) return null;
  const basis = (str(v.basis) ?? 'type_default') as EstimateBasis;
  const confidence = (str(v.confidence) ?? 'rough') as EstimateConfidence;
  return {
    attendance: { low, mid, high },
    basis,
    confidence,
    size_class: sizeClass,
    traffic_per_table: num(v.traffic_per_table),
    explain: str(v.explain) ?? '',
  };
}

/** Returns a complete show, or null when the record lacks an id, a name, a date or a place. */
export function normalizeShow(raw: unknown): Show | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  const name = str(raw.name);
  const eventType = oneOf(EVENT_TYPES, raw.event_type);
  const days = normalizeDays(raw.days);
  const venue = normalizeVenue(raw.venue);
  if (!id || !name || !eventType || days.length === 0 || !venue) return null;
  const sells = normalizeSells(raw.sells);
  const mix = oneOf(['tcg', 'sports', 'mixed', 'unknown'] as const, raw.mix) ?? deriveMix(sells);
  return {
    id,
    series_id: str(raw.series_id) ?? id,
    name,
    event_type: eventType,
    status: oneOf(SHOW_STATUSES, raw.status) ?? 'scheduled',
    days,
    timezone: str(raw.timezone),
    venue,
    sells,
    mix,
    admission: normalizeAdmission(raw.admission),
    size: normalizeSize(raw.size),
    vendor: normalizeVendor(raw.vendor),
    organizer: normalizeOrganizer(raw.organizer),
    links: normalizeLinks(raw.links),
    sources: normalizeSources(raw.sources),
    verification: oneOf(VERIFICATIONS, raw.verification) ?? 'unverified',
    first_seen: str(raw.first_seen),
    last_checked: str(raw.last_checked),
    summary: str(raw.summary),
    estimate: normalizeEstimate(raw.estimate),
  };
}

/** Accept a bare array, or an object that holds the array under a likely key. */
export function recordsFrom(raw: unknown, keys: readonly string[]): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (isObj(raw)) {
    for (const k of keys) {
      const v = raw[k];
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

export interface NormalizeResult {
  shows: Show[];
  dropped: number;
}

export function normalizeShows(raw: unknown): NormalizeResult {
  const records = recordsFrom(raw, ['shows', 'items', 'records', 'events']);
  const shows: Show[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const r of records) {
    const s = normalizeShow(r);
    if (!s || seen.has(s.id)) {
      dropped++;
      continue;
    }
    seen.add(s.id);
    shows.push(s);
  }
  return { shows, dropped };
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Check a raw record against DATA_MODEL section 2. Returns a list of problems, empty when the
 * record is fine. Used by the tests to make sure the sample data follows the contract.
 */
export function validateShowRecord(raw: unknown, vocabIds?: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  if (!isObj(raw)) return ['not an object'];
  const need = (cond: boolean, msg: string) => {
    if (!cond) problems.push(msg);
  };
  const id = typeof raw.id === 'string' ? raw.id : '';
  need(ID_PATTERN.test(id), 'id must be a slug');
  need(typeof raw.series_id === 'string' && ID_PATTERN.test(raw.series_id), 'series_id must be a slug');
  const days = Array.isArray(raw.days) ? raw.days : [];
  need(days.length >= 1, 'days needs at least one day');
  const firstDate = isObj(days[0]) && typeof days[0].date === 'string' ? days[0].date : '';
  need(
    typeof raw.series_id === 'string' && firstDate !== '' && id === `${raw.series_id}-${firstDate}`,
    'id must be <series_id>-<first date>',
  );
  for (const d of days) {
    need(isObj(d) && isISODate(d.date), 'each day needs an ISO date');
    if (isObj(d)) {
      need(d.open === null || (typeof d.open === 'string' && /^\d{2}:\d{2}$/.test(d.open)), 'open must be HH:MM or null');
      need(d.close === null || (typeof d.close === 'string' && /^\d{2}:\d{2}$/.test(d.close)), 'close must be HH:MM or null');
    }
  }
  need(typeof raw.name === 'string' && raw.name !== '', 'name is required');
  need(oneOf(EVENT_TYPES, raw.event_type) !== null, 'event_type is not in the list');
  need(oneOf(SHOW_STATUSES, raw.status) !== null, 'status is not in the list');
  need(typeof raw.timezone === 'string' && raw.timezone.includes('/'), 'timezone must be an IANA name');
  const v = isObj(raw.venue) ? raw.venue : null;
  need(v !== null, 'venue is required');
  if (v) {
    need(typeof v.city === 'string' && v.city !== '', 'venue.city is required');
    need(typeof v.region === 'string' && /^[A-Z]{2}$/.test(v.region), 'venue.region must be two capital letters');
    need(v.country === 'US' || v.country === 'CA', 'venue.country must be US or CA here');
    need(typeof v.lat === 'number' && typeof v.lon === 'number', 'venue needs lat and lon');
    need(oneOf(GEO_PRECISIONS, v.geo_precision) !== null, 'venue.geo_precision is not in the list');
  }
  const sells = isObj(raw.sells) ? raw.sells : null;
  need(sells !== null, 'sells is required');
  if (sells && vocabIds) {
    for (const g of ['tcg', 'sports', 'other']) {
      for (const sid of strList(sells[g])) need(vocabIds.has(sid), `sells.${g} has an id that is not in the vocabulary: ${sid}`);
    }
  }
  need(['tcg', 'sports', 'mixed', 'unknown'].includes(raw.mix as string), 'mix is not in the list');
  const adm = isObj(raw.admission) ? raw.admission : null;
  need(adm !== null && (adm.currency === 'USD' || adm.currency === 'CAD'), 'admission.currency must be USD or CAD');
  need(isObj(raw.size), 'size is required');
  const vendor = isObj(raw.vendor) ? raw.vendor : null;
  need(vendor !== null, 'vendor is required');
  if (vendor) need(oneOf(VENDOR_STATUSES, vendor.status) !== null, 'vendor.status is not in the list');
  need(isObj(raw.organizer), 'organizer is required');
  need(isObj(raw.links), 'links is required');
  need(Array.isArray(raw.sources) && raw.sources.length >= 1, 'sources needs at least one entry');
  need(oneOf(VERIFICATIONS, raw.verification) !== null, 'verification is not in the list');
  need(isISODate(raw.first_seen), 'first_seen must be a date');
  need(isISODate(raw.last_checked), 'last_checked must be a date');
  need('summary' in raw, 'summary key is required (may be null)');
  need('estimate' in raw, 'estimate key is required (may be null)');
  if (isObj(raw.estimate)) {
    need(oneOf(SIZE_CLASSES, raw.estimate.size_class) !== null, 'estimate.size_class is not in the list');
    need(isObj(raw.estimate.attendance), 'estimate.attendance is required');
  }
  return problems;
}
