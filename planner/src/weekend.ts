/**
 * Weekend run (DESIGN 6.3): one trip, several shows over a few days, as a vendor or as a shopper.
 * Returns the best plan plus up to three meaningfully different alternatives.
 */
import { filterCandidates, type Candidate, type Excluded } from './candidates.js';
import { checkPlace, checkRange, nearestZone, resolveCommon, type CommonPlanOptions } from './common.js';
import { buildPriceContext } from './factors.js';
import {
  formatClock,
  formatDayLabel,
  formatDistance,
  formatDuration,
  formatLocalClock,
  formatMoney,
  formatWeekday,
  townLabel,
} from './format.js';
import { addTripCosts, CostSheet, finishEstimate, fuelCostPerMile, vendorCurrency, showCurrency, profitLabel } from './profit.js';
import { visitValue } from './scoring.js';
import { solveShop, simulateShop, type ShopInstance, type ShopSolution } from './shopping.js';
import { addDays, dateFromEpochDay, epochDay, MS_PER_HOUR, toZonedIso, zonedTimeToInstant } from './time.js';
import type { Leg, LegSource } from './travel.js';
import type { Place, PlannerShow, VendorSettings } from './types.js';
import { PlannerError } from './types.js';
import {
  deadlineFor,
  describeVending,
  planSignature,
  sortDeadlines,
  summaryLine,
  VendingEngine,
  type DriveSegment,
  type Overnight,
  type Plan,
  type PlanDay,
  type PlanLeg,
  type PlanNight,
  type PlanPoint,
  type PlanStop,
  type VendingSolution,
} from './vending.js';

export interface WeekendRunOptions extends CommonPlanOptions {
  dates: { start: string; end: string };
  mode: 'vending' | 'shopping';
  /** Defaults to home. */
  start?: Place;
  /** Defaults to the start point. */
  end?: Place;
  /** `stay` (default): hotels allowed, home used when it is cheaper and fits. `home`: home every night. */
  overnight?: Overnight;
  maxShows?: number;
  /** How many alternatives to return, 0 to 3. Default 3. */
  alternatives?: number;
  /** Shopping: minutes at each show. Default 90. */
  dwellMinutes?: number;
  /** Shopping: what you collect. Defaults to what you sell. */
  interests?: string[];
  /** Shopping: your own value per show id, which overrides the computed one. */
  values?: Record<string, number>;
  /** Shopping: people paying admission. Default 1. */
  people?: number;
  /** Shopping: exact search up to this many candidates. Default 12. */
  exactLimit?: number;
  /** Shopping heuristic seed, for repeatable results. Default 1. */
  seed?: number;
  blackout?: string[];
}

export interface WeekendRunResult {
  mode: 'vending' | 'shopping';
  best: Plan | null;
  alternatives: Plan[];
  excluded: Excluded[];
  warnings: string[];
  candidates: number;
  /** Shopping: whether the exact search was used. */
  exact: boolean | null;
  ms: number;
}

const MAX_RUN_DAYS = 14;

export function planWeekendRun(shows: PlannerShow[], settings: VendorSettings, options: WeekendRunOptions): WeekendRunResult {
  const t0 = Date.now();
  if (!options || !options.dates) throw new PlannerError('bad_date', 'Pick a start and end date.');
  checkRange(options.dates.start, options.dates.end);
  const span = epochDay(options.dates.end) - epochDay(options.dates.start) + 1;
  if (span > MAX_RUN_DAYS) {
    throw new PlannerError('run_too_long', `A weekend run can cover up to ${MAX_RUN_DAYS} days. Use the season planner for longer.`);
  }
  const start = options.start ?? settings.home ?? undefined;
  checkPlace(start, 'a start point or your home location');
  const end = options.end ?? start;
  checkPlace(end, 'an end point');
  if (options.mode !== 'vending' && options.mode !== 'shopping') {
    throw new PlannerError('bad_mode', 'Pick vending or shopping.');
  }
  const r = resolveCommon(settings, options);
  const { kept, excluded } = filterCandidates(shows, {
    rangeStart: options.dates.start,
    rangeEnd: options.dates.end,
    today: r.today,
    purpose: options.mode,
    blackout: options.blackout,
    keepPastDeadline: options.keepPastDeadline,
    includeStoreEvents: options.includeStoreEvents,
    skipIds: options.skipIds,
    onlyIds: options.onlyIds,
  });
  const altCount = Math.max(0, Math.min(3, options.alternatives ?? 3));
  if (options.mode === 'shopping') {
    return shoppingRun(kept, excluded, settings, options, start, end, r, altCount, t0);
  }

  const engine = weekendEngine(kept, shows, settings, options, start, end, r);
  const sol = engine.solve();
  const best = sol.steps.length > 0 ? describeVending(engine, sol, 'Best plan') : null;
  const warnings = [...engine.warnings];
  if (!best) warnings.push(noPlanReason(kept.length, engine.nodes.length, r.objective === 'profit'));
  const alternatives = best ? vendingAlternatives(engine, sol, best, altCount, options.dates.start) : [];
  return {
    mode: 'vending',
    best,
    alternatives,
    excluded: [...excluded, ...engine.excluded],
    warnings,
    candidates: engine.nodes.length,
    exact: null,
    ms: Date.now() - t0,
  };
}

