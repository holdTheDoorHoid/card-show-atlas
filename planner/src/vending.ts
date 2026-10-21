/**
 * Vending route engine, shared by the weekend run (DESIGN 6.3) and the season planner (6.4).
 *
 * Model. A show is a block of days. You arrive by setup on the first day and leave after teardown
 * on the last day. Driving happens only before setup and after teardown, inside a daily window
 * (default 05:00 to 23:00 local), and the hours driven on one calendar day never exceed the cap.
 * Each night is spent at home (or the trip's start point) or in a hotel. A one day show couples
 * the two drives of its day: the morning drive in plus the evening drive out must fit the cap.
 *
 * Search. Shows are nodes of a DAG sorted by first day. A label is a partial plan ending at a show,
 * carrying (value, morning hours used on the last day, shows counted this month, nights away in a
 * row). Labels are extended along three kinds of moves: leave home for a show, drive straight from
 * one show to the next, go home after a show. "At home on night d" is a state per day, so going
 * home between shows is handled exactly. Labels that are worse on every count than another label
 * at the same show are dropped (dominance). Nothing else is pruned, so within the model the result
 * is optimal; the only limit is `maxChainGapDays` on straight drives between shows.
 */
import type { Candidate, Excluded } from './candidates.js';
import { closeness, pointsWithoutTravel, vendorFactors, type PriceContext, type VendorFactors, type Weights } from './factors.js';
import {
  formatClock,
  formatDateRange,
  formatDayLabel,
  formatDistance,
  formatDuration,
  formatLocalClock,
  formatShortDate,
  townLabel,
} from './format.js';
import {
  addShowCosts,
  addTripCosts,
  CostSheet,
  estimateSales,
  finishEstimate,
  fuelCostPerMile,
  showFixedCost,
  tableCost,
  vendorCurrency,
  type FuelCost,
  type ProfitEstimate,
  type ProfitModel,
  type Range,
  type SalesEstimate,
  type TableCost,
} from './profit.js';
import {
  dateFromEpochDay,
  epochDay,
  isValidTime,
  MS_PER_HOUR,
  monthIndex,
  parseTime,
  toZonedIso,
  zonedTimeToInstant,
} from './time.js';
import { cosLatitude, haversineCos, haversineMiles, latitudeGapMiles, roadMilesForHours, type Leg, type LegSource, type Travel } from './travel.js';
import type { ExchangeRates, LatLon, Place, PlannerShow, PlanningRules, VendorSettings, VendorStatus } from './types.js';
import { PlannerError } from './types.js';

const EPS = 1e-9;

export type Objective = 'profit' | 'score';
export type Overnight = 'stay' | 'home';
export type Variant = 'single' | 'hotel' | 'commute';

export interface VendingSetup {
  candidates: Candidate[];
  /** Every show the caller knows about, used only to name towns for nights on the road. */
  allShows: PlannerShow[];
  settings: VendorSettings;
  base: Place;
  end: Place;
  rangeStart: string;
  rangeEnd: string;
  /** Weekend run: all travel inside the dates. Season: shows inside, travel may spill over. */
  tripWithinRange: boolean;
  overnight: Overnight;
  /** Allow driving straight from one show to the next without going home. */
  chain: boolean;
  maxNightsAway: number | null;
  countCap: number | null;
  countReset: 'month' | 'never';
  blackout: string[];
  objective: Objective;
  rules: PlanningRules;
  travel: Travel;
  rates: ExchangeRates | null;
  profitModel: ProfitModel;
  weights: Weights;
  priceContext: PriceContext | null;
  labels?: Record<string, string>;
  maxChainGapDays: number;
  /** Days of travel allowed outside the range when `tripWithinRange` is false. */
  travelSlackDays: number;
  /** Score mode: points a show must beat to be worth adding. */
  minScore: number;
  travelHalfLifeHours: number;
  /**
   * What an hour of driving and a hotel night count against a plan, on top of money. Score mode:
   * points (from "how much do you mind driving"). Profit mode: the vendor's time value per hour, and
   * zero per night because the hotel is already money.
   */
  penalties: Penalties;
}

export interface Penalties {
  perDriveHour: number;
  perHotelNight: number;
}

/** A show prepared for planning. Instants are milliseconds since the epoch. */
export interface VNode {
  index: number;
  show: PlannerShow;
  flags: Candidate['flags'];
  zone: string;
  dates: string[];
  dayNums: number[];
  first: number;
  last: number;
  month: number;
  open: number[];
  close: number[];
  /** Arrive by: setup on day one, opening minus a short lead on later days. */
  arriveBy: number[];
  /** Leave at: closing, plus teardown on the last day. */
  leaveAt: number[];
  earliest: number[];
  latest: number[];
  /** Hours of driving possible before arriveBy on each day. */
  morningCap: number[];
  /** Hours of driving possible after leaveAt on each day. */
  eveningCap: number[];
  /** Profit mode: sales times margin minus table and extras. Score mode: points minus minScore. */
  valueBase: number;
  sales: SalesEstimate | null;
  table: TableCost;
  /** Score mode only (without reason strings). */
  factors: VendorFactors | null;
  warnings: string[];
}

interface InLabel {
  v: number;
  m: number;
  k: number;
  na: number;
  node: number;
  kind: 'depart' | 'direct';
  j: number;
  prevHome: HomeEntry | null;
  prevOut: OutLabel | null;
}

interface OutLabel {
  v: number;
  m: number;
  k: number;
  na: number;
  node: number;
  variant: Variant;
  inL: InLabel;
}

interface HomeEntry {
  v: number;
  k: number;
  day: number;
  from: OutLabel | null;
  j: number;
}

export type Step =
  | { t: 'depart'; node: number; j: number; m: number }
  | { t: 'show'; node: number; variant: Variant; mIn: number; mOut: number }
  | { t: 'direct'; from: number; to: number; n: number; mFrom: number; m: number }
  | { t: 'return'; node: number; j: number; mOut: number };

export interface SolveOptions {
  countCap?: number | null;
  /** Override the last day (used for "home a night early"). */
  rangeEnd?: string;
  overnight?: Overnight;
  /** Node indices to leave out. */
  skip?: Set<number>;
}

export interface VendingSolution {
  value: number;
  steps: Step[];
  stats: { nodes: number; labels: number; edges: number };
}

/** Every move says what it costs in money, driving hours and hotel nights, and the search's `loss`. */
export interface DepartOption {
  j: number;
  m: number;
  cost: number;
  gain: number;
  hours: number;
  nights: number;
  /** cost factor times cost, plus the driving and night penalties */
  loss: number;
}

export interface VariantOption {
  variant: Variant;
  m: number;
  /** Nights away after the show, given nights away before it. */
  na: number;
  cost: number;
  hours: number;
  nights: number;
  loss: number;
}

export interface MoveOption {
  j: number;
  m: number;
  cost: number;
  gain: number;
  hours: number;
  nights: number;
  loss: number;
}

/** Builds nodes once; `solve` can then be called many times with different limits. */
export class VendingEngine {
  readonly setup: VendingSetup;
  readonly nodes: VNode[];
  readonly excluded: Excluded[] = [];
  readonly warnings: string[] = [];
  readonly C: number;
  readonly F: number;
  readonly fuel: FuelCost;
  readonly hotel: number;
  readonly food: number;
  /** Profit mode counts every unit of cost; score mode only uses cost to break ties. */
  readonly costFactor: number;
  readonly perDriveHour: number;
  readonly perHotelNight: number;
  readonly sameBase: boolean;
  readonly rangeStartDay: number;
  readonly rangeEndDay: number;
  private readonly order: number[];
  private readonly firstSorted: number[];
  private readonly blackoutSet: Set<number>;
  private readonly legBaseCache: (Leg | undefined)[];
  private readonly legEndCache: (Leg | undefined)[];
  private readonly legHomeCache: (Leg | undefined)[];
  private readonly legPairCache = new Map<number, Leg>();

