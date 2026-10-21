/**
 * Profit estimate (DESIGN 7).
 *
 *   expected gross sales = typical sales for the show's size class
 *                          blended with the vendor's own past results at this series
 *                          and adjusted for traffic per table
 *   contribution         = expected gross sales x margin on sales
 *   costs                = table fee + extras + fuel + hotel nights + food per day away
 *   estimated profit     = contribution minus costs
 *
 * The low to high range comes from the show's attendance range. Every amount carries a currency;
 * amounts in another currency are converted only with a rate the user entered, and each
 * conversion is listed. When a rate is missing the totals stay split by currency.
 */
import { convert, MoneyBag, rateFor, type Conversion, type Money } from './money.js';
import { formatDistance, formatDuration, formatMoney, formatNumber } from './format.js';
import type { Currency, ExchangeRates, PlannerShow, SizeClass, VendorSettings } from './types.js';
import { PlannerError } from './types.js';
import { matchSells } from './vocab.js';

const LITRES_PER_GALLON = 3.785411784;
const KM_PER_MILE = 1.609344;

export interface ProfitModel {
  /** Visitors per table that count as a normal room. Default 6. */
  trafficReference: number;
  /** How strongly sales follow traffic per table (square root by default). */
  trafficExponent: number;
  /** Bounds on the traffic adjustment. Defaults 0.6 and 1.5. */
  trafficMin: number;
  trafficMax: number;
  /** Sales grow with attendance to this power when reading the low and high ends. Default 0.7. */
  attendanceElasticity: number;
  /** Spread used when a show has no attendance range. Default 0.4 (40 percent each way). */
  roughSpread: number;
  /** Own history weight is n / (n + historyPrior). Default 1, so one past show counts half. */
  historyPrior: number;
  /** Assumed cheapest table when a show lists no price, in the show's currency. */
  assumedTablePrice: Record<SizeClass, number>;
  /**
   * Sales when nothing the vendor sells is sold at the show, as a share of normal. Sales scale
   * from this floor up to 1 with how well the show matches. Unknown counts as a full match.
   * Not part of the DESIGN 7 formula; set to 1 to turn it off. Default 0.5.
   */
  matchFloor: number;
}

export const DEFAULT_PROFIT_MODEL: ProfitModel = {
  trafficReference: 6,
  trafficExponent: 0.5,
  trafficMin: 0.6,
  trafficMax: 1.5,
  attendanceElasticity: 0.7,
  roughSpread: 0.4,
  historyPrior: 1,
  assumedTablePrice: { small: 50, medium: 100, large: 175, major: 350 },
  matchFloor: 0.5,
};

const resolvedModels = new WeakSet<object>();

export function resolveProfitModel(partial?: Partial<ProfitModel> | null): ProfitModel {
  if (partial && resolvedModels.has(partial)) return partial as ProfitModel;
  const m: ProfitModel = {
    ...DEFAULT_PROFIT_MODEL,
    ...(partial ?? {}),
    assumedTablePrice: { ...DEFAULT_PROFIT_MODEL.assumedTablePrice, ...(partial?.assumedTablePrice ?? {}) },
  };
  resolvedModels.add(m);
  return m;
}

export interface Range {
  low: number;
  mid: number;
  high: number;
}

const SIZE_WORDS: Record<SizeClass, string> = { small: 'small', medium: 'medium', large: 'large', major: 'major' };

/** Size class from the estimate, else from attendance or tables. `assumed` when nothing is known. */
export function resolveSizeClass(show: PlannerShow): { sizeClass: SizeClass; assumed: boolean; how: string } {
  const e = show.estimate;
  if (e?.size_class) return { sizeClass: e.size_class, assumed: false, how: 'estimate' };
  const mid = e?.attendance?.mid;
  if (typeof mid === 'number' && mid > 0) {
    const sizeClass: SizeClass = mid < 500 ? 'small' : mid < 2000 ? 'medium' : mid < 8000 ? 'large' : 'major';
    return { sizeClass, assumed: false, how: 'attendance' };
  }
  const tables = show.size?.tables;
  if (typeof tables === 'number' && tables > 0) {
    const sizeClass: SizeClass = tables < 30 ? 'small' : tables < 100 ? 'medium' : tables < 300 ? 'large' : 'major';
    return { sizeClass, assumed: false, how: 'tables' };
  }
  return { sizeClass: 'medium', assumed: true, how: 'assumed' };
}