/** The engine a vending weekend run uses. Exposed for tests and for callers who want to re solve. */
export function weekendEngine(
  kept: Candidate[],
  shows: PlannerShow[],
  settings: VendorSettings,
  options: WeekendRunOptions,
  start: Place,
  end: Place,
  r: ReturnType<typeof resolveCommon>,
): VendingEngine {
  return new VendingEngine({
    candidates: kept,
    allShows: shows,
    settings,
    base: start,
    end,
    rangeStart: options.dates.start,
    rangeEnd: options.dates.end,
    tripWithinRange: true,
    overnight: options.overnight ?? 'stay',
    chain: true,
    maxNightsAway: null,
    countCap: options.maxShows ?? null,
    countReset: 'never',
    blackout: options.blackout ?? [],
    objective: r.objective,
    rules: r.rules,
    travel: r.travel,
    rates: r.rates,
    profitModel: r.profitModel,
    weights: r.weights,
    priceContext: buildPriceContext(kept.map((c) => c.show), settings, r.rates),
    labels: options.labels,
    maxChainGapDays: MAX_RUN_DAYS,
    travelSlackDays: 0,
    minScore: options.minScore ?? 0,
    travelHalfLifeHours: 2,
  });
}

function noPlanReason(kept: number, nodes: number, profit: boolean): string {
  if (kept === 0) return 'No shows match your dates and rules.';
  if (nodes === 0) return 'None of the shows can be planned. See the reasons listed for each.';
  return profit
    ? 'No show fits your driving limit and is expected to pay for itself on these dates.'
    : 'No show fits your driving limit on these dates.';
}

/** "About 120 USD less profit, 1 hotel night fewer, home Saturday night". */
function compareNote(p: Plan, best: Plan): string {
  const parts: string[] = [];
  const cur = p.money.currency;
  if (p.money.profit && best.money.profit) {
    const d = Math.round(p.money.profit.mid - best.money.profit.mid);
    if (d !== 0) parts.push(`About ${formatMoney(Math.abs(d), cur)} ${d < 0 ? 'less' : 'more'} profit`);
  } else if (p.money.totalCost !== null && best.money.totalCost !== null) {
    const d = Math.round(p.money.totalCost - best.money.totalCost);
    if (d !== 0) parts.push(`${formatMoney(Math.abs(d), cur)} ${d < 0 ? 'cheaper' : 'more'} to run`);
  }
  const ds = p.stops.length - best.stops.length;
  if (ds !== 0) parts.push(`${Math.abs(ds)} ${p.kind === 'shopping' ? 'stop' : 'show'}${Math.abs(ds) === 1 ? '' : 's'} ${ds < 0 ? 'fewer' : 'more'}`);
  const dn = p.hotelNights - best.hotelNights;
  if (dn !== 0) parts.push(`${Math.abs(dn)} hotel ${Math.abs(dn) === 1 ? 'night' : 'nights'} ${dn < 0 ? 'fewer' : 'more'}`);
  const dh = p.driveHours - best.driveHours;
  if (Math.abs(dh) >= 0.25) parts.push(`${formatDuration(Math.abs(dh))} ${dh < 0 ? 'less' : 'more'} driving`);
  if (p.returnDate && best.returnDate && p.returnDate < best.returnDate) parts.push(`home by ${formatWeekday(p.returnDate)} night`);
  return parts.length ? parts.join(', ').replace(/^./, (c) => c.toUpperCase()) : 'Same totals, different shows';
}