  constructor(setup: VendingSetup) {
    this.setup = setup;
    const s = setup.settings;
    if (!(s.max_drive_hours_per_day > 0)) {
      throw new PlannerError('bad_settings', 'Maximum driving hours per day must be above zero.');
    }
    this.C = s.max_drive_hours_per_day;
    const windowHours = (parseTime(setup.rules.latestDrive) - parseTime(setup.rules.earliestDrive)) / 60;
    if (!(windowHours > 0)) throw new PlannerError('bad_rules', 'The driving window must end after it starts.');
    this.F = Math.min(this.C, windowHours);
    this.fuel = fuelCostPerMile(s, setup.rates);
    this.hotel = Math.max(0, s.hotel_per_night);
    this.food = Math.max(0, s.food_per_day);
    this.costFactor = setup.objective === 'profit' ? 1 : 1e-5;
    this.perDriveHour = Math.max(0, setup.penalties?.perDriveHour ?? 0);
    this.perHotelNight = Math.max(0, setup.penalties?.perHotelNight ?? 0);
    this.sameBase = haversineMiles(setup.base, setup.end) < 0.05;
    this.rangeStartDay = epochDay(setup.rangeStart);
    this.rangeEndDay = epochDay(setup.rangeEnd);
    this.blackoutSet = new Set(setup.blackout.map(epochDay));

    const nodes: VNode[] = [];
    for (const c of setup.candidates) {
      const built = this.buildNode(c, nodes.length);
      if (typeof built === 'string') this.excluded.push({ id: c.show.id, name: c.show.name, reason: built });
      else nodes.push(built);
    }
    this.nodes = nodes;
    this.order = nodes
      .map((n) => n.index)
      .sort((a, b) => nodes[a]!.first - nodes[b]!.first || (nodes[a]!.show.id < nodes[b]!.show.id ? -1 : 1));
    this.firstSorted = this.order.map((i) => nodes[i]!.first);
    this.legBaseCache = new Array(nodes.length);
    this.legEndCache = new Array(nodes.length);
    this.legHomeCache = new Array(nodes.length);
  }

  private buildNode(c: Candidate, index: number): VNode | string {
    const { show } = c;
    const setup = this.setup;
    const rules = setup.rules;
    const zone = show.timezone;
    const dates = c.days.map((d) => d.date);
    const dayNums = dates.map(epochDay);
    const warnings: string[] = [];
    if (c.days.some((d) => !d.open || !d.close)) {
      warnings.push(
        `Hours not listed for ${show.name}, assumed ${formatLocalClock(rules.defaultOpen)} to ${formatLocalClock(rules.defaultClose)}.`,
      );
    }
    const open: number[] = [];
    const close: number[] = [];
    c.days.forEach((d, i) => {
      const o = zonedTimeToInstant(d.date, d.open ?? rules.defaultOpen, zone);
      let cl = zonedTimeToInstant(d.date, d.close ?? rules.defaultClose, zone);
      if (cl <= o) {
        cl = o + 4 * MS_PER_HOUR;
        if (i === 0) warnings.push(`Closing time for ${show.name} looks wrong, assumed 4 hours after opening.`);
      }
      open.push(o);
      close.push(cl);
    });
    const n = dates.length;
    const setupTime = show.vendor?.setup;
    const setupFirst =
      setupTime && isValidTime(setupTime)
        ? Math.min(zonedTimeToInstant(dates[0]!, setupTime, zone), open[0]!)
        : open[0]! - rules.setupLeadMinutes * 60_000;
    const arriveBy = open.map((o, i) => (i === 0 ? setupFirst : o - rules.laterDayLeadMinutes * 60_000));
    const leaveAt = close.map((cl, i) => (i === n - 1 ? cl + rules.teardownMinutes * 60_000 : cl));
    const earliest = dates.map((d) => zonedTimeToInstant(d, rules.earliestDrive, zone));
    const latest = dates.map((d) => zonedTimeToInstant(d, rules.latestDrive, zone));
    const clampH = (x: number) => Math.max(0, Math.min(this.C, x / MS_PER_HOUR));
    const morningCap = arriveBy.map((a, i) => clampH(a - earliest[i]!));
    const eveningCap = leaveAt.map((l, i) => clampH(latest[i]! - l));

    const settings = setup.settings;
    const table = tableCost(show, settings, setup.profitModel);
    const sales = estimateSales(show, settings, setup.profitModel, false);
    let valueBase: number;
    let factors: VendorFactors | null = null;
    if (setup.objective === 'profit') {
      if (!sales) return 'Add your typical sales to plan by profit';
      const total = showFixedCost(show, settings, setup.rates, setup.profitModel);
      if (total === null) return `Table price is in ${table.currency}. Add an exchange rate to include it.`;
      valueBase = (sales.mid * Math.max(0, Math.min(100, settings.margin_percent))) / 100 - total;
    } else {
      factors = vendorFactors(show, {
        settings,
        hours: null,
        priceContext: setup.priceContext,
        rates: setup.rates,
        labels: setup.labels,
        profitModel: setup.profitModel,
        travelHalfLifeHours: setup.travelHalfLifeHours,
        withReasons: false,
      });
      valueBase = pointsWithoutTravel(factors, setup.weights) - setup.minScore;
    }
    return {
      index,
      show,
      flags: c.flags,
      zone,
      dates,
      dayNums,
      first: dayNums[0]!,
      last: dayNums[n - 1]!,
      month: monthIndex(dates[0]!),
      open,
      close,
      arriveBy,
      leaveAt,
      earliest,
      latest,
      morningCap,
      eveningCap,
      valueBase,
      sales,
      table,
      factors,
      warnings,
    };
  }

  legBase(i: number): Leg {
    let l = this.legBaseCache[i];
    if (!l) {
      l = this.setup.travel.leg(this.setup.base, this.nodes[i]!.show);
      this.legBaseCache[i] = l;
    }
    return l;
  }

  legEnd(i: number): Leg {
    let l = this.legEndCache[i];
    if (!l) {
      l = this.setup.travel.leg(this.nodes[i]!.show, this.setup.end);
      this.legEndCache[i] = l;
    }
    return l;
  }

  /** Show back to the base (start point), used by commuting and by mid trip home nights. */
  legHome(i: number): Leg {
    let l = this.legHomeCache[i];
    if (!l) {
      l = this.setup.travel.leg(this.nodes[i]!.show, this.setup.base);
      this.legHomeCache[i] = l;
    }
    return l;
  }

  legPair(i: number, j: number): Leg {
    const key = i * this.nodes.length + j;
    let l = this.legPairCache.get(key);
    if (!l) {
      l = this.setup.travel.leg(this.nodes[i]!.show, this.nodes[j]!.show);
      this.legPairCache.set(key, l);
    }
    return l;
  }

  /** What a move counts against the plan in the search. */
  loss(cost: number, hours: number, nights: number): number {
    return this.costFactor * cost + this.perDriveHour * hours + this.perHotelNight * nights;
  }

