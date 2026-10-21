/**
 * Public input types for the planner.
 *
 * `PlannerShow` is a compact row derived from a DATA_MODEL show edition (see `toPlannerShow`).
 * `VendorSettings` matches the names the site stores in the browser (DESIGN 3.5).
 */

/** ISO 4217 code. In practice `USD` or `CAD`; kept open so other countries can be added. */
export type Currency = string;

export type EventType = 'card_show' | 'convention' | 'tournament' | 'pop_culture_con' | 'store_event';
export type SizeClass = 'small' | 'medium' | 'large' | 'major';
export type VendorStatus = 'open' | 'waitlist' | 'sold_out' | 'closed' | 'unknown';
export type ShowStatus = 'scheduled' | 'tentative' | 'postponed' | 'cancelled';
export type Confidence = 'reported' | 'estimated' | 'rough';

export interface LatLon {
  lat: number;
  lon: number;
}

/** A point with an optional name and IANA zone, used for start and end points. */
export interface Place extends LatLon {
  /** Short label such as "Home" or "Edison, NJ". */
  name?: string;
  /** IANA zone. When missing, the zone of the nearest show is used. */
  timezone?: string;
}

export interface PlannerShowDay {
  /** Local date, `YYYY-MM-DD`. */
  date: string;
  /** Local 24 hour time `HH:MM`, or null when unknown. */
  open: string | null;
  close: string | null;
}

export interface PlannerEstimate {
  attendance: { low: number; mid: number; high: number } | null;
  size_class: SizeClass | null;
  traffic_per_table: number | null;
  confidence: Confidence | null;
}

export interface PlannerVendorInfo {
  /** Cheapest listed table, in `currency`. */
  min_table_price: number | null;
  currency: Currency | null;
  /** Application deadline, `YYYY-MM-DD`. */
  deadline: string | null;
  status: VendorStatus | null;
  /** Local time vendors may start setting up on the first day, `HH:MM`. */
  setup?: string | null;
  /** Known extra fees per table (electricity and so on), in `currency`. */
  extras?: number | null;
}

export interface PlannerShow {
  id: string;
  series_id?: string | null;
  name: string;
  event_type: EventType;
  status?: ShowStatus | null;
  days: PlannerShowDay[];
  /** IANA zone of the venue. */
  timezone: string;
  lat: number;
  lon: number;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  /** Flat list of vocabulary ids (tcg, sports and other combined). Empty means unknown. */
  sells: string[];
  estimate: PlannerEstimate | null;
  size: { tables: number | null } | null;
  vendor: PlannerVendorInfo | null;
  admission: { free: boolean | null; adult: number | null; currency: Currency | null } | null;
}

export interface TypicalSales {
  small: number;
  medium: number;
  large: number;
  major: number;
}

export interface SeriesHistory {
  /** Gross sales at past editions, in the vendor's currency. */
  gross_sales: number[];
  /** 1 to 5 "would do again". */
  rating?: number | null;
}

export interface FuelPrice {
  amount: number;
  unit: 'gallon' | 'litre';
  /** Defaults to the vendor currency. */
  currency?: Currency;
}

export interface VendorSettings {
  home: Place | null;
  /** Currency of hotel, food, typical sales and history. Defaults to USD. */
  currency?: Currency;
  /** Give one of `mpg` (US gallons) or `l_per_100km`. */
  mpg?: number | null;
  l_per_100km?: number | null;
  fuel_price: FuelPrice | null;
  hotel_per_night: number;
  food_per_day: number;
  max_drive_hours_per_day: number;
  /** Typical gross sales by show size. Null when the vendor has not filled it in. */
  typical_sales: TypicalSales | null;
  /** Margin on sales, 0 to 100. */
  margin_percent: number;
  /** Vocabulary ids the vendor sells. */
  sells: string[];
  /** The vendor's own extra cost per show (extra badge, parking), in the vendor currency. */
  extras_per_show?: number;
  /** Own history keyed by `series_id`. */
  history?: Record<string, SeriesHistory>;
}

/**
 * Exchange rates the user typed in. Key `FROM_TO`, value is how many TO for one FROM.
 * Example: `{ "CAD_USD": 0.73 }`. The inverse direction is derived automatically.
 */
export type ExchangeRates = Record<string, number>;

/** Timing rules for vending and shopping. All times are local to the show. */
export interface PlanningRules {
  /** Arrive this long before opening on the first day when no setup time is listed. Default 90. */
  setupLeadMinutes: number;
  /** Arrive this long before opening on later days of a multi day show. Default 30. */
  laterDayLeadMinutes: number;
  /** Teardown after closing on the last day. Default 60. */
  teardownMinutes: number;
  /** No driving before this local time. Default 05:00. */
  earliestDrive: string;
  /** No driving after this local time. Default 23:00. */
  latestDrive: string;
  /** Assumed opening time when a show lists none. Default 09:00. */
  defaultOpen: string;
  /** Assumed closing time when a show lists none. Default 17:00. */
  defaultClose: string;
  /** Shopping: earliest departure each morning. Default 08:00. */
  shoppingDayStart: string;
}

export const DEFAULT_RULES: PlanningRules = {
  setupLeadMinutes: 90,
  laterDayLeadMinutes: 30,
  teardownMinutes: 60,
  earliestDrive: '05:00',
  latestDrive: '23:00',
  defaultOpen: '09:00',
  defaultClose: '17:00',
  shoppingDayStart: '08:00',
};

/** Error with a stable code and a plain language message. */
export class PlannerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'PlannerError';
  }
}