function vendingAlternatives(engine: VendingEngine, bestSol: VendingSolution, best: Plan, max: number, rangeStart: string): Plan[] {
  if (max === 0) return [];
  const seen = new Set([planSignature(best)]);
  const out: Plan[] = [];
  const tryAdd = (make: () => VendingSolution, title: string) => {
    if (out.length >= max) return;
    let sol: VendingSolution;
    try {
      sol = make();
    } catch {
      return;
    }
    if (sol.steps.length === 0) return;
    const p = describeVending(engine, sol, title);
    const sig = planSignature(p);
    if (seen.has(sig)) return;
    seen.add(sig);
    p.note = compareNote(p, best);
    out.push(p);
  };
  const nShows = best.stops.length;
  if (nShows >= 2) tryAdd(() => engine.solve({ countCap: nShows - 1 }), 'One fewer show');
  if (best.returnDate && best.returnDate > rangeStart) {
    const earlier = addDays(best.returnDate, -1);
    tryAdd(() => engine.solve({ rangeEnd: earlier }), `Home by ${formatWeekday(earlier)} night`);
  }
  if (best.hotelNights > 0 && engine.sameBase) tryAdd(() => engine.solve({ overnight: 'home' }), 'No hotel nights');
  const stopNodes = bestSol.steps.filter((s) => s.t === 'show').map((s) => (s as { node: number }).node);
  for (const node of stopNodes) {
    tryAdd(() => engine.solve({ skip: new Set([node]) }), `Without ${engine.nodes[node]!.show.name}`);
  }
  return out;
}

/* ---------------------------------- Shopping ---------------------------------- */

interface ShopMeta {
  cands: Candidate[];
  legs: Leg[][];
  origin: number;
  baseZone: string;
  endZone: string;
  dates: string[];
  points: PlanPoint[];
}

export function buildShopInstance(
  cands: Candidate[],
  settings: VendorSettings,
  options: WeekendRunOptions,
  start: Place,
  end: Place,
  r: ReturnType<typeof resolveCommon>,
  maxStops: number,
  mode: 'home' | 'stay',
  lastDate: string,
): { inst: ShopInstance; meta: ShopMeta } {
  const n = cands.length;
  const shows = cands.map((c) => c.show);
  const baseZone = start.timezone ?? nearestZone(start, shows);
  const endZone = end.timezone ?? nearestZone(end, shows);
  const dates: string[] = [];
  for (let d = epochDay(options.dates.start); d <= epochDay(lastDate); d++) dates.push(dateFromEpochDay(d));
  const origin = zonedTimeToInstant(dates[0]!, '00:00', baseZone);
  const toH = (ms: number) => (ms - origin) / MS_PER_HOUR;
  const points: PlanPoint[] = [
    ...shows.map((s) => ({ name: townLabel({ city: s.city, region: s.region, name: s.name }), lat: s.lat, lon: s.lon, showId: s.id, kind: 'show' as const })),
    { name: start.name ?? 'Home', lat: start.lat, lon: start.lon, kind: start.name && start.name !== 'Home' ? ('start' as const) : ('home' as const) },
    { name: end.name ?? (sameSpot(start, end) ? start.name ?? 'Home' : 'Your end point'), lat: end.lat, lon: end.lon, kind: sameSpot(start, end) ? ('home' as const) : ('end' as const) },
  ];
  const legs: Leg[][] = points.map((a) => points.map((b) => r.travel.leg(a, b)));
  const dwell = (options.dwellMinutes ?? 90) / 60;
  if (!(dwell > 0 && dwell <= 12)) throw new PlannerError('bad_dwell', 'Time at each show must be between 1 minute and 12 hours.');
  const interests = options.interests ?? settings.sells ?? [];
  const value = shows.map((s) => {
    const v = options.values?.[s.id];
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : visitValue(s, interests);
  });
  const win = cands.map((c) =>
    dates.map((date) => {
      const day = c.days.find((d) => d.date === date);
      if (!day) return null;
      const o = zonedTimeToInstant(date, day.open ?? r.rules.defaultOpen, c.show.timezone);
      const cl = zonedTimeToInstant(date, day.close ?? r.rules.defaultClose, c.show.timezone);
      const lastStart = toH(cl) - dwell;
      return lastStart >= toH(o) - 1e-9 ? ([toH(o), lastStart] as [number, number]) : null;
    }),
  );
  const zoneOf = (loc: number) => (loc < n ? shows[loc]!.timezone : loc === n ? baseZone : endZone);
  const dayStart = dates.map((date) => Array.from({ length: n + 1 }, (_, loc) => toH(zonedTimeToInstant(date, r.rules.shoppingDayStart, zoneOf(loc)))));
  const dayEnd = dates.map((date) => Array.from({ length: n + 2 }, (_, loc) => toH(zonedTimeToInstant(date, r.rules.latestDrive, zoneOf(loc)))));
  const inst: ShopInstance = {
    n,
    D: dates.length,
    value,
    dwell,
    win,
    tt: legs.map((row) => row.map((l) => l.hours)),
    dayStart,
    dayEnd,
    cap: settings.max_drive_hours_per_day,
    mode,
    maxStops,
  };
  return { inst, meta: { cands, legs, origin, baseZone, endZone, dates, points } };
}