  /** Score mode only: points for the travel factor of an arrival leg. */
  travelGain(hours: number): number {
    if (this.setup.objective !== 'score') return 0;
    return 100 * this.setup.weights.travel * closeness(hours, this.setup.travelHalfLifeHours);
  }

  isBlackout(day: number): boolean {
    return this.blackoutSet.has(day);
  }

  anyBlackout(fromDay: number, toDay: number): boolean {
    if (this.blackoutSet.size === 0 || toDay < fromDay) return false;
    for (let d = fromDay; d <= toDay; d++) if (this.blackoutSet.has(d)) return true;
    return false;
  }

  private readonly departCache: (DepartOption[] | undefined)[][] = [[], []];

  /** Ways to leave the base for show i: `j` nights on the road before day one, `m` morning hours on day one. */
  departOptions(i: number, homeOnly: boolean): DepartOption[] {
    const cache = this.departCache[homeOnly ? 1 : 0]!;
    let hit = cache[i];
    if (!hit) {
      hit = this.computeDepartOptions(i, homeOnly);
      cache[i] = hit;
    }
    return hit;
  }

  private computeDepartOptions(i: number, homeOnly: boolean): DepartOption[] {
    const T = this.nodes[i]!;
    const leg = this.legBase(i);
    const h = leg.hours;
    const M = T.morningCap[0]!;
    const gain = this.travelGain(h);
    const fuel = leg.miles * this.fuel.perMile;
    const out: DepartOption[] = [];
    if (h <= M + EPS) out.push({ j: 0, m: h, cost: fuel, gain, hours: h, nights: 0, loss: this.loss(fuel, h, 0) });
    if (homeOnly || h <= EPS) return out;
    const jFirst = Math.max(1, Math.ceil((h - M) / this.F - 1e-9));
    const jZero = Math.max(1, Math.ceil(h / this.F - 1e-9));
    for (let j = jFirst; j <= Math.max(jFirst, jZero); j++) {
      const cost = fuel + j * (this.hotel + this.food);
      out.push({ j, m: Math.max(0, h - j * this.F), cost, gain, hours: h, nights: j, loss: this.loss(cost, h, j) });
    }
    return out;
  }

  /** How the nights inside a multi day show are spent. */
  variantOptions(i: number, mIn: number, naIn: number, homeOnly: boolean, maxNights: number): VariantOption[] {
    const T = this.nodes[i]!;
    const nd = T.dates.length;
    if (nd === 1) return [{ variant: 'single', m: mIn, na: naIn, cost: this.food, hours: 0, nights: 0, loss: this.loss(this.food, 0, 0) }];
    const out: VariantOption[] = [];
    const nights = T.last - T.first;
    if (!homeOnly && naIn + nights <= maxNights && !this.anyBlackout(T.first, T.last)) {
      const cost = nights * this.hotel + (nights + 1) * this.food;
      out.push({ variant: 'hotel', m: 0, na: naIn + nights, cost, hours: 0, nights, loss: this.loss(cost, 0, nights) });
    }
    if (this.sameBase) {
      const back = this.legHome(i);
      const there = this.legBase(i);
      let ok = mIn + back.hours <= this.C + EPS && back.hours <= T.eveningCap[0]! + EPS;
      for (let d = 1; ok && d < nd; d++) ok = there.hours <= T.morningCap[d]! + EPS;
      for (let d = 1; ok && d < nd - 1; d++) {
        ok = there.hours + back.hours <= this.C + EPS && back.hours <= T.eveningCap[d]! + EPS;
      }
      if (ok) {
        const cost = (nd - 1) * (back.miles + there.miles) * this.fuel.perMile + nd * this.food;
        const hours = (nd - 1) * (back.hours + there.hours);
        out.push({ variant: 'commute', m: there.hours, na: 0, cost, hours, nights: 0, loss: this.loss(cost, hours, 0) });
      }
    }
    return out;
  }

  /** Going back to the end point after show i. */
  returnOption(i: number, mOut: number, homeOnly: boolean): MoveOption | null {
    const T = this.nodes[i]!;
    const leg = this.legEnd(i);
    const h = leg.hours;
    const E = Math.max(0, Math.min(T.eveningCap[T.eveningCap.length - 1]!, this.C - mOut));
    let j: number;
    if (h <= E + EPS) j = 0;
    else if (homeOnly) return null;
    else j = Math.ceil((h - E) / this.F - 1e-9);
    const cost = leg.miles * this.fuel.perMile + j * (this.hotel + this.food);
    return { j, m: 0, cost, gain: 0, hours: h, nights: j, loss: this.loss(cost, h, j) };
  }

  /** Driving straight from show i to show u. `j` is the number of nights in between. */
  directOption(i: number, u: number, mOut: number): MoveOption | null {
    const T = this.nodes[i]!;
    const U = this.nodes[u]!;
    const n = U.first - T.last;
    if (n < 1) return null;
    const leg = this.legPair(i, u);
    const h = leg.hours;
    const E = Math.max(0, Math.min(T.eveningCap[T.eveningCap.length - 1]!, this.C - mOut));
    const m = Math.max(0, h - E - (n - 1) * this.F);
    if (m > U.morningCap[0]! + EPS) return null;
    const cost = leg.miles * this.fuel.perMile + n * this.hotel + (n - 1) * this.food;
    return { j: n, m, cost, gain: this.travelGain(h), hours: h, nights: n, loss: this.loss(cost, h, n) };
  }

