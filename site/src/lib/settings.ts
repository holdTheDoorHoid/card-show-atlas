// Vendor settings, saved in the browser (My shows page) and read later by the route planner.
// Keep the field names stable: the planner depends on them.

export type FuelEconomyUnit = 'mpg' | 'l_per_100km';

export interface HomeBase {
  /** US ZIP code or Canadian postal code as typed, "" when not set */
  postal: string;
  /** coordinates of the home base; set from the postal code lookup, or entered directly */
  lat: number | null;
  lon: number | null;
  /** US or Canada, from the postal code. null when only coordinates were given. */
  country: 'US' | 'CA' | null;
}

export interface TypicalSales {
  small: number | null;
  medium: number | null;
  large: number | null;
  major: number | null;
}

export interface VendorSettings {
  version: 1;
  /** where trips start and end */
  home: HomeBase;
  /** "mpg" (miles per US gallon) or "l_per_100km" (litres per 100 kilometres) */
  fuelEconomyUnit: FuelEconomyUnit;
  /** the vehicle's fuel economy, in the unit above */
  fuelEconomy: number | null;
  /** fuel price per US gallon when the unit is mpg, per litre when it is l_per_100km */
  fuelPrice: number | null;
  /** hotel price per night */
  hotelPerNight: number | null;
  /** food money per day */
  foodPerDay: number | null;
  /** the most hours to drive in one day */
  maxDrivingHoursPerDay: number;
  /** typical gross sales (dollars) at a small, medium, large and major show */
  typicalSales: TypicalSales;
  /** margin on sales, in percent (a card sold for $10 that cost $6 is 40) */
  marginPercent: number | null;
  /** what I sell: vocabulary ids from data/vocab.json */
  sells: string[];
}

export const DEFAULT_VENDOR_SETTINGS: VendorSettings = {
  version: 1,
  home: { postal: '', lat: null, lon: null, country: null },
  fuelEconomyUnit: 'mpg',
  fuelEconomy: null,
  fuelPrice: null,
  hotelPerNight: null,
  foodPerDay: null,
  maxDrivingHoursPerDay: 8,
  typicalSales: { small: null, medium: null, large: null, major: null },
  marginPercent: null,
  sells: [],
};

export const MAX_DRIVING_HOURS_LIMITS = { min: 1, max: 16 } as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function nonNegative(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

function positive(v: unknown): number | null {
  const n = nonNegative(v);
  return n !== null && n > 0 ? n : null;
}

/** Make any saved value into valid settings, falling back to the defaults for what is missing or wrong. */
export function normalizeSettings(raw: unknown): VendorSettings {
  const d = DEFAULT_VENDOR_SETTINGS;
  if (!isObj(raw)) return structuredCloneSettings(d);
  const home = isObj(raw.home) ? raw.home : {};
  const lat = typeof home.lat === 'number' && Math.abs(home.lat) <= 90 ? home.lat : null;
  const lon = typeof home.lon === 'number' && Math.abs(home.lon) <= 180 ? home.lon : null;
  const hasPoint = lat !== null && lon !== null;
  const sales = isObj(raw.typicalSales) ? raw.typicalSales : {};
  const hours = nonNegative(raw.maxDrivingHoursPerDay);
  const margin = nonNegative(raw.marginPercent);
  return {
    version: 1,
    home: {
      postal: typeof home.postal === 'string' ? home.postal.trim().slice(0, 12) : '',
      lat: hasPoint ? lat : null,
      lon: hasPoint ? lon : null,
      country: home.country === 'US' || home.country === 'CA' ? home.country : null,
    },
    fuelEconomyUnit: raw.fuelEconomyUnit === 'l_per_100km' ? 'l_per_100km' : 'mpg',
    fuelEconomy: positive(raw.fuelEconomy),
    fuelPrice: nonNegative(raw.fuelPrice),
    hotelPerNight: nonNegative(raw.hotelPerNight),
    foodPerDay: nonNegative(raw.foodPerDay),
    maxDrivingHoursPerDay:
      hours === null ? d.maxDrivingHoursPerDay : Math.min(MAX_DRIVING_HOURS_LIMITS.max, Math.max(MAX_DRIVING_HOURS_LIMITS.min, hours)),
    typicalSales: {
      small: nonNegative(sales.small),
      medium: nonNegative(sales.medium),
      large: nonNegative(sales.large),
      major: nonNegative(sales.major),
    },
    marginPercent: margin === null ? null : Math.min(100, margin),
    sells: Array.isArray(raw.sells) ? raw.sells.filter((x): x is string => typeof x === 'string' && x !== '').slice(0, 60) : [],
  };
}

function structuredCloneSettings(s: VendorSettings): VendorSettings {
  return { ...s, home: { ...s.home }, typicalSales: { ...s.typicalSales }, sells: [...s.sells] };
}

const KM_PER_MILE = 1.609344;

/** Fuel cost of driving one mile, or null when fuel economy or price is missing. */
export function fuelCostPerMile(s: VendorSettings): number | null {
  if (s.fuelEconomy === null || s.fuelPrice === null) return null;
  if (s.fuelEconomyUnit === 'mpg') return s.fuelPrice / s.fuelEconomy;
  // litres per 100 km: litres per mile = (L/100km / 100) * km per mile
  return (s.fuelEconomy / 100) * KM_PER_MILE * s.fuelPrice;
}

/** What is still missing before a profit estimate can be made, in plain words. */
export function missingForProfit(s: VendorSettings): string[] {
  const missing: string[] = [];
  if (s.home.lat === null || s.home.lon === null) missing.push('your home postal code');
  if (s.fuelEconomy === null) missing.push('your fuel economy');
  if (s.fuelPrice === null) missing.push('the fuel price');
  if (s.marginPercent === null) missing.push('your margin on sales');
  const t = s.typicalSales;
  if (t.small === null && t.medium === null && t.large === null && t.major === null) missing.push('typical sales at a show');
  return missing;
}