function sameSpot(a: Place, b: Place): boolean {
  return Math.abs(a.lat - b.lat) < 1e-6 && Math.abs(a.lon - b.lon) < 1e-6;
}

function shoppingRun(
  kept: Candidate[],
  excluded: Excluded[],
  settings: VendorSettings,
  options: WeekendRunOptions,
  start: Place,
  end: Place,
  r: ReturnType<typeof resolveCommon>,
  altCount: number,
  t0: number,
): WeekendRunResult {
  const overnight = options.overnight ?? 'stay';
  const exactLimit = options.exactLimit ?? 12;
  const maxStops = options.maxShows ?? Infinity;
  const solveWith = (stops: number, mode: 'home' | 'stay', lastDate: string, skip: Set<string>) => {
    const cands = kept.filter((c) => !skip.has(c.show.id) && c.days.some((d) => d.date <= lastDate && d.date >= options.dates.start));
    const built = buildShopInstance(cands, settings, options, start, end, r, stops, mode, lastDate);
    const sol = solveShop(built.inst, exactLimit, { seed: options.seed ?? 1 });
    return { built, sol };
  };
  const first = solveWith(maxStops, overnight, options.dates.end, new Set());
  const describe = (x: ReturnType<typeof solveWith>, title: string) => describeShopping(x.built.inst, x.built.meta, x.sol, settings, r, options, title);
  const best = first.sol.value > 0 ? describe(first, 'Best plan') : null;
  const warnings: string[] = [];
  if (!best) warnings.push(kept.length === 0 ? 'No shows are open on these dates.' : 'No stop fits your driving limit and opening hours.');
  const alternatives: Plan[] = [];
  if (best && altCount > 0) {
    const seen = new Set([planSignature(best)]);
    const tryAdd = (make: () => ReturnType<typeof solveWith>, title: string) => {
      if (alternatives.length >= altCount) return;
      const x = make();
      if (x.sol.value <= 0) return;
      const p = describe(x, title);
      const sig = planSignature(p);
      if (seen.has(sig)) return;
      seen.add(sig);
      p.note = compareNote(p, best);
      alternatives.push(p);
    };
    if (best.stops.length >= 2) tryAdd(() => solveWith(best.stops.length - 1, overnight, options.dates.end, new Set()), 'One fewer stop');
    if (options.dates.end > options.dates.start) {
      const earlier = addDays(options.dates.end, -1);
      tryAdd(() => solveWith(maxStops, overnight, earlier, new Set()), `Home by ${formatWeekday(earlier)} night`);
    }
    if (best.hotelNights > 0 && sameSpot(start, end)) tryAdd(() => solveWith(maxStops, 'home', options.dates.end, new Set()), 'No hotel nights');
    for (const st of best.stops) tryAdd(() => solveWith(maxStops, overnight, options.dates.end, new Set([st.showId])), `Without ${st.name}`);
  }
  return {
    mode: 'shopping',
    best,
    alternatives,
    excluded,
    warnings,
    candidates: kept.length,
    exact: first.built.inst.n <= exactLimit,
    ms: Date.now() - t0,
  };
}