  solve(opts: SolveOptions = {}): VendingSolution {
    const s = this.setup;
    const overnight = opts.overnight ?? s.overnight;
    const homeOnly = overnight === 'home';
    if (homeOnly && !this.sameBase) {
      throw new PlannerError('home_needs_same_base', 'Coming home each night needs the trip to start and end at the same place.');
    }
    const chain = s.chain && !homeOnly;
    const capIn = opts.countCap === undefined ? s.countCap : opts.countCap;
    const capped = capIn !== null && Number.isFinite(capIn);
    const K = capped ? Math.max(0, Math.floor(capIn)) : 0;
    const maxN = s.maxNightsAway ?? Infinity;
    const rangeStart = this.rangeStartDay;
    const rangeEnd = opts.rangeEnd ? epochDay(opts.rangeEnd) : this.rangeEndDay;
    const slack = s.tripWithinRange ? 0 : s.travelSlackDays;
    const hStart = rangeStart - 1 - slack;
    const hEnd = rangeEnd + slack;
    const nDays = hEnd - hStart + 1;
    const skip = opts.skip ?? new Set<number>();
    const monthReset = capped && s.countReset === 'month';
    const monthOf: number[] = new Array(nDays);
    for (let d = 0; d < nDays; d++) monthOf[d] = monthIndex(dateFromEpochDay(hStart + d));
    const nodes = this.nodes;
    const usable = (i: number) => {
      const n = nodes[i]!;
      return !skip.has(i) && n.first >= rangeStart && n.last <= rangeEnd;
    };

    const init: HomeEntry = { v: 0, k: 0, day: hStart, from: null, j: 0 };
    const H: HomeEntry[][] = new Array(nDays);
    const arrivals: HomeEntry[][] = Array.from({ length: nDays }, () => []);
    const endEntries: HomeEntry[] = [];
    let fin = -1;
    const finalize = (rel: number) => {
      const upTo = Math.min(rel, nDays - 1);
      for (let d = fin + 1; d <= upTo; d++) {
        let list: HomeEntry[];
        if (d === 0) {
          list = [init];
        } else {
          const prev = H[d - 1]!;
          if (monthReset && monthOf[d] !== monthOf[d - 1]) {
            let best = prev[0]!;
            for (const e of prev) if (e.v > best.v + EPS) best = e;
            list = [{ ...best, k: 0 }];
          } else {
            list = prev.slice();
          }
        }
        const arr = arrivals[d]!;
        for (let x = 0; x < arr.length; x++) list.push(arr[x]!);
        H[d] = paretoHome(list);
      }
      if (upTo > fin) fin = upTo;
    };

    const incoming: InLabel[][] = nodes.map(() => []);
    let labelCount = 0;
    let edgeCount = 0;
    const G = Math.min(s.maxChainGapDays, maxN);
    const C = this.C;
    const F = this.F;
    const perMile = this.fuel.perMile;
    const viaHome = this.sameBase;
    const travel = s.travel;
    const scratch = { miles: 0, hours: 0 };
    const depart: DepartOption[][] = nodes.map((_, i) => (usable(i) ? this.departOptions(i, homeOnly) : []));
    // Pair drive times: the estimate from precomputed cosines (same numbers as travel.leg), or the
    // travel object when real drive times are loaded.
    const fast = !travel.hasKnown();
    const lat = nodes.map((nd) => nd.show.lat);
    const lon = nodes.map((nd) => nd.show.lon);
    const cosLat = lat.map(cosLatitude);
    const roadFactor = travel.model.roadFactor;

    for (const i of this.order) {
      if (!usable(i)) continue;
      const T = nodes[i]!;
      finalize(T.first - 1 - hStart);
      const ins = incoming[i]!;
      incoming[i] = [];

      const opts = depart[i]!;
      for (let oi = 0; oi < opts.length; oi++) {
        const opt = opts[oi]!;
        const j = opt.j;
        if (j > 0) {
          if (j > maxN) continue;
          if (s.tripWithinRange && T.first - j < rangeStart) continue;
          if (this.anyBlackout(T.first - j, T.first - 1)) continue;
        }
        const dRel = T.first - 1 - j - hStart;
        if (dRel < 0) continue;
        const homes = H[dRel]!;
        for (let hi = 0; hi < homes.length; hi++) {
          const e = homes[hi]!;
          let k = 0;
          if (capped) {
            k = !monthReset || monthOf[dRel] === T.month ? e.k + 1 : 1;
            if (k > K) continue;
          }
          insertIn(ins, e.v + opt.gain - opt.loss, opt.m, k, j, i, 'depart', j, e, null);
        }
      }
      if (ins.length === 0) continue;

      const outs: OutLabel[] = [];
      for (let li = 0; li < ins.length; li++) {
        const L = ins[li]!;
        const vos = this.variantOptions(i, L.m, L.na, homeOnly, maxN);
        for (let vi = 0; vi < vos.length; vi++) {
          const vo = vos[vi]!;
          insertOut(outs, L.v + T.valueBase - vo.loss, vo.m, L.k, vo.na, i, vo.variant, L);
        }
      }
      if (outs.length === 0) continue;
      labelCount += outs.length;

      const rets: (MoveOption | null)[] = new Array(outs.length);
      for (let li = 0; li < outs.length; li++) {
        const L = outs[li]!;
        const r = this.returnOption(i, L.m, homeOnly);
        rets[li] = null;
        if (!r) continue;
        const rDay = T.last + r.j;
        if (rDay > hEnd) continue;
        if (r.j > 0 && (L.na + r.j > maxN || this.anyBlackout(T.last + 1, rDay))) continue;
        rets[li] = r;
        const rRel = rDay - hStart;
        const kEff = monthReset && monthOf[rRel] !== T.month ? 0 : L.k;
        const entry: HomeEntry = { v: L.v - r.loss, k: kEff, day: rDay, from: L, j: r.j };
        if (viaHome) arrivals[rRel]!.push(entry);
        else endEntries.push(entry);
      }

      if (chain) {
        const eveCap = T.eveningCap[T.eveningCap.length - 1]!;
        // Label independent shortcuts (exact). The worst label for going home is the one with the
        // most morning driving; if even it, plus the cheapest way back out with no morning drive,
        // costs no more than the hotel nights alone, every straight drive to U is beaten.
        let maxM = 0;
        for (let li = 0; li < outs.length; li++) if (outs[li]!.m > maxM) maxM = outs[li]!.m;
        const worstHome = viaHome && s.objective === 'profit' ? this.returnOption(i, maxM, homeOnly) : null;
        const reachMiles: number[] = [];
        for (let g = 1; g <= G && g <= 400; g++) {
          reachMiles[g] = roadMilesForHours(Math.min(eveCap, C) + (g - 1) * F + C + EPS, travel.model) + 1e-6;
        }
        let pos = lowerBound(this.firstSorted, T.last + 1);
        for (; pos < this.order.length; pos++) {
          const u = this.order[pos]!;
          const U = nodes[u]!;
          const n = U.first - T.last;
          if (n > G) break;
          if (!usable(u)) continue;
          if (this.anyBlackout(T.last + 1, U.first - 1)) continue;
          const free = (n - 1) * F;
          const Mu = U.morningCap[0]!;
          const maxHours = Math.min(eveCap, C) + free + Mu + EPS;
          if (fast) {
            // Quick checks on latitude alone, before any trigonometry.
            const lower = latitudeGapMiles(lat[i]!, lat[u]!) * roadFactor;
            if (n <= 400 && lower > reachMiles[n]!) continue;
            if (worstHome) {
              const out0 = depart[u]!;
              const last = out0[out0.length - 1];
              if (last && last.m <= EPS && worstHome.j + last.j <= n - 1) {
                const directFloor = lower * perMile + n * this.hotel + (n - 1) * this.food;
                // The floor leaves out the time penalty, so it stays a lower bound on the straight drive.
                if (worstHome.loss + last.loss <= directFloor + 1e-9) continue;
              }
            }
            travel.fromStraight(haversineCos(lat[i]!, lon[i]!, cosLat[i]!, lat[u]!, lon[u]!, cosLat[u]!), scratch);
          } else {
            travel.fill(T.show, U.show, scratch);
          }
          const h = scratch.hours;
          // Quick reject: even a full evening cannot make it.
          if (h > maxHours) continue;
          const cost = scratch.miles * perMile + n * this.hotel + (n - 1) * this.food;
          const lossD = this.loss(cost, h, n);
          const gain = this.travelGain(h);
          const depU = viaHome ? depart[u]! : null;
          const inc = incoming[u]!;
          for (let li = 0; li < outs.length; li++) {
            const L = outs[li]!;
            if (L.na + n > maxN) continue;
            const E = Math.max(0, Math.min(eveCap, C - L.m));
            const m = Math.max(0, h - E - free);
            if (m > Mu + EPS) continue;
            let k = 0;
            if (capped) {
              k = !monthReset || U.month === T.month ? L.k + 1 : 1;
              if (k > K) continue;
            }
            const v = L.v + gain - lossD;
            // Exact skip: going home in between is at least as good on every count, and the
            // home state will offer that label (or a better one) at U.
            const r = rets[li];
            if (depU && r) {
              let beaten = false;
              for (let oi = 0; oi < depU.length; oi++) {
                const o = depU[oi]!;
                if (r.j + o.j > n - 1) continue;
                if (L.v - r.loss + o.gain - o.loss >= v - EPS && o.m <= m + EPS) {
                  beaten = true;
                  break;
                }
              }
              if (beaten) continue;
            }
            edgeCount += 1;
            insertIn(inc, v, m, k, L.na + n, u, 'direct', n, null, L);
          }
        }
      }
    }
    finalize(nDays - 1);

    let best: HomeEntry = init;
    const finals = this.sameBase ? H[nDays - 1]! : endEntries;
    for (const e of finals) if (e.v > best.v + EPS) best = e;
    return {
      value: best.v,
      steps: reconstruct(best),
      stats: { nodes: nodes.length, labels: labelCount, edges: edgeCount },
    };
  }
}