/** Currency the show's prices are listed in. */
export function showCurrency(show: PlannerShow, fallback: Currency): Currency {
  if (show.vendor?.currency) return show.vendor.currency;
  if (show.admission?.currency) return show.admission.currency;
  if (show.country === 'CA') return 'CAD';
  if (show.country === 'US') return 'USD';
  return fallback;
}

export function vendorCurrency(settings: VendorSettings): Currency {
  return settings.currency ?? 'USD';
}

export interface SalesEstimate {
  low: number;
  mid: number;
  high: number;
  currency: Currency;
  sizeClass: SizeClass;
  sizeAssumed: boolean;
  /** Typical sales for this size class, from the vendor settings. */
  typical: number;
  trafficFactor: number;
  /** Adjustment for how well what is sold matches what the vendor sells. */
  matchFactor: number;
  /** Average of the vendor's own gross sales at this series, when known. */
  historyAverage: number | null;
  historyCount: number;
  /** Weight given to own history, 0 to 1. */
  historyWeight: number;
  rangeFrom: 'attendance' | 'rough';
  explain: string[];
}

/** Expected gross sales, or null when the vendor has not filled in typical sales. */
export function estimateSales(
  show: PlannerShow,
  settings: VendorSettings,
  modelIn?: Partial<ProfitModel> | null,
  withExplain = true,
): SalesEstimate | null {
  const ts = settings.typical_sales;
  if (!ts) return null;
  const model = resolveProfitModel(modelIn);
  const currency = vendorCurrency(settings);
  const { sizeClass, assumed } = resolveSizeClass(show);
  const typical = Math.max(0, ts[sizeClass] ?? 0);
  const explain: string[] = [];
  const say = withExplain;
  if (say) explain.push(
    assumed
      ? `Show size is not known, so your typical sales at a medium show (${formatMoney(typical, currency)}) are used.`
      : `Your typical sales at a ${SIZE_WORDS[sizeClass]} show: ${formatMoney(typical, currency)}.`,
  );

  const tpt = show.estimate?.traffic_per_table;
  let trafficFactor = 1;
  if (typeof tpt === 'number' && tpt > 0) {
    trafficFactor = Math.min(
      model.trafficMax,
      Math.max(model.trafficMin, (tpt / model.trafficReference) ** model.trafficExponent),
    );
    if (Math.abs(trafficFactor - 1) >= 0.05) {
      if (say) explain.push(
        `About ${formatNumber(tpt, tpt < 10 ? 1 : 0)} visitors per table, so sales are adjusted ${trafficFactor > 1 ? 'up' : 'down'} ${Math.round(Math.abs(trafficFactor - 1) * 100)} percent.`,
      );
    }
  }

  let matchFactor = 1;
  const ms = matchSells(settings.sells ?? [], show.sells ?? []);
  if (ms.known) {
    const floor = Math.max(0, Math.min(1, model.matchFloor));
    matchFactor = floor + (1 - floor) * ms.score;
    if (matchFactor < 0.95) {
      if (say) explain.push(
        ms.matched.length === 0
          ? `Little of what you sell is listed here, so sales are cut ${Math.round((1 - matchFactor) * 100)} percent.`
          : `Only part of what you sell is listed here, so sales are cut ${Math.round((1 - matchFactor) * 100)} percent.`,
      );
    }
  }

  const hist = show.series_id ? settings.history?.[show.series_id] : undefined;
  const past = (hist?.gross_sales ?? []).filter((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0);
  let historyAverage: number | null = null;
  let historyWeight = 0;
  let mid = typical * trafficFactor * matchFactor;
  if (past.length > 0) {
    historyAverage = past.reduce((s, x) => s + x, 0) / past.length;
    historyWeight = past.length / (past.length + model.historyPrior);
    mid = (1 - historyWeight) * typical * trafficFactor * matchFactor + historyWeight * historyAverage;
    if (say) explain.push(
      `You averaged ${formatMoney(historyAverage, currency)} here over ${past.length} ${past.length === 1 ? 'show' : 'shows'}, which counts ${Math.round(historyWeight * 100)} percent.`,
    );
  }

  const att = show.estimate?.attendance;
  let low: number;
  let high: number;
  let rangeFrom: 'attendance' | 'rough';
  if (att && att.mid > 0 && att.low >= 0 && att.high >= att.mid && att.low <= att.mid) {
    const e = model.attendanceElasticity;
    low = mid * (att.low / att.mid) ** e;
    high = mid * (att.high / att.mid) ** e;
    rangeFrom = 'attendance';
    if (say) explain.push(
      `Range follows the expected crowd of ${formatNumber(att.low)} to ${formatNumber(att.high)} people.`,
    );
  } else {
    low = mid * (1 - model.roughSpread);
    high = mid * (1 + model.roughSpread);
    rangeFrom = 'rough';
    if (say) explain.push('Crowd size is a rough guess, so the range is wide.');
  }
  return {
    low,
    mid,
    high,
    currency,
    sizeClass,
    sizeAssumed: assumed,
    typical,
    trafficFactor,
    matchFactor,
    historyAverage,
    historyCount: past.length,
    historyWeight,
    rangeFrom,
    explain,
  };
}

export type CostKind = 'table' | 'extras' | 'fuel' | 'hotel' | 'food' | 'admission' | 'time';

export interface CostLine {
  kind: CostKind;
  /** "Table fee", "Fuel". */
  label: string;
  /** In `currency`, which is the vendor currency unless `converted` is false. */
  amount: number;
  currency: Currency;
  /** The amount as listed, when it was converted. */
  original?: Money;
  /** False when the line is in another currency and no rate was given. */
  converted: boolean;
  /** "312 miles at 25 mpg, 3.40 USD a gallon". */
  detail: string;
  /** True when the number is an assumption (for example a table price that is not listed). */
  assumed: boolean;
}

/** Adds lines, converting to the vendor currency where a rate exists and recording conversions. */
export class CostSheet {
  readonly lines: CostLine[] = [];
  readonly conversions: string[] = [];
  private readonly seen = new Set<string>();

  constructor(
    readonly currency: Currency,
    private readonly rates: ExchangeRates | null | undefined,
  ) {}

  add(kind: CostKind, label: string, amount: number, currency: Currency, detail: string, assumed = false): CostLine {
    let line: CostLine;
    if (currency === this.currency) {
      line = { kind, label, amount, currency, converted: true, detail, assumed };
    } else {
      const conv: Conversion | null = convert(amount, currency, this.currency, this.rates);
      if (conv) {
        line = {
          kind,
          label,
          amount: conv.to.amount,
          currency: this.currency,
          original: { amount, currency },
          converted: true,
          detail,
          assumed,
        };
        if (!this.seen.has(conv.note)) {
          this.seen.add(conv.note);
          this.conversions.push(conv.note);
        }
      } else {
        line = { kind, label, amount, currency, converted: false, detail, assumed };
      }
    }
    this.lines.push(line);
    return line;
  }

  /** Total in the vendor currency, or null when a line could not be converted. */
  total(): number | null {
    let t = 0;
    for (const l of this.lines) {
      if (!l.converted) return null;
      t += l.amount;
    }
    return t;
  }

  byCurrency(): Record<Currency, number> {
    const bag = new MoneyBag();
    for (const l of this.lines) bag.add(l.amount, l.currency);
    return bag.toObject();
  }

  /** Merges lines of the same kind and label into one (used for plan totals). */
  summarized(): CostLine[] {
    const map = new Map<string, CostLine>();
    for (const l of this.lines) {
      const key = `${l.kind}|${l.currency}|${l.converted}`;
      const prev = map.get(key);
      if (!prev) {
        map.set(key, { ...l, original: l.original ? { ...l.original } : undefined });
      } else {
        prev.amount += l.amount;
        prev.assumed = prev.assumed || l.assumed;
        if (prev.original && l.original && prev.original.currency === l.original.currency) {
          prev.original.amount += l.original.amount;
        } else {
          prev.original = undefined;
        }
        prev.detail = '';
      }
    }
    return [...map.values()];
  }
}

export interface FuelCost {
  /** Cost per road mile in the vendor currency. */
  perMile: number;
  currency: Currency;
  conversion: string | null;
  /** "25 mpg, 3.40 USD a gallon". */
  describe: string;
}

/** Fuel cost per mile from the vendor settings. Throws a plain error when something is missing. */
export function fuelCostPerMile(settings: VendorSettings, rates?: ExchangeRates | null): FuelCost {
  const currency = vendorCurrency(settings);
  const fp = settings.fuel_price;
  if (!fp || !(fp.amount >= 0)) throw new PlannerError('no_fuel_price', 'Add a fuel price in your settings.');
  const mpg = settings.mpg ?? null;
  const lp = settings.l_per_100km ?? null;
  let costPerMileInFuelCurrency: number;
  let use: string;
  const perUnit = `${formatMoney(fp.amount, fp.currency ?? currency)} a ${fp.unit === 'gallon' ? 'gallon' : 'litre'}`;
  if (typeof mpg === 'number' && mpg > 0) {
    const perGallon = fp.unit === 'gallon' ? fp.amount : fp.amount * LITRES_PER_GALLON;
    costPerMileInFuelCurrency = perGallon / mpg;
    use = `${formatNumber(mpg, mpg % 1 ? 1 : 0)} mpg`;
  } else if (typeof lp === 'number' && lp > 0) {
    const perLitre = fp.unit === 'litre' ? fp.amount : fp.amount / LITRES_PER_GALLON;
    costPerMileInFuelCurrency = (lp / 100) * KM_PER_MILE * perLitre;
    use = `${formatNumber(lp, lp % 1 ? 1 : 0)} L/100 km`;
  } else {
    throw new PlannerError('no_fuel_use', 'Add your miles per gallon or litres per 100 km in your settings.');
  }
  const fuelCurrency = fp.currency ?? currency;
  const rate = rateFor(fuelCurrency, currency, rates);
  if (rate === null) {
    throw new PlannerError(
      'fuel_currency',
      `Fuel price is in ${fuelCurrency} and your other amounts are in ${currency}. Enter an exchange rate or use one currency.`,
    );
  }
  const conv = fuelCurrency === currency ? null : convert(1, fuelCurrency, currency, rates);
  return {
    perMile: costPerMileInFuelCurrency * rate,
    currency,
    conversion: conv ? `Fuel price converted from ${fuelCurrency} to ${currency} at the rate you entered.` : null,
    describe: `${use}, ${perUnit}`,
  };
}

export interface TableCost {
  amount: number;
  currency: Currency;
  assumed: boolean;
}

/** Cheapest table fee as listed, or the assumed price for the size class. */
export function tableCost(show: PlannerShow, settings: VendorSettings, modelIn?: Partial<ProfitModel> | null): TableCost {
  const model = resolveProfitModel(modelIn);
  const currency = showCurrency(show, vendorCurrency(settings));
  const price = show.vendor?.min_table_price;
  if (typeof price === 'number' && price >= 0) return { amount: price, currency, assumed: false };
  const { sizeClass } = resolveSizeClass(show);
  return { amount: model.assumedTablePrice[sizeClass], currency, assumed: true };
}

/**
 * Table fee plus extras for one show in the vendor currency, the same sum `addShowCosts` puts on
 * a sheet, without building the lines. Null when a rate is missing.
 */
export function showFixedCost(
  show: PlannerShow,
  settings: VendorSettings,
  rates: ExchangeRates | null | undefined,
  modelIn?: Partial<ProfitModel> | null,
): number | null {
  const vc = vendorCurrency(settings);
  const t = tableCost(show, settings, modelIn);
  const rate = rateFor(t.currency, vc, rates);
  const extras = show.vendor?.extras;
  const listed = t.amount + (typeof extras === 'number' && extras > 0 ? extras : 0);
  if (rate === null) return null;
  const own = settings.extras_per_show ?? 0;
  return listed * rate + (own > 0 ? own : 0);
}

/** Travel inputs for the cost lines. */
export interface TripCosts {
  miles: number;
  hotelNights: number;
  foodDays: number;
  /** Hours behind the wheel; priced only when the vendor gave their time a value. */
  driveHours?: number;
  /** "Home, Edison and back". */
  describe?: string;
}

/** Adds table and extras lines for one show to a sheet. */
export function addShowCosts(
  sheet: CostSheet,
  show: PlannerShow,
  settings: VendorSettings,
  modelIn?: Partial<ProfitModel> | null,
  withName = false,
): void {
  const t = tableCost(show, settings, modelIn);
  const suffix = withName ? `: ${show.name}` : '';
  sheet.add(
    'table',
    `Table fee${suffix}`,
    t.amount,
    t.currency,
    t.assumed ? `Price not listed, assumed ${formatMoney(t.amount, t.currency)}` : `Cheapest listed table, ${formatMoney(t.amount, t.currency)}`,
    t.assumed,
  );
  const extras = show.vendor?.extras;
  if (typeof extras === 'number' && extras > 0) {
    sheet.add('extras', `Extras${suffix}`, extras, t.currency, 'Listed extra fees such as electricity');
  }
  const own = settings.extras_per_show ?? 0;
  if (own > 0) {
    sheet.add('extras', `Your extras${suffix}`, own, vendorCurrency(settings), 'Your own extra cost per show');
  }
}

/** Adds fuel, hotel and food lines to a sheet. */
export function addTripCosts(
  sheet: CostSheet,
  trip: TripCosts,
  settings: VendorSettings,
  fuel: FuelCost,
): void {
  const currency = vendorCurrency(settings);
  sheet.add('fuel', 'Fuel', trip.miles * fuel.perMile, currency, `${formatDistance(trip.miles)} at ${fuel.describe}`);
  if (fuel.conversion && !sheet.conversions.includes(fuel.conversion)) sheet.conversions.push(fuel.conversion);
  if (trip.hotelNights > 0) {
    sheet.add(
      'hotel',
      'Hotel',
      trip.hotelNights * settings.hotel_per_night,
      currency,
      `${trip.hotelNights} ${trip.hotelNights === 1 ? 'night' : 'nights'} at ${formatMoney(settings.hotel_per_night, currency)}`,
    );
  }
  if (trip.foodDays > 0) {
    sheet.add(
      'food',
      'Food',
      trip.foodDays * settings.food_per_day,
      currency,
      `${trip.foodDays} ${trip.foodDays === 1 ? 'day' : 'days'} at ${formatMoney(settings.food_per_day, currency)}`,
    );
  }
  const rate = settings.time_value_per_hour ?? 0;
  if (rate > 0 && (trip.driveHours ?? 0) > 0) {
    sheet.add(
      'time',
      'Your time driving',
      (trip.driveHours ?? 0) * rate,
      currency,
      `${formatDuration(trip.driveHours ?? 0)} at ${formatMoney(rate, currency)} an hour`,
    );
  }
}

export interface ProfitEstimate {
  currency: Currency;
  /** Null when typical sales are not set. */
  sales: SalesEstimate | null;
  marginPercent: number;
  /** Sales times margin. */
  contribution: Range | null;
  costs: CostLine[];
  /** In the vendor currency; null when a cost could not be converted. */
  totalCost: number | null;
  costsByCurrency: Record<Currency, number>;
  /** Null when sales are not set or a cost could not be converted. */
  profit: Range | null;
  conversions: string[];
  notes: string[];
  /** "Expected profit about 420 USD (180 to 650)". */
  label: string;
}

/** Builds the itemized estimate from sales and a cost sheet. */
export function finishEstimate(
  sales: SalesEstimate | null,
  sheet: CostSheet,
  settings: VendorSettings,
  extraNotes: string[] = [],
): ProfitEstimate {
  const currency = vendorCurrency(settings);
  const margin = Math.max(0, Math.min(100, settings.margin_percent)) / 100;
  const contribution: Range | null = sales
    ? { low: sales.low * margin, mid: sales.mid * margin, high: sales.high * margin }
    : null;
  const totalCost = sheet.total();
  const profit: Range | null =
    contribution && totalCost !== null
      ? { low: contribution.low - totalCost, mid: contribution.mid - totalCost, high: contribution.high - totalCost }
      : null;
  const notes = ['This is an estimate with a range, not a promise.', ...extraNotes];
  const unconverted = sheet.lines.filter((l) => !l.converted).map((l) => l.currency);
  if (unconverted.length > 0) {
    const cur = [...new Set(unconverted)].join(' and ');
    notes.push(`Some costs are in ${cur}. Enter an exchange rate to see one total.`);
  }
  if (!sales) notes.push('Add your typical sales in settings to see expected profit.');
  return {
    currency,
    sales,
    marginPercent: margin * 100,
    contribution,
    costs: sheet.lines,
    totalCost,
    costsByCurrency: sheet.byCurrency(),
    profit,
    conversions: sheet.conversions,
    notes,
    label: profitLabel(profit, totalCost, currency),
  };
}

/** Whole units, rounding at cents first so a label agrees with a table that shows cents rounded away. */
function whole(x: number): number {
  return Math.round(Math.round(x * 100) / 100);
}

export function profitLabel(profit: Range | null, totalCost: number | null, currency: Currency): string {
  if (profit) {
    const head =
      whole(profit.mid) >= 0
        ? `Expected profit about ${formatMoney(whole(profit.mid), currency)}`
        : `Expected loss about ${formatMoney(whole(-profit.mid), currency)}`;
    return `${head} (${rangeWords(profit)})`;
  }
  if (totalCost !== null) return `Costs about ${formatMoney(whole(totalCost), currency)}`;
  return 'Costs are in more than one currency';
}

/** "180 to 650", "a loss of 50 up to a profit of 650", "a loss of 300 to 40". */
export function rangeWords(r: Range): string {
  const lo = Math.round(r.low);
  const hi = Math.round(r.high);
  if (lo >= 0) return `${formatNumber(lo)} to ${formatNumber(hi)}`;
  if (hi >= 0) return `a loss of ${formatNumber(-lo)} up to a profit of ${formatNumber(hi)}`;
  return `a loss of ${formatNumber(-lo)} to ${formatNumber(-hi)}`;
}