function describeShopping(
  inst: ShopInstance,
  meta: ShopMeta,
  sol: ShopSolution,
  settings: VendorSettings,
  r: ReturnType<typeof resolveCommon>,
  options: WeekendRunOptions,
  title: string,
): Plan {
  const sim = simulateShop(inst, sol.routes);
  if (!sim.feasible) throw new PlannerError('internal', 'The shopping route did not check out.');
  const n = inst.n;
  const BASE = n;
  const END = n + 1;
  const ms = (h: number) => meta.origin + h * MS_PER_HOUR;
  const zoneOf = (loc: number) => (loc < n ? meta.cands[loc]!.show.timezone : loc === BASE ? meta.baseZone : meta.endZone);
  const legs: PlanLeg[] = [];
  const stops: PlanStop[] = [];
  const nights: PlanNight[] = [];
  const days: PlanDay[] = [];
  const sources = new Set<LegSource>();
  let hotelNights = 0;
  let foodDays = 0;
  let prevNightHotel = false;

  const addLeg = (from: number, to: number, departH: number, dayIdx: number, kind: PlanLeg['kind']): DriveSegment => {
    const leg = meta.legs[from]![to]!;
    sources.add(leg.source);
    const zone = zoneOf(from);
    const departMs = ms(departH);
    const arriveMs = departMs + leg.hours * MS_PER_HOUR;
    const toP = meta.points[to]!;
    const seg: DriveSegment = {
      date: meta.dates[dayIdx]!,
      timezone: zone,
      arriveZone: zoneOf(to),
      departMs,
      arriveMs,
      depart: toZonedIso(departMs, zone),
      arrive: toZonedIso(arriveMs, zoneOf(to)),
      hours: leg.hours,
      miles: leg.miles,
      label: `${formatClock(departMs, zone)}: drive ${formatDuration(leg.hours)} to ${toP.name} (${formatDistance(leg.miles)})`,
    };
    legs.push({
      from: meta.points[from]!,
      to: toP,
      miles: leg.miles,
      km: leg.km,
      hours: leg.hours,
      source: leg.source,
      kind,
      segments: [seg],
      label: `Drive ${formatDuration(leg.hours)} to ${toP.name} (${formatDistance(leg.miles)})`,
    });
    return seg;
  };

  sim.days.forEach((day, t) => {
    const items: string[] = [];
    let loc = day.startLoc;
    let driveHours = 0;
    for (const v of day.visits) {
      const h = inst.tt[loc]![v.s]!;
      if (loc !== v.s && h > 0) {
        const seg = addLeg(loc, v.s, v.start - h, t, 'visit');
        items.push(seg.label);
        driveHours += h;
      }
      const c = meta.cands[v.s]!;
      const sh = c.show;
      const zone = sh.timezone;
      items.push(`Shop at ${sh.name}, ${formatClock(ms(v.start), zone)} to ${formatClock(ms(v.leave), zone)}`);
      const listed = c.days.find((d) => d.date === meta.dates[t]);
      stops.push({
        showId: sh.id,
        name: sh.name,
        town: townLabel({ city: sh.city, region: sh.region, name: sh.name }),
        lat: sh.lat,
        lon: sh.lon,
        timezone: zone,
        dates: [meta.dates[t]!],
        firstDate: meta.dates[t]!,
        lastDate: meta.dates[t]!,
        arrive: toZonedIso(ms(v.start), zone),
        arriveMs: ms(v.start),
        leave: toZonedIso(ms(v.leave), zone),
        leaveMs: ms(v.leave),
        hoursLabel: `${formatDayLabel(meta.dates[t]!)}, ${formatClock(zonedTimeToInstant(meta.dates[t]!, listed?.open ?? r.rules.defaultOpen, zone), zone)} to ${formatClock(zonedTimeToInstant(meta.dates[t]!, listed?.close ?? r.rules.defaultClose, zone), zone)}`,
        nights: 'none',
        waitlist: false,
        notes: c.flags.notes.slice(),
        deadline: null,
        vendorStatus: sh.vendor?.status ?? null,
        sales: null,
        table: null,
        score: inst.value[v.s]!,
        reasons: [],
      });
      loc = v.s;
    }
    if (day.endArrive !== null && day.endDepart !== null) {
      const target = t === inst.D - 1 ? END : BASE;
      const seg = addLeg(loc, target, day.endDepart, t, t === inst.D - 1 ? 'to_end' : 'commute');
      items.push(seg.label);
      driveHours += inst.tt[loc]![target]!;
      loc = target;
    }
    const active = day.visits.length > 0 || driveHours > 0;
    const away = active || prevNightHotel;
    if (away) foodDays += 1;
    let night: PlanNight | null = null;
    if (t < inst.D - 1) {
      const p = meta.points[loc]!;
      const hotel = loc < n;
      night = {
        date: meta.dates[t]!,
        where: hotel ? 'hotel' : 'home',
        town: p.name,
        lat: p.lat,
        lon: p.lon,
        label: hotel ? `Hotel near ${p.name}` : p.kind === 'home' ? 'Home' : `At ${p.name}`,
      };
      if (hotel) hotelNights += 1;
      prevNightHotel = hotel;
      nights.push(night);
      items.push(`Night: ${night.label}`);
    }
    if (away || night) {
      days.push({ date: meta.dates[t]!, label: formatDayLabel(meta.dates[t]!), items, driveHours, night, away });
    }
  });

  const currency = vendorCurrency(settings);
  const sheet = new CostSheet(currency, r.rates);
  const miles = legs.reduce((a, l) => a + l.miles, 0);
  const driveHours = legs.reduce((a, l) => a + l.hours, 0);
  const warnings: string[] = [];
  let fuel = null;
  try {
    fuel = fuelCostPerMile(settings, r.rates);
  } catch (e) {
    warnings.push(e instanceof PlannerError ? e.message : 'Fuel cost could not be worked out.');
  }
  if (fuel) addTripCosts(sheet, { miles, hotelNights, foodDays }, settings, fuel);
  const people = Math.max(1, Math.floor(options.people ?? 1));
  for (const st of stops) {
    const sh = meta.cands.find((c) => c.show.id === st.showId)!.show;
    const a = sh.admission;
    if (a?.free) continue;
    if (typeof a?.adult === 'number' && a.adult > 0) {
      const cur = a.currency ?? showCurrency(sh, currency);
      sheet.add('admission', `Entry: ${sh.name}`, a.adult * people, cur, `${people} ${people === 1 ? 'person' : 'people'} at ${formatMoney(a.adult, cur)}`);
    } else {
      warnings.push(`Entry price not listed for ${sh.name}.`);
    }
  }
  for (const c of meta.cands) {
    if (!stops.some((s) => s.showId === c.show.id)) continue;
    if (c.days.some((d) => !d.open || !d.close)) {
      warnings.push(
        `Hours not listed for ${c.show.name}, assumed ${formatLocalClock(r.rules.defaultOpen)} to ${formatLocalClock(r.rules.defaultClose)}.`,
      );
    }
  }
  const money = finishEstimate(null, sheet, settings, []);
  money.notes = money.notes.filter((x) => !x.startsWith('Add your typical sales'));
  money.label = profitLabel(null, money.totalCost, currency);
  const source: LegSource = sources.has('osrm') ? 'osrm' : sources.has('given') ? 'given' : 'estimate';
  return {
    kind: 'shopping',
    title,
    summary: summaryLine(stops.length, hotelNights, miles, driveHours, 'stop'),
    stops,
    legs,
    days,
    nights,
    trips: [],
    money,
    deadlines: sortDeadlines([]),
    warnings,
    departDate: days[0]?.date ?? null,
    returnDate: days[days.length - 1]?.date ?? null,
    hotelNights,
    driveHours,
    miles,
    value: sol.value,
    objective: 'visits',
    driveTimes: {
      source,
      label: source === 'osrm' ? 'Real drive times from OpenStreetMap routing (OSRM)' : 'Estimated drive times (straight line distance times a road factor)',
    },
    start: meta.points[BASE]!,
    end: meta.points[END]!,
  };
}

export { deadlineFor };