function paretoHome(list: HomeEntry[]): HomeEntry[] {
  if (list.length <= 1) return list;
  const sorted = list.slice().sort((a, b) => a.k - b.k || b.v - a.v || a.day - b.day);
  const out: HomeEntry[] = [];
  let bestV = -Infinity;
  for (const e of sorted) {
    if (e.v > bestV + EPS) {
      out.push(e);
      bestV = e.v;
    }
  }
  return out;
}

/** Adds a label unless another one is at least as good on every count; drops labels it beats. */
function insertIn(
  list: InLabel[],
  v: number,
  m: number,
  k: number,
  na: number,
  node: number,
  kind: 'depart' | 'direct',
  j: number,
  prevHome: HomeEntry | null,
  prevOut: OutLabel | null,
): void {
  if (!admit(list, v, m, k, na)) return;
  list.push({ v, m, k, na, node, kind, j, prevHome, prevOut });
}

function insertOut(list: OutLabel[], v: number, m: number, k: number, na: number, node: number, variant: Variant, inL: InLabel): void {
  if (!admit(list, v, m, k, na)) return;
  list.push({ v, m, k, na, node, variant, inL });
}

function admit(list: { v: number; m: number; k: number; na: number }[], v: number, m: number, k: number, na: number): boolean {
  for (let x = 0; x < list.length; x++) {
    const K = list[x]!;
    if (K.v >= v - EPS && K.m <= m + EPS && K.k <= k && K.na <= na) return false;
  }
  let w = 0;
  for (let x = 0; x < list.length; x++) {
    const K = list[x]!;
    if (!(v >= K.v - EPS && m <= K.m + EPS && k <= K.k && na <= K.na)) list[w++] = K;
  }
  list.length = w;
  return true;
}

