// Types for the data in DATA_MODEL.md (full records) and for the compact rows the client loads.

export type EventType = 'card_show' | 'convention' | 'tournament' | 'pop_culture_con' | 'store_event';
export type ShowStatus = 'scheduled' | 'tentative' | 'postponed' | 'cancelled';
export type GeoPrecision = 'address' | 'venue' | 'postal' | 'city';
export type SizeClass = 'small' | 'medium' | 'large' | 'major';
export type VendorStatus = 'open' | 'waitlist' | 'sold_out' | 'closed' | 'unknown';
export type Verification = 'organizer_confirmed' | 'listed' | 'community' | 'unverified';
export type Mix = 'tcg' | 'sports' | 'mixed' | 'unknown';
export type EstimateBasis = 'reported' | 'players' | 'tables' | 'area' | 'history' | 'type_default';
export type EstimateConfidence = 'reported' | 'estimated' | 'rough';

export const EVENT_TYPES: readonly EventType[] = ['card_show', 'convention', 'tournament', 'pop_culture_con', 'store_event'];
export const SHOW_STATUSES: readonly ShowStatus[] = ['scheduled', 'tentative', 'postponed', 'cancelled'];
export const GEO_PRECISIONS: readonly GeoPrecision[] = ['address', 'venue', 'postal', 'city'];
export const SIZE_CLASSES: readonly SizeClass[] = ['small', 'medium', 'large', 'major'];
export const VENDOR_STATUSES: readonly VendorStatus[] = ['open', 'waitlist', 'sold_out', 'closed', 'unknown'];
export const VERIFICATIONS: readonly Verification[] = ['organizer_confirmed', 'listed', 'community', 'unverified'];

export interface ShowDay {
  date: string;
  open: string | null;
  close: string | null;
}

export interface Venue {
  name: string | null;
  address: string | null;
  city: string;
  region: string;
  postal: string | null;
  country: string;
  lat: number | null;
  lon: number | null;
  geo_precision: GeoPrecision;
}

export interface Sells {
  tcg: string[];
  sports: string[];
  other: string[];
}

export interface Admission {
  free: boolean | null;
  adult: number | null;
  child: number | null;
  currency: string;
  notes: string | null;
}

export interface ReportedAttendance {
  value: number;
  year: number | null;
  source_url: string | null;
}

export interface SizeInfo {
  tables: number | null;
  booths: number | null;
  venue_sqft: number | null;
  players: number | null;
  reported_attendance: ReportedAttendance | null;
  first_year: number | null;
  edition: number | null;
}

export interface VendorTable {
  label: string;
  price: number | null;
  currency: string;
  notes: string | null;
}

export interface VendorInfo {
  tables: VendorTable[];
  application_url: string | null;
  opens: string | null;
  deadline: string | null;
  status: VendorStatus;
  electricity: string | null;
  setup: string | null;
  contact: string | null;
  notes: string | null;
}

export interface Organizer {
  name: string | null;
  promoter_id: string | null;
  url: string | null;
}

export interface ShowLinks {
  official: string | null;
  tickets: string | null;
  facebook: string | null;
  instagram: string | null;
}

export interface SourceRef {
  source: string;
  url: string | null;
  retrieved: string | null;
  fields: string[];
}

export interface Estimate {
  attendance: { low: number; mid: number; high: number };
  basis: EstimateBasis;
  confidence: EstimateConfidence;
  size_class: SizeClass;
  traffic_per_table: number | null;
  explain: string;
}

/** One edition of a show, after normalizing (every optional part is present, with null or empty values). */
export interface Show {
  id: string;
  series_id: string;
  name: string;
  event_type: EventType;
  status: ShowStatus;
  days: ShowDay[];
  timezone: string | null;
  venue: Venue;
  sells: Sells;
  mix: Mix;
  admission: Admission;
  size: SizeInfo;
  vendor: VendorInfo;
  organizer: Organizer;
  links: ShowLinks;
  sources: SourceRef[];
  verification: Verification;
  first_seen: string | null;
  last_checked: string | null;
  summary: string | null;
  estimate: Estimate | null;
}

export interface SeriesRecord {
  id: string;
  name: string;
  promoter_id: string | null;
  venue: Partial<Venue> | null;
  cadence: string | null;
  editions: string[];
  links: Partial<ShowLinks> | null;
  history: { year?: number; attendance?: number; note?: string }[];
}

export interface PromoterRecord {
  id: string;
  name: string;
  url: string | null;
  region: string | null;
  series: string[];
  links: Partial<ShowLinks> | null;
  public_contact: string | null;
}

export interface ManifestSource {
  id: string;
  name: string;
  url: string | null;
  kind: string | null;
  credit: string | null;
}

export interface Manifest {
  built: string | null;
  fixture: boolean;
  counts: { shows: number; by_type: Record<string, number>; by_country: Record<string, number> } | null;
  sources: ManifestSource[];
}

/** A vocabulary entry: id, long name, short chip label. */
export interface VocabEntry {
  id: string;
  name: string;
  label: string;
}

export interface Vocab {
  tcg: VocabEntry[];
  sports: VocabEntry[];
  other: VocabEntry[];
}

export type VocabGroup = keyof Vocab;

/**
 * One compact row of the client index. Keys are short on purpose: the whole index is downloaded on
 * the first visit, so every byte counts on a slow connection.
 */
export interface IndexRow {
  /** id */
  i: string;
  /** name */
  n: string;
  /** event type */
  t: EventType;
  /** first day, YYYY-MM-DD */
  d: string;
  /** last day, only when different from the first */
  e?: string;
  /** every day, only when the show's days are not an unbroken run from d to e */
  ds?: string[];
  /** city */
  c: string;
  /** state or province code */
  r: string;
  /** country code */
  k: string;
  /** [lat, lon] to 4 decimals; missing when the venue has no coordinates */
  ll?: [number, number];
  /** geo precision, only when it is not "address" */
  g?: GeoPrecision;
  /** status, only when it is not "scheduled" */
  st?: ShowStatus;
  /** size class */
  sz?: SizeClass;
  /** expected attendance (typical value) */
  at?: number;
  /** everything sold, as vocabulary ids */
  sl?: string[];
  /** mix, only when not "unknown" */
  mx?: Mix;
  /** 1 when entry is free */
  fr?: 1;
  /** adult entry price */
  ad?: number;
  /** currency, only when not USD */
  cu?: string;
  /** vendor status, present when any vendor information is known */
  vs?: VendorStatus;
  /** lowest table price */
  vp?: number;
  /** vendor application deadline */
  vd?: string;
  /** verification: o organizer_confirmed, l listed, c community, u unverified */
  vf: 'o' | 'l' | 'c' | 'u';
  /** official link; only on store event rows, which have no page of their own */
  u?: string;
}

export interface IndexFile {
  v: 1;
  generated: string;
  fixture: boolean;
  count: number;
  vocab: Vocab;
  rows: IndexRow[];
}