function lowerBound(arr: number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function reconstruct(final: HomeEntry): Step[] {
  const steps: Step[] = [];
  let cur: HomeEntry | null = final;
  while (cur && cur.from) {
    let out: OutLabel = cur.from;
    steps.push({ t: 'return', node: out.node, j: cur.j, mOut: out.m });
    for (;;) {
      const inL: InLabel = out.inL;
      steps.push({ t: 'show', node: out.node, variant: out.variant, mIn: inL.m, mOut: out.m });
      if (inL.kind === 'direct' && inL.prevOut) {
        const p: OutLabel = inL.prevOut;
        steps.push({ t: 'direct', from: p.node, to: out.node, n: inL.j, mFrom: p.m, m: inL.m });
        out = p;
        continue;
      }
      steps.push({ t: 'depart', node: out.node, j: inL.j, m: inL.m });
      cur = inL.prevHome;
      break;
    }
  }
  return steps.reverse();
}

/* ------------------------------------------------------------------------------------------ */
/* Turning a solution into a plan people can read.                                             */
/* ------------------------------------------------------------------------------------------ */

export interface PlanPoint {
  name: string;
  lat: number;
  lon: number;
  showId?: string;
  kind: 'home' | 'start' | 'end' | 'show' | 'road';
}

export interface DriveSegment {
  /** The calendar day this drive counts toward for the daily cap. */
  date: string;
  /** Zone used for the departure time and the driving window. */
  timezone: string;
  /** Zone used for the arrival time when it differs (shopping between zones). */
  arriveZone?: string;
  departMs: number;
  arriveMs: number;
  depart: string;
  arrive: string;
  hours: number;
  miles: number;
  /** "6:10 AM: drive 2 h 20 min to Edison, NJ (140 miles)". */
  label: string;
}

export interface PlanLeg {
  from: PlanPoint;
  to: PlanPoint;
  miles: number;
  km: number;
  hours: number;
  source: LegSource;
  kind: 'to_show' | 'between_shows' | 'to_end' | 'commute' | 'visit';
  segments: DriveSegment[];
  /** "Drive 3 h 10 min to Edison, NJ (180 miles)". */
  label: string;
}

export interface PlanNight {
  date: string;
  where: 'home' | 'hotel';
  town: string;
  lat: number;
  lon: number;
  /** "Hotel near Edison, NJ", "Home", "On the road near Harrisburg, PA". */
  label: string;
}

export interface PlanStop {
  showId: string;
  name: string;
  town: string;
  lat: number;
  lon: number;
  timezone: string;
  dates: string[];
  firstDate: string;
  lastDate: string;
  /** Vending: arrive by (setup). Shopping: arrival time. */
  arrive: string;
  arriveMs: number;
  /** Vending: leave after teardown. Shopping: leave after the visit. */
  leave: string;
  leaveMs: number;
  /** "Sat Nov 14, 9:00 AM to 3:00 PM". */
  hoursLabel: string;
  nights: 'hotel' | 'home' | 'none';
  waitlist: boolean;
  notes: string[];
  deadline: string | null;
  vendorStatus: VendorStatus | null;
  sales: SalesEstimate | null;
  table: TableCost | null;
  /** Vendor priority score for this stop (score mode) or visit value (shopping). */
  score: number | null;
  reasons: string[];
}

export interface PlanDay {
  date: string;
  /** "Sat Nov 14". */
  label: string;
  items: string[];
  driveHours: number;
  night: PlanNight | null;
  away: boolean;
}

export interface Deadline {
  showId: string;
  name: string;
  date: string | null;
  /** "Apply by Nov 3", "Deadline passed Oct 1, waitlist only", "No deadline listed". */
  label: string;
  status: VendorStatus | null;
  waitlist: boolean;
  passed: boolean;
}

export interface TripSummary {
  departDate: string;
  returnDate: string;
  showIds: string[];
  hotelNights: number;
  miles: number;
  driveHours: number;
  /** "Nov 14 to 15: Garden State Card Show". */
  label: string;
}

export interface Plan {
  kind: 'vending' | 'shopping';
  title: string;
  /** Alternatives only: how this plan differs from the best one. */
  note?: string;
  /** "2 shows, 1 hotel night, 410 miles, 7 h 30 min of driving". */
  summary: string;
  stops: PlanStop[];
  legs: PlanLeg[];
  days: PlanDay[];
  nights: PlanNight[];
  trips: TripSummary[];
  money: ProfitEstimate;
  deadlines: Deadline[];
  warnings: string[];
  departDate: string | null;
  returnDate: string | null;
  hotelNights: number;
  driveHours: number;
  miles: number;
  /** The number the search maximized: profit (minus your time, if you priced it), or points after the driving and night penalties. */
  value: number;
  /** Plans by score: "Plan score 79: stops worth 191, minus 112 for 11 h 10 min of driving". Null for plans by profit. */
  scoreLine: string | null;
  objective: Objective | 'visits';
  /** Where drive times came from. */
  driveTimes: { source: LegSource; label: string };
  /** Start and end points, so the plan can be rechecked or linked to maps. */
  start: PlanPoint;
  end: PlanPoint;
}

interface Piece {
  day: number;
  zone: string;
  departMs: number;
  hours: number;
}

/** Fills a leg into day slots, earliest first, and returns the pieces and the cumulative share. */
function freeDayPiece(day: number, hours: number, zone: string, rules: PlanningRules): Piece {
  const date = dateFromEpochDay(day);
  const nine = zonedTimeToInstant(date, '09:00', zone);
  const latest = zonedTimeToInstant(date, rules.latestDrive, zone);
  const earliest = zonedTimeToInstant(date, rules.earliestDrive, zone);
  let start = nine;
  if (start + hours * MS_PER_HOUR > latest) start = Math.max(earliest, latest - hours * MS_PER_HOUR);
  return { day, zone, departMs: start, hours };
}

function interpolate(a: LatLon, b: LatLon, f: number): LatLon {
  return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
}

export function nearestTown(p: LatLon, shows: PlannerShow[], maxMiles = 50): string | null {
  let best: PlannerShow | null = null;
  let bestD = Infinity;
  for (const s of shows) {
    if (!s.city) continue;
    const d = haversineMiles(p, s);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best && bestD <= maxMiles ? townLabel(best) : null;
}

export function deadlineFor(show: PlannerShow, flags: Candidate['flags'] | null): Deadline {
  const date = show.vendor?.deadline ?? null;
  const passed = flags?.deadlinePassed ?? false;
  const waitlist = flags?.waitlist ?? show.vendor?.status === 'waitlist';
  let label: string;
  if (!date) label = waitlist ? 'No deadline listed, waitlist only' : 'No deadline listed, check with the organizer';
  else if (passed) label = `Deadline passed ${formatShortDate(date)}, waitlist only`;
  else label = waitlist ? `Join the waitlist by ${formatShortDate(date)}` : `Apply by ${formatShortDate(date)}`;
  return { showId: show.id, name: show.name, date, label, status: show.vendor?.status ?? null, waitlist, passed };
}

export function sortDeadlines(list: Deadline[]): Deadline[] {
  return list.slice().sort((a, b) => {
    if (a.date && b.date) return a.date < b.date ? -1 : a.date > b.date ? 1 : a.name < b.name ? -1 : 1;
    if (a.date) return -1;
    if (b.date) return 1;
    return a.name < b.name ? -1 : 1;
  });
}

export function sumRanges(list: (Range | null)[]): Range | null {
  let any = false;
  const r: Range = { low: 0, mid: 0, high: 0 };
  for (const x of list) {
    if (!x) continue;
    any = true;
    r.low += x.low;
    r.mid += x.mid;
    r.high += x.high;
  }
  return any ? r : null;
}

export function sumSales(list: (SalesEstimate | null)[], currency: string): SalesEstimate | null {
  const present = list.filter((x): x is SalesEstimate => x !== null);
  if (present.length === 0) return null;
  const r = sumRanges(present)!;
  return {
    ...r,
    currency,
    sizeClass: present[0]!.sizeClass,
    sizeAssumed: present.some((x) => x.sizeAssumed),
    typical: present.reduce((s, x) => s + x.typical, 0),
    trafficFactor: 1,
    matchFactor: 1,
    historyAverage: null,
    historyCount: present.reduce((s, x) => s + x.historyCount, 0),
    historyWeight: 0,
    rangeFrom: present.every((x) => x.rangeFrom === 'attendance') ? 'attendance' : 'rough',
    explain: [
      present.length === 1
        ? 'Sales for one show.'
        : `Sales added over ${present.length} shows. The range adds the low ends together and the high ends together, so it is wide on purpose.`,
    ],
  };
}

function legSourceLabel(source: LegSource): string {
  if (source === 'osrm') return 'Real drive times from OpenStreetMap routing (OSRM)';
  if (source === 'given') return 'Drive times you entered';
  return 'Estimated drive times (straight line distance times a road factor)';
}

/** Builds the readable plan for a solution. Costs are counted again from the itinerary itself. */
export function describeVending(engine: VendingEngine, sol: VendingSolution, title: string): Plan {
  const s = engine.setup;
  const rules = s.rules;
  const nodes = engine.nodes;
  const settings = s.settings;
  const currency = vendorCurrency(settings);
  const basePoint: PlanPoint = {
    name: s.base.name ?? 'Home',
    lat: s.base.lat,
    lon: s.base.lon,
    kind: s.base.name && s.base.name !== 'Home' ? 'start' : 'home',
  };
  const endPoint: PlanPoint = engine.sameBase
    ? basePoint
    : { name: s.end.name ?? 'Your end point', lat: s.end.lat, lon: s.end.lon, kind: 'end' };
  const showPoint = (i: number): PlanPoint => {
    const sh = nodes[i]!.show;
    return { name: townLabel({ city: sh.city, region: sh.region, name: sh.name }), lat: sh.lat, lon: sh.lon, showId: sh.id, kind: 'show' };
  };

  const legs: PlanLeg[] = [];
  const nights = new Map<number, PlanNight>();
  const stops: PlanStop[] = [];
  const presence: { day: number; at: number; text: string }[] = [];
  const activeDays = new Set<number>();
  const trips: TripSummary[] = [];
  const sources = new Set<LegSource>();
  let tripStart: number | null = null;
  let tripShows: string[] = [];
  let tripLegStart = 0;
  let prevPointForScore: { hours: number; name: string } | null = null;

  const homeNight = (day: number, p: PlanPoint) => {
    nights.set(day, {
      date: dateFromEpochDay(day),
      where: 'home',
      town: p.name,
      lat: p.lat,
      lon: p.lon,
      label: p.kind === 'home' ? 'Home' : p === endPoint && !engine.sameBase ? 'At your end point' : `At ${p.name}`,
    });
  };

  const roadNight = (day: number, from: PlanPoint, to: PlanPoint, frac: number) => {
    if (frac >= 1 - 1e-9 && to.kind === 'show') {
      nights.set(day, { date: dateFromEpochDay(day), where: 'hotel', town: to.name, lat: to.lat, lon: to.lon, label: `Hotel near ${to.name}` });
      return;
    }
    if (frac <= 1e-9 && from.kind === 'show') {
      nights.set(day, { date: dateFromEpochDay(day), where: 'hotel', town: from.name, lat: from.lat, lon: from.lon, label: `Hotel near ${from.name}` });
      return;
    }
    const p = interpolate(from, to, Math.min(1, Math.max(0, frac)));
    const near = nearestTown(p, s.allShows);
    const town = near ?? `between ${from.name} and ${to.name}`;
    nights.set(day, {
      date: dateFromEpochDay(day),
      where: 'hotel',
      town,
      lat: p.lat,
      lon: p.lon,
      label: near ? `Hotel on the road near ${near}` : `Hotel on the road ${town}`,
    });
  };

  const makeLeg = (from: PlanPoint, to: PlanPoint, leg: Leg, kind: PlanLeg['kind'], pieces: Piece[]): PlanLeg => {
    sources.add(leg.source);
    let done = 0;
    const segments: DriveSegment[] = pieces
      .filter((p) => p.hours > EPS)
      .map((p) => {
        done += p.hours;
        const finished = Math.abs(done - leg.hours) < 1e-6;
        const miles = leg.hours > 0 ? (leg.miles * p.hours) / leg.hours : 0;
        const arriveMs = p.departMs + p.hours * MS_PER_HOUR;
        activeDays.add(p.day);
        return {
          date: dateFromEpochDay(p.day),
          timezone: p.zone,
          departMs: p.departMs,
          arriveMs,
          depart: toZonedIso(p.departMs, p.zone),
          arrive: toZonedIso(arriveMs, p.zone),
          hours: p.hours,
          miles,
          label: `${formatClock(p.departMs, p.zone)}: drive ${formatDuration(p.hours)} ${finished ? 'to' : 'toward'} ${to.name} (${formatDistance(miles)})`,
        };
      });
    const out: PlanLeg = {
      from,
      to,
      miles: leg.miles,
      km: leg.km,
      hours: leg.hours,
      source: leg.source,
      kind,
      segments,
      label: `Drive ${formatDuration(leg.hours)} to ${to.name} (${formatDistance(leg.miles)})`,
    };
    legs.push(out);
    return out;
  };

  /** Fills a leg over: an optional evening slot, whole free days, then a morning slot. */
  const fillLeg = (
    from: PlanPoint,
    to: PlanPoint,
    leg: Leg,
    kind: PlanLeg['kind'],
    evening: { day: number; departMs: number; cap: number; zone: string } | null,
    freeDays: { from: number; to: number; zone: string },
    morning: { day: number; arriveMs: number; zone: string } | null,
    nightDays: number[],
  ) => {
    const pieces: Piece[] = [];
    let rem = leg.hours;
    const cumAfterDay = new Map<number, number>();
    let cum = 0;
    if (evening) {
      const e = Math.min(rem, evening.cap);
      if (e > EPS) pieces.push({ day: evening.day, zone: evening.zone, departMs: evening.departMs, hours: e });
      rem -= e;
      cum += e;
      cumAfterDay.set(evening.day, cum);
    }
    for (let d = freeDays.from; d <= freeDays.to; d++) {
      const x = Math.min(rem, engine.F);
      if (x > EPS) pieces.push(freeDayPiece(d, x, freeDays.zone, rules));
      rem -= x;
      cum += x;
      cumAfterDay.set(d, cum);
    }
    if (rem > EPS) {
      if (!morning) throw new PlannerError('internal', 'A drive did not fit the days given for it.');
      pieces.push({ day: morning.day, zone: morning.zone, departMs: morning.arriveMs - rem * MS_PER_HOUR, hours: rem });
    }
    for (const nd of nightDays) {
      const c = cumAfterDay.get(nd) ?? (nd < (evening?.day ?? freeDays.from) ? 0 : cum);
      roadNight(nd, from, to, leg.hours > 0 ? c / leg.hours : 1);
    }
    makeLeg(from, to, leg, kind, pieces);
  };

  const lastEvening = (T: VNode, mOut: number) => ({
    day: T.last,
    departMs: T.leaveAt[T.leaveAt.length - 1]!,
    cap: Math.max(0, Math.min(T.eveningCap[T.eveningCap.length - 1]!, engine.C - mOut)),
    zone: T.zone,
  });

  const range = (a: number, b: number) => {
    const out: number[] = [];
    for (let d = a; d <= b; d++) out.push(d);
    return out;
  };

  for (const st of sol.steps) {
    if (st.t === 'depart') {
      const T = nodes[st.node]!;
      const leg = engine.legBase(st.node);
      tripStart = T.first - st.j;
      tripShows = [];
      tripLegStart = legs.length;
      if (st.j === 0) {
        fillLeg(basePoint, showPoint(st.node), leg, 'to_show', null, { from: 1, to: 0, zone: T.zone }, { day: T.first, arriveMs: T.arriveBy[0]!, zone: T.zone }, []);
      } else {
        fillLeg(
          basePoint,
          showPoint(st.node),
          leg,
          'to_show',
          null,
          { from: T.first - st.j, to: T.first - 1, zone: T.zone },
          { day: T.first, arriveMs: T.arriveBy[0]!, zone: T.zone },
          range(T.first - st.j, T.first - 1),
        );
      }
      prevPointForScore = { hours: leg.hours, name: basePoint.kind === 'home' ? 'home' : basePoint.name };
    } else if (st.t === 'direct') {
      const A = nodes[st.from]!;
      const U = nodes[st.to]!;
      const leg = engine.legPair(st.from, st.to);
      fillLeg(
        showPoint(st.from),
        showPoint(st.to),
        leg,
        'between_shows',
        lastEvening(A, st.mFrom),
        { from: A.last + 1, to: U.first - 1, zone: U.zone },
        { day: U.first, arriveMs: U.arriveBy[0]!, zone: U.zone },
        range(A.last, U.first - 1),
      );
      prevPointForScore = { hours: leg.hours, name: A.show.name };
    } else if (st.t === 'show') {
      const T = nodes[st.node]!;
      const sh = T.show;
      tripShows.push(sh.id);
      const nd = T.dates.length;
      for (let d = 0; d < nd; d++) {
        activeDays.add(T.dayNums[d]!);
        const setupNote = d === 0 ? ` (be there by ${formatClock(T.arriveBy[0]!, T.zone)})` : '';
        presence.push({
          day: T.dayNums[d]!,
          at: T.arriveBy[d]!,
          text: `Vend at ${sh.name}, ${formatClock(T.open[d]!, T.zone)} to ${formatClock(T.close[d]!, T.zone)}${setupNote}`,
        });
      }
      if (st.variant === 'hotel') {
        for (let d = T.first; d < T.last; d++) {
          const p = showPoint(st.node);
          nights.set(d, { date: dateFromEpochDay(d), where: 'hotel', town: p.name, lat: p.lat, lon: p.lon, label: `Hotel near ${p.name}` });
        }
      } else if (st.variant === 'commute') {
        const back = engine.legHome(st.node);
        const there = engine.legBase(st.node);
        for (let d = 0; d < nd - 1; d++) {
          makeLeg(showPoint(st.node), basePoint, back, 'commute', [
            { day: T.dayNums[d]!, zone: T.zone, departMs: T.leaveAt[d]!, hours: back.hours },
          ]);
          for (let x = T.dayNums[d]!; x < T.dayNums[d + 1]!; x++) homeNight(x, basePoint);
          makeLeg(basePoint, showPoint(st.node), there, 'commute', [
            {
              day: T.dayNums[d + 1]!,
              zone: T.zone,
              departMs: T.arriveBy[d + 1]! - there.hours * MS_PER_HOUR,
              hours: there.hours,
            },
          ]);
        }
      }
      const f = vendorFactors(sh, {
        settings,
        hours: prevPointForScore ? prevPointForScore.hours : null,
        fromName: prevPointForScore ? prevPointForScore.name : null,
        priceContext: s.priceContext,
        rates: s.rates,
        labels: s.labels,
        profitModel: s.profitModel,
        travelHalfLifeHours: s.travelHalfLifeHours,
      });
      const score =
        s.objective === 'score'
          ? Math.round(pointsWithoutTravel(f, s.weights) + 100 * s.weights.travel * f.travel.value)
          : null;
      stops.push({
        showId: sh.id,
        name: sh.name,
        town: townLabel({ city: sh.city, region: sh.region, name: sh.name }),
        lat: sh.lat,
        lon: sh.lon,
        timezone: T.zone,
        dates: T.dates,
        firstDate: T.dates[0]!,
        lastDate: T.dates[nd - 1]!,
        arrive: toZonedIso(T.arriveBy[0]!, T.zone),
        arriveMs: T.arriveBy[0]!,
        leave: toZonedIso(T.leaveAt[nd - 1]!, T.zone),
        leaveMs: T.leaveAt[nd - 1]!,
        hoursLabel: T.dates
          .map((date, d) => `${formatDayLabel(date)}, ${formatClock(T.open[d]!, T.zone)} to ${formatClock(T.close[d]!, T.zone)}`)
          .join('; '),
        nights: st.variant === 'hotel' ? 'hotel' : st.variant === 'commute' ? 'home' : 'none',
        waitlist: T.flags.waitlist,
        notes: T.flags.notes.slice(),
        deadline: sh.vendor?.deadline ?? null,
        vendorStatus: sh.vendor?.status ?? null,
        sales: T.sales ? estimateSales(sh, settings, s.profitModel) : null,
        table: T.table,
        score,
        reasons: [f.crowd.reason, f.cost.reason, f.travel.reason, f.history.reason].filter((x): x is string => !!x),
      });
    } else {
      const T = nodes[st.node]!;
      const leg = engine.legEnd(st.node);
      const rDay = T.last + st.j;
      fillLeg(
        showPoint(st.node),
        endPoint,
        leg,
        'to_end',
        lastEvening(T, st.mOut),
        { from: T.last + 1, to: rDay, zone: T.zone },
        null,
        range(T.last, rDay - 1),
      );
      homeNight(rDay, endPoint);
      const tripLegs = legs.slice(tripLegStart);
      const start = tripStart ?? T.first;
      let hotelNights = 0;
      for (let d = start; d < rDay; d++) if (nights.get(d)?.where === 'hotel') hotelNights += 1;
      trips.push({
        departDate: dateFromEpochDay(start),
        returnDate: dateFromEpochDay(rDay),
        showIds: tripShows.slice(),
        hotelNights,
        miles: tripLegs.reduce((a, l) => a + l.miles, 0),
        driveHours: tripLegs.reduce((a, l) => a + l.hours, 0),
        label: `${formatDateRange(dateFromEpochDay(start), dateFromEpochDay(rDay))}: ${tripShows.map((id) => nodes.find((n) => n.show.id === id)?.show.name ?? id).join(', ')}`,
      });
      tripStart = null;
    }
  }

  // Days, nights and what each day costs, counted from the itinerary.
  const allDays = new Set<number>([...activeDays, ...nights.keys()]);
  const sortedDays = [...allDays].sort((a, b) => a - b);
  const days: PlanDay[] = [];
  let foodDays = 0;
  const segByDay = new Map<number, DriveSegment[]>();
  for (const l of legs) for (const sg of l.segments) {
    const d = epochDay(sg.date);
    const list = segByDay.get(d) ?? [];
    list.push(sg);
    segByDay.set(d, list);
  }
  for (const d of sortedDays) {
    const night = nights.get(d) ?? null;
    const prevNight = nights.get(d - 1);
    const active = activeDays.has(d);
    const away = active || prevNight?.where === 'hotel';
    if (!away && night?.where === 'home') continue;
    if (away) foodDays += 1;
    const segs = (segByDay.get(d) ?? []).slice().sort((a, b) => a.departMs - b.departMs);
    const items: { at: number; text: string }[] = segs.map((sg) => ({ at: sg.departMs, text: sg.label }));
    for (const p of presence) if (p.day === d) items.push({ at: p.at, text: p.text });
    items.sort((a, b) => a.at - b.at);
    days.push({
      date: dateFromEpochDay(d),
      label: formatDayLabel(dateFromEpochDay(d)),
      items: items.map((x) => x.text),
      driveHours: segs.reduce((a, sg) => a + sg.hours, 0),
      night,
      away,
    });
  }

  const nightList = [...nights.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  const hotelNights = nightList.filter((n) => n.where === 'hotel').length;
  const miles = legs.reduce((a, l) => a + l.miles, 0);
  const driveHours = legs.reduce((a, l) => a + l.hours, 0);

  const sheet = new CostSheet(currency, s.rates);
  for (const st of sol.steps) {
    if (st.t === 'show') addShowCosts(sheet, nodes[st.node]!.show, settings, s.profitModel, true);
  }
  if (stops.length > 0) addTripCosts(sheet, { miles, hotelNights, foodDays, driveHours }, settings, engine.fuel);
  const sales = settings.typical_sales ? sumSales(stops.map((x) => x.sales), currency) : null;
  const money = finishEstimate(sales, sheet, settings);

  const warnings: string[] = [];
  for (const st of stops) {
    const n = nodes.find((x) => x.show.id === st.showId);
    for (const w of n?.warnings ?? []) if (!warnings.includes(w)) warnings.push(w);
    if (st.table?.assumed) warnings.push(`Table price for ${st.name} is not listed, so ${Math.round(st.table.amount)} ${st.table.currency} is assumed.`);
  }

  const source: LegSource = sources.has('osrm') ? 'osrm' : sources.has('given') ? 'given' : 'estimate';
  const firstDay = sortedDays[0];
  const lastDay = sortedDays[sortedDays.length - 1];
  return {
    kind: 'vending',
    title,
    summary: summaryLine(stops.length, hotelNights, miles, driveHours, 'show'),
    stops,
    legs,
    days,
    nights: nightList,
    trips,
    money,
    deadlines: sortDeadlines(
      sol.steps
        .filter((x): x is Extract<Step, { t: 'show' }> => x.t === 'show')
        .map((x) => deadlineFor(nodes[x.node]!.show, nodes[x.node]!.flags)),
    ),
    warnings,
    departDate: firstDay === undefined ? null : dateFromEpochDay(firstDay),
    returnDate: lastDay === undefined ? null : dateFromEpochDay(lastDay),
    hotelNights,
    driveHours,
    miles,
    value: sol.value,
    objective: s.objective,
    scoreLine:
      s.objective === 'score'
        ? scoreLine(sol.value + engine.perDriveHour * driveHours + engine.perHotelNight * hotelNights, sol.value, driveHours, hotelNights, s.penalties, 'shows')
        : null,
    driveTimes: { source, label: legSourceLabel(source) },
    start: basePoint,
    end: endPoint,
  };
}

/** "Plan score 79: stops worth 191, minus 112 for 11 h 10 min of driving and 25 for 1 hotel night". */
export function scoreLine(points: number, value: number, hours: number, nights: number, pen: Penalties, noun: 'shows' | 'stops'): string {
  const drive = Math.round(pen.perDriveHour * hours);
  const night = Math.round(pen.perHotelNight * nights);
  const parts: string[] = [];
  if (drive > 0) parts.push(`${drive} for ${formatDuration(hours)} of driving`);
  if (night > 0) parts.push(`${night} for ${nights} hotel ${nights === 1 ? 'night' : 'nights'}`);
  const minus = parts.length === 0 ? '' : `, minus ${parts.join(' and ')}`;
  return `Plan score ${Math.round(value)}: ${noun} worth ${Math.round(points)}${minus}`;
}

export function summaryLine(count: number, hotelNights: number, miles: number, hours: number, noun: 'show' | 'stop'): string {
  if (count === 0) return `No ${noun}s fit`;
  const parts = [`${count} ${noun}${count === 1 ? '' : 's'}`];
  parts.push(hotelNights === 0 ? 'no hotel nights' : `${hotelNights} hotel ${hotelNights === 1 ? 'night' : 'nights'}`);
  parts.push(formatDistance(miles));
  parts.push(`${formatDuration(hours)} of driving`);
  return parts.join(', ');
}

/** The identity of a plan as a person sees it: which shows on which days, and which nights are hotel nights. */
export function planSignature(p: Plan): string {
  const stops = p.stops.map((x) => `${x.showId}@${x.firstDate}`).join('+');
  const hotels = p.nights.filter((n) => n.where === 'hotel').map((n) => n.date).join(',');
  return `${stops}|${hotels}`;
}
