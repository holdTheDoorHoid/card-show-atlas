/**
 * Shopping mode (DESIGN 6.2 and 6.3): visit several shows a day, staying a set time at each, inside
 * their opening hours. This is an orienteering problem with time windows over one or more days.
 *
 * The goal is the most worthwhile weekend, not the most stops: the value of the visits minus a
 * penalty for every hour of driving and every hotel night (`hourPenalty`, `nightPenalty`, set by
 * "how much do you mind driving"). With equal totals, less driving wins.
 *
 * Nights: in `home` mode you sleep at home every night. In `stay` mode each night is either at home
 * or in a hotel near the day's last stop, whichever makes the plan better.
 *
 * Exact search (label setting over visited set, position and day, with dominance on time, driving
 * so far today and penalty so far) is used up to `exactLimit` candidates. Beyond that, a heuristic:
 * greedy insertion, then local search (2 opt, relocate, swap, replace, drop and refill) inside an
 * iterated local search with a seeded random number generator, so results repeat exactly for the
 * same input.
 */
import { PlannerError } from './types.js';

const EPS = 1e-9;
/** Tie break: with equal totals, a plan with less driving is better. */
const TIE = 1e-6;

export interface ShopInstance {
  /** Number of candidate shows. Locations 0..n-1 are shows, n is the base, n+1 is the end point. */
  n: number;
  /** Number of days. */
  D: number;
  value: number[];
  /** Visit length in hours. */
  dwell: number;
  /** `win[s][t]`: earliest and latest visit start on day t, in hours from the origin; null when closed. */
  win: ([number, number] | null)[][];
  /** Travel hours between locations, size (n+2) by (n+2). */
  tt: number[][];
  /** `dayStart[t][loc]`: earliest departure on day t from loc (shows and base), hours from the origin. */
  dayStart: number[][];
  /** `dayEnd[t][loc]`: latest arrival at loc at the end of day t (base, end point or a show). */
  dayEnd: number[][];
  /** Driving cap per day, hours. No single drive can be longer than this either. */
  cap: number;
  /** `home`: back to base every night. `stay`: home or a hotel near the last stop, whichever is better. */
  mode: 'home' | 'stay';
  /** Most visits allowed in total. */
  maxStops: number;
  /** Points taken off for each hour of driving. Default 0. */
  hourPenalty?: number;
  /** Points taken off for each hotel night. Default 0. */
  nightPenalty?: number;
}

export interface ShopVisit {
  s: number;
  arrive: number;
  start: number;
  leave: number;
}

export interface ShopDay {
  startLoc: number;
  departAt: number;
  visits: ShopVisit[];
  /** Where you sleep after this day (base, end, or the last show when staying). */
  endLoc: number;
  /** Arrival time of the drive back to base or end, or null when staying or already there. */
  endArrive: number | null;
  /** Departure time of that drive. */
  endDepart: number | null;
  driveHours: number;
  /** The night after this day: home, hotel, or null after the last day. */
  night: 'home' | 'hotel' | null;
}

export interface ShopSim {
  feasible: boolean;
  reason: string | null;
  value: number;
  drive: number;
  hotelNights: number;
  /** Driving and night penalties (plus the tiny driving tie break). */
  penalty: number;
  /** value minus penalty: what the search maximizes */
  objective: number;
  days: ShopDay[];
}

export interface ShopSolution {
  routes: number[][];
  value: number;
  drive: number;
  hotelNights: number;
  penalty: number;
  objective: number;
  exact: boolean;
}

function penalties(inst: ShopInstance): { ph: number; pn: number } {
  return { ph: (inst.hourPenalty ?? 0) + TIE, pn: inst.nightPenalty ?? 0 };
}

interface DayRun {
  ok: boolean;
  reason: string | null;
  time: number;
  dd: number;
  last: number;
  visits: ShopVisit[] | null;
}

/** Runs one day's visits from a start location, earliest start at each stop. No end of day drive. */
function runDay(inst: ShopInstance, t: number, startLoc: number, route: number[], detail: boolean): DayRun {
  const { tt, win, dwell, cap } = inst;
  let loc = startLoc;
  let time = inst.dayStart[t]![loc]!;
  let dd = 0;
  const visits: ShopVisit[] | null = detail ? [] : null;
  for (let i = 0; i < route.length; i++) {
    const s = route[i]!;
    const h = tt[loc]![s]!;
    dd += h;
    if (dd > cap + EPS) return { ok: false, reason: 'over the driving cap', time, dd, last: loc, visits };
    const w = win[s]![t];
    if (!w) return { ok: false, reason: 'closed that day', time, dd, last: loc, visits };
    const arrive = time + h;
    const start = arrive > w[0] ? arrive : w[0];
    if (start > w[1] + EPS) return { ok: false, reason: 'arrives too late', time, dd, last: loc, visits };
    time = start + dwell;
    visits?.push({ s, arrive, start, leave: time });
    loc = s;
  }
  return { ok: true, reason: null, time, dd, last: loc, visits };
}

interface NightState {
  loc: number;
  pen: number;
  drive: number;
  nights: number;
  days: ShopDay[];
}

/**
 * Times for fixed routes, with the best choice of where to sleep each night. Earliest start is
 * optimal for a fixed order with time windows; the nights are chosen by a small search over the
 * two places you can be each night (home, or near the day's last stop).
 */
export function simulateShop(inst: ShopInstance, routes: number[][]): ShopSim {
  const { n, D, tt, cap } = inst;
  const BASE = n;
  const END = n + 1;
  const { ph, pn } = penalties(inst);
  const fail = (reason: string): ShopSim => ({ feasible: false, reason, value: 0, drive: 0, hotelNights: 0, penalty: 0, objective: -Infinity, days: [] });
  if (routes.length !== D) return fail('wrong number of days');
  const seen = new Set<number>();
  let value = 0;
  let count = 0;
  for (const r of routes) {
    for (const s of r) {
      if (s < 0 || s >= n || seen.has(s)) return fail('repeated or unknown stop');
      seen.add(s);
      value += inst.value[s]!;
      count += 1;
    }
  }
  if (count > inst.maxStops) return fail('too many stops');

  let states: NightState[] = [{ loc: BASE, pen: 0, drive: 0, nights: 0, days: [] }];
  let reason = 'no plan fits';
  for (let t = 0; t < D; t++) {
    const last = t === D - 1;
    const next = new Map<number, NightState>();
    const offer = (st: NightState) => {
      const o = next.get(st.loc);
      if (!o || st.pen < o.pen - EPS) next.set(st.loc, st);
    };
    for (const st of states) {
      const run = runDay(inst, t, st.loc, routes[t]!, true);
      if (!run.ok) {
        reason = run.reason ?? reason;
        continue;
      }
      const base: Omit<ShopDay, 'endLoc' | 'endArrive' | 'endDepart' | 'driveHours' | 'night'> = {
        startLoc: st.loc,
        departAt: inst.dayStart[t]![st.loc]!,
        visits: run.visits!,
      };
      const target = last ? END : BASE;
      const h = tt[run.last]![target]!;
      if (run.dd + h <= cap + EPS && (h === 0 || run.time + h <= inst.dayEnd[t]![target]! + EPS)) {
        offer({
          loc: target,
          pen: st.pen + ph * (run.dd + h),
          drive: st.drive + run.dd + h,
          nights: st.nights,
          days: [
            ...st.days,
            { ...base, endLoc: target, endArrive: h > 0 ? run.time + h : null, endDepart: h > 0 ? run.time : null, driveHours: run.dd + h, night: last ? null : 'home' },
          ],
        });
      } else {
        reason = run.dd + h > cap + EPS ? 'over the driving cap' : 'home too late';
      }
      if (!last && inst.mode === 'stay' && run.last !== BASE) {
        offer({
          loc: run.last,
          pen: st.pen + ph * run.dd + pn,
          drive: st.drive + run.dd,
          nights: st.nights + 1,
          days: [...st.days, { ...base, endLoc: run.last, endArrive: null, endDepart: null, driveHours: run.dd, night: 'hotel' }],
        });
      }
    }
    states = [...next.values()];
    if (states.length === 0) return fail(reason);
  }
  let best: NightState | null = null;
  for (const st of states) if (st.loc === END && (!best || st.pen < best.pen - EPS)) best = st;
  if (!best) return fail(reason);
  return {
    feasible: true,
    reason: null,
    value,
    drive: best.drive,
    hotelNights: best.nights,
    penalty: best.pen,
    objective: value - best.pen,
    days: best.days,
  };
}

/** The penalty of fixed routes with the best nights, or minus one when they do not fit. No allocation. */
function quickPenalty(inst: ShopInstance, routes: number[][]): number {
  const { n, D, tt, win, dwell, cap } = inst;
  const BASE = n;
  const END = n + 1;
  const ph = (inst.hourPenalty ?? 0) + TIE;
  const pn = inst.nightPenalty ?? 0;
  const stay = inst.mode === 'stay';
  // At most two places to be each night: state A and state B.
  let aLoc = BASE;
  let aPen = 0;
  let aOk = true;
  let bLoc = -1;
  let bPen = 0;
  let bOk = false;
  let count = 0;
  for (let t = 0; t < D; t++) {
    const route = routes[t]!;
    count += route.length;
    if (count > inst.maxStops) return -1;
    const last = t === D - 1;
    let naLoc = -1;
    let naPen = Infinity;
    let nbLoc = -1;
    let nbPen = Infinity;
    for (let which = 0; which < 2; which++) {
      const ok = which === 0 ? aOk : bOk;
      if (!ok) continue;
      let loc = which === 0 ? aLoc : bLoc;
      const pen0 = which === 0 ? aPen : bPen;
      let time = inst.dayStart[t]![loc]!;
      let dd = 0;
      let good = true;
      for (let i = 0; i < route.length; i++) {
        const s = route[i]!;
        const h = tt[loc]![s]!;
        dd += h;
        const w = win[s]![t];
        if (dd > cap + EPS || !w) {
          good = false;
          break;
        }
        const arrive = time + h;
        const start = arrive > w[0] ? arrive : w[0];
        if (start > w[1] + EPS) {
          good = false;
          break;
        }
        time = start + dwell;
        loc = s;
      }
      if (!good) continue;
      const target = last ? END : BASE;
      const h = tt[loc]![target]!;
      if (dd + h <= cap + EPS && (h === 0 || time + h <= inst.dayEnd[t]![target]! + EPS)) {
        const p = pen0 + ph * (dd + h);
        if (naLoc === target || naLoc === -1) {
          if (p < naPen) {
            naLoc = target;
            naPen = p;
          }
        } else if (nbLoc === target || nbLoc === -1) {
          if (p < nbPen) {
            nbLoc = target;
            nbPen = p;
          }
        }
      }
      if (!last && stay && loc !== BASE) {
        const p = pen0 + ph * dd + pn;
        if (naLoc === loc || naLoc === -1) {
          if (p < naPen) {
            naLoc = loc;
            naPen = p;
          }
        } else if (nbLoc === loc || nbLoc === -1) {
          if (p < nbPen) {
            nbLoc = loc;
            nbPen = p;
          }
        }
      }
    }
    aOk = naLoc !== -1;
    aLoc = naLoc;
    aPen = naPen;
    bOk = nbLoc !== -1;
    bLoc = nbLoc;
    bPen = nbPen;
    if (!aOk && !bOk) return -1;
  }
  let best = Infinity;
  if (aOk && aLoc === END) best = aPen;
  if (bOk && bLoc === END && bPen < best) best = bPen;
  return best === Infinity ? -1 : best;
}

function popcount(x: number): number {
  let c = 0;
  while (x) {
    x &= x - 1;
    c += 1;
  }
  return c;
}

interface DayState {
  mask: number;
  loc: number;
  pen: number;
  back: Lab | null;
  prevState: DayState | null;
}

interface Lab {
  mask: number;
  loc: number;
  time: number;
  dd: number;
  pen0: number;
  s: number;
  prev: Lab | null;
  start: DayState;
}

/** Exact optimum of value minus penalties. Practical up to about 10 to 12 candidates. */
export function solveShopExact(inst: ShopInstance): ShopSolution {
  const { n, D, tt, win, dwell, cap } = inst;
  if (n > 20) throw new PlannerError('too_many_for_exact', 'Too many stops for the exact search.');
  const BASE = n;
  const END = n + 1;
  const { ph, pn } = penalties(inst);
  const key = (mask: number, loc: number) => mask * (n + 2) + loc;
  let starts = new Map<number, DayState>();
  starts.set(key(0, BASE), { mask: 0, loc: BASE, pen: 0, back: null, prevState: null });
  const valueOf = (mask: number) => {
    let v = 0;
    for (let s = 0; s < n; s++) if (mask & (1 << s)) v += inst.value[s]!;
    return v;
  };

  for (let t = 0; t < D; t++) {
    const last = t === D - 1;
    const labels = new Map<number, Lab[]>();
    const buckets: number[][] = Array.from({ length: n + 1 }, () => []);
    const insert = (L: Lab): void => {
      const k = key(L.mask, L.loc);
      let list = labels.get(k);
      if (!list) {
        list = [];
        labels.set(k, list);
        buckets[popcount(L.mask)]!.push(k);
      }
      for (const o of list) {
        if (o.time <= L.time + EPS && o.dd <= L.dd + EPS && o.pen0 <= L.pen0 + EPS) return;
      }
      for (let i = list.length - 1; i >= 0; i--) {
        const o = list[i]!;
        if (L.time <= o.time + EPS && L.dd <= o.dd + EPS && L.pen0 <= o.pen0 + EPS) list.splice(i, 1);
      }
      list.push(L);
    };
    for (const st of starts.values()) {
      insert({ mask: st.mask, loc: st.loc, time: inst.dayStart[t]![st.loc]!, dd: 0, pen0: st.pen, s: -1, prev: null, start: st });
    }
    for (let p = 0; p <= n; p++) {
      const keys = buckets[p]!;
      if (p + 1 > inst.maxStops) continue;
      for (let ki = 0; ki < keys.length; ki++) {
        const list = labels.get(keys[ki]!)!;
        for (const L of list.slice()) {
          for (let s = 0; s < n; s++) {
            if (L.mask & (1 << s)) continue;
            const w = win[s]![t];
            if (!w) continue;
            const h = tt[L.loc]![s]!;
            const dd = L.dd + h;
            if (dd > cap + EPS) continue;
            const start = Math.max(L.time + h, w[0]);
            if (start > w[1] + EPS) continue;
            insert({ mask: L.mask | (1 << s), loc: s, time: start + dwell, dd, pen0: L.pen0, s, prev: L, start: L.start });
          }
        }
      }
    }
    const next = new Map<number, DayState>();
    const offer = (st: DayState) => {
      const k = key(st.mask, st.loc);
      const o = next.get(k);
      if (!o || st.pen < o.pen - EPS) next.set(k, st);
    };
    for (const list of labels.values()) {
      for (const L of list) {
        const target = last ? END : BASE;
        const h = tt[L.loc]![target]!;
        if (L.dd + h <= cap + EPS && (h === 0 || L.time + h <= inst.dayEnd[t]![target]! + EPS)) {
          offer({ mask: L.mask, loc: target, pen: L.pen0 + ph * (L.dd + h), back: L, prevState: L.start });
        }
        if (!last && inst.mode === 'stay' && L.loc !== BASE) {
          offer({ mask: L.mask, loc: L.loc, pen: L.pen0 + ph * L.dd + pn, back: L, prevState: L.start });
        }
      }
    }
    starts = next;
  }

  let best: DayState | null = null;
  let bestObj = -Infinity;
  for (const st of starts.values()) {
    if (st.loc !== END) continue;
    const obj = valueOf(st.mask) - st.pen;
    if (obj > bestObj + EPS) {
      best = st;
      bestObj = obj;
    }
  }
  const empty = { routes: Array.from({ length: D }, () => []), value: 0, drive: 0, hotelNights: 0, penalty: 0, objective: 0, exact: true };
  if (!best) return empty;
  const routes: number[][] = [];
  let st: DayState | null = best;
  while (st && st.back) {
    const day: number[] = [];
    let L: Lab | null = st.back;
    while (L && L.s >= 0) {
      day.push(L.s);
      L = L.prev;
    }
    routes.push(day.reverse());
    st = st.prevState;
  }
  routes.reverse();
  while (routes.length < D) routes.push([]);
  const sim = simulateShop(inst, routes);
  return { routes, value: sim.value, drive: sim.drive, hotelNights: sim.hotelNights, penalty: sim.penalty, objective: sim.objective, exact: true };
}

/** Small seeded generator (mulberry32) so the heuristic is repeatable. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Sol {
  routes: number[][];
  used: boolean[];
  value: number;
  pen: number;
}

const objective = (x: Sol) => x.value - x.pen;

function better(a: Sol, b: Sol): boolean {
  return objective(a) > objective(b) + EPS;
}

function cloneSol(x: Sol): Sol {
  return { routes: x.routes.map((d) => d.slice()), used: x.used.slice(), value: x.value, pen: x.pen };
}

type Criterion = 0 | 1 | 2;

/**
 * Adds stops one at a time while one makes the plan better. 0: value squared per added penalty,
 * 1: gain per added penalty, 2: biggest gain first.
 */
function construct(inst: ShopInstance, sol: Sol, crit: Criterion): boolean {
  let changed = false;
  for (;;) {
    let count = 0;
    for (const d of sol.routes) count += d.length;
    if (count >= inst.maxStops) return changed;
    let bs = -1;
    let bt = -1;
    let bp = -1;
    let bPen = 0;
    let bScore = -Infinity;
    for (let s = 0; s < inst.n; s++) {
      const v = inst.value[s]!;
      if (sol.used[s] || v <= 0) continue;
      for (let t = 0; t < inst.D; t++) {
        if (!inst.win[s]![t]) continue;
        const r = sol.routes[t]!;
        for (let pos = 0; pos <= r.length; pos++) {
          r.splice(pos, 0, s);
          const pen = quickPenalty(inst, sol.routes);
          r.splice(pos, 1);
          if (pen < 0) continue;
          const added = pen - sol.pen;
          const gain = v - added;
          if (gain <= EPS) continue;
          const room = Math.max(0, added) + 0.05;
          const score = crit === 0 ? (v * v) / room : crit === 1 ? gain / room : gain;
          if (score > bScore + EPS || (Math.abs(score - bScore) <= EPS && pen < bPen)) {
            bScore = score;
            bs = s;
            bt = t;
            bp = pos;
            bPen = pen;
          }
        }
      }
    }
    if (bs < 0) return changed;
    sol.routes[bt]!.splice(bp, 0, bs);
    sol.used[bs] = true;
    sol.value += inst.value[bs]!;
    sol.pen = bPen;
    changed = true;
  }
}

/** Lower penalty for the same stops: 2 opt inside a day, relocate and swap anywhere. */
function tighten(inst: ShopInstance, sol: Sol): boolean {
  let any = false;
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 100) {
    improved = false;
    for (let t = 0; t < inst.D; t++) {
      const day = sol.routes[t]!;
      for (let i = 0; i < day.length - 1; i++) {
        for (let j = i + 1; j < day.length; j++) {
          reverse(day, i, j);
          const p = quickPenalty(inst, sol.routes);
          if (p >= 0 && p < sol.pen - 1e-9) {
            sol.pen = p;
            improved = true;
          } else {
            reverse(day, i, j);
          }
        }
      }
    }
    for (let t = 0; t < inst.D; t++) {
      for (let i = 0; i < sol.routes[t]!.length; i++) {
        const st = sol.routes[t]![i]!;
        sol.routes[t]!.splice(i, 1);
        let bt = t;
        let bp = i;
        let bPen = sol.pen;
        for (let t2 = 0; t2 < inst.D; t2++) {
          if (!inst.win[st]![t2]) continue;
          const r = sol.routes[t2]!;
          for (let pos = 0; pos <= r.length; pos++) {
            if (t2 === t && pos === i) continue;
            r.splice(pos, 0, st);
            const p = quickPenalty(inst, sol.routes);
            r.splice(pos, 1);
            if (p >= 0 && p < bPen - 1e-9) {
              bPen = p;
              bt = t2;
              bp = pos;
            }
          }
        }
        sol.routes[bt]!.splice(bp, 0, st);
        if (bt !== t || bp !== i) {
          sol.pen = bPen;
          improved = true;
        }
      }
    }
    for (let t = 0; t < inst.D; t++) {
      for (let i = 0; i < sol.routes[t]!.length; i++) {
        for (let t2 = t; t2 < inst.D; t2++) {
          for (let j = t2 === t ? i + 1 : 0; j < sol.routes[t2]!.length; j++) {
            const a = sol.routes[t]![i]!;
            const b = sol.routes[t2]![j]!;
            if (!inst.win[a]![t2] || !inst.win[b]![t]) continue;
            sol.routes[t]![i] = b;
            sol.routes[t2]![j] = a;
            const p = quickPenalty(inst, sol.routes);
            if (p >= 0 && p < sol.pen - 1e-9) {
              sol.pen = p;
              improved = true;
            } else {
              sol.routes[t]![i] = a;
              sol.routes[t2]![j] = b;
            }
          }
        }
      }
    }
    if (improved) any = true;
  }
  return any;
}

function reverse(a: number[], i: number, j: number): void {
  while (i < j) {
    const x = a[i]!;
    a[i] = a[j]!;
    a[j] = x;
    i += 1;
    j -= 1;
  }
}

/** Swap a visited stop for an unvisited one at its best position anywhere, when that is better. */
function swapIn(inst: ShopInstance, sol: Sol): boolean {
  for (let t = 0; t < inst.D; t++) {
    for (let i = 0; i < sol.routes[t]!.length; i++) {
      const st = sol.routes[t]![i]!;
      const vs = inst.value[st]!;
      sol.routes[t]!.splice(i, 1);
      let bu = -1;
      let bt = -1;
      let bp = -1;
      let bPen = 0;
      // The objective with `st` still counted: a swap has to beat it.
      let bObj = objective(sol);
      for (let u = 0; u < inst.n; u++) {
        if (sol.used[u] || u === st) continue;
        const vu = inst.value[u]!;
        for (let t2 = 0; t2 < inst.D; t2++) {
          if (!inst.win[u]![t2]) continue;
          const r = sol.routes[t2]!;
          for (let pos = 0; pos <= r.length; pos++) {
            r.splice(pos, 0, u);
            const p = quickPenalty(inst, sol.routes);
            r.splice(pos, 1);
            if (p < 0) continue;
            const obj = sol.value - vs + vu - p;
            if (obj > bObj + EPS) {
              bObj = obj;
              bu = u;
              bt = t2;
              bp = pos;
              bPen = p;
            }
          }
        }
      }
      if (bu >= 0) {
        sol.routes[bt]!.splice(bp, 0, bu);
        sol.used[st] = false;
        sol.used[bu] = true;
        sol.value += inst.value[bu]! - vs;
        sol.pen = bPen;
        return true;
      }
      sol.routes[t]!.splice(i, 0, st);
    }
  }
  return false;
}

/** Refill after a removal with each insertion rule and keep the best result. */
function refill(inst: ShopInstance, base: Sol, banned: number[]): Sol {
  let best: Sol | null = null;
  for (const crit of [0, 1, 2] as Criterion[]) {
    const trial = cloneSol(base);
    // Do not let the removed stops straight back in where they were.
    const keep = banned.map((st) => inst.value[st]!);
    for (const st of banned) inst.value[st] = 0;
    construct(inst, trial, crit);
    banned.forEach((st, k) => (inst.value[st] = keep[k]!));
    construct(inst, trial, crit);
    tighten(inst, trial);
    if (!best || better(trial, best)) best = trial;
  }
  return best!;
}

function removeAt(inst: ShopInstance, sol: Sol, at: [number, number][]): Sol | null {
  const trial = cloneSol(sol);
  for (const [t, i] of [...at].sort((a, b) => b[0] - a[0] || b[1] - a[1])) {
    const st = trial.routes[t]!.splice(i, 1)[0]!;
    trial.used[st] = false;
    trial.value -= inst.value[st]!;
  }
  const p = quickPenalty(inst, trial.routes);
  if (p < 0) return null;
  trial.pen = p;
  return trial;
}

/** Remove one stop, or two, and refill; keep the change when the result is better. */
function dropAndRefill(inst: ShopInstance, sol: Sol, pairs: boolean, deadline: number): boolean {
  const visits: [number, number][] = [];
  sol.routes.forEach((d, t) => d.forEach((_, i) => visits.push([t, i])));
  for (let a = 0; a < visits.length; a++) {
    const one = removeAt(inst, sol, [visits[a]!]);
    if (one) {
      if (better(one, sol)) {
        Object.assign(sol, one);
        return true;
      }
      const r = refill(inst, one, [sol.routes[visits[a]![0]]![visits[a]![1]]!]);
      if (better(r, sol)) {
        Object.assign(sol, r);
        return true;
      }
    }
    if (!pairs) continue;
    for (let b = a + 1; b < visits.length; b++) {
      if (Date.now() > deadline) return false;
      const two = removeAt(inst, sol, [visits[a]!, visits[b]!]);
      if (!two) continue;
      const banned = [sol.routes[visits[a]![0]]![visits[a]![1]]!, sol.routes[visits[b]![0]]![visits[b]![1]]!];
      const r = refill(inst, two, banned);
      if (better(r, sol)) {
        Object.assign(sol, r);
        return true;
      }
    }
  }
  return false;
}

function localSearch(inst: ShopInstance, sol: Sol, deadline: number, pairs: boolean): void {
  let guard = 0;
  while (guard++ < 200) {
    tighten(inst, sol);
    if (construct(inst, sol, 0)) continue;
    if (swapIn(inst, sol)) continue;
    if (Date.now() > deadline) return;
    if (dropAndRefill(inst, sol, false, deadline)) continue;
    if (pairs && dropAndRefill(inst, sol, true, deadline)) continue;
    return;
  }
}

export interface HeuristicOptions {
  seed?: number;
  /** Rounds of perturb and repair. Default 100 plus 10 per candidate. */
  iterations?: number;
  /** Stop early after this long. Default 400 ms. */
  timeBudgetMs?: number;
  /** Stop after this many rounds without a better plan. Default 25, or 3 per candidate if more. */
  patience?: number;
}

function emptySol(inst: ShopInstance): Sol {
  const routes = Array.from({ length: inst.D }, () => [] as number[]);
  const p = quickPenalty(inst, routes);
  return { routes, used: new Array<boolean>(inst.n).fill(false), value: 0, pen: p < 0 ? 0 : p };
}

function finish(inst: ShopInstance, routes: number[][], exact: boolean): ShopSolution {
  const sim = simulateShop(inst, routes);
  if (!sim.feasible) return { routes: Array.from({ length: inst.D }, () => []), value: 0, drive: 0, hotelNights: 0, penalty: 0, objective: 0, exact };
  return { routes, value: sim.value, drive: sim.drive, hotelNights: sim.hotelNights, penalty: sim.penalty, objective: sim.objective, exact };
}

/**
 * Insertion plus local search inside an iterated local search. Three greedy starts, then rounds
 * that remove a few random stops (or a whole day) and repair. Always returns a feasible plan;
 * repeats exactly for the same seed when the time budget is not hit.
 */
export function solveShopHeuristic(inst: ShopInstance, opts: HeuristicOptions = {}): ShopSolution {
  const rnd = seededRandom(opts.seed ?? 1);
  const deadline = Date.now() + (opts.timeBudgetMs ?? 400);
  const iterations = opts.iterations ?? 100 + 10 * inst.n;
  if (quickPenalty(inst, Array.from({ length: inst.D }, () => [])) < 0) return finish(inst, Array.from({ length: inst.D }, () => []), false);
  let best: Sol | null = null;
  for (const crit of [0, 1, 2] as Criterion[]) {
    const sol = emptySol(inst);
    construct(inst, sol, crit);
    localSearch(inst, sol, deadline, true);
    if (!best || better(sol, best)) best = sol;
  }
  let cur = cloneSol(best!);
  const patience = opts.patience ?? Math.max(25, 3 * inst.n);
  let stale = 0;
  for (let it = 0; it < iterations && stale < patience; it++) {
    if (Date.now() > deadline) break;
    stale += 1;
    const cand = cloneSol(cur);
    const visits: [number, number][] = [];
    cand.routes.forEach((d, t) => d.forEach((_, i) => visits.push([t, i])));
    if (visits.length > 0) {
      if (rnd() < 0.15) {
        const t = Math.floor(rnd() * inst.D);
        for (const st of cand.routes[t]!) {
          cand.used[st] = false;
          cand.value -= inst.value[st]!;
        }
        cand.routes[t] = [];
      } else {
        const k = 1 + Math.floor(rnd() * Math.min(3, visits.length));
        const picked = new Set<number>();
        while (picked.size < k) picked.add(Math.floor(rnd() * visits.length));
        const remove = [...picked].map((x) => visits[x]!).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
        for (const [t, i] of remove) {
          const st = cand.routes[t]!.splice(i, 1)[0]!;
          cand.used[st] = false;
          cand.value -= inst.value[st]!;
        }
      }
    }
    const p = quickPenalty(inst, cand.routes);
    const start = p >= 0 ? ((cand.pen = p), cand) : emptySol(inst);
    const crit = (Math.floor(rnd() * 3) % 3) as Criterion;
    construct(inst, start, crit);
    localSearch(inst, start, deadline, false);
    if (better(start, best!)) {
      best = cloneSol(start);
      stale = 0;
    }
    cur = better(start, cur) || rnd() < 0.1 ? start : cloneSol(best!);
  }
  const b = best!;
  localSearch(inst, b, deadline, true);
  return finish(inst, b.routes, false);
}

/** Exact search for small sets, heuristic beyond `exactLimit`. */
export function solveShop(inst: ShopInstance, exactLimit = 10, heuristic: HeuristicOptions = {}): ShopSolution {
  return inst.n <= exactLimit ? solveShopExact(inst) : solveShopHeuristic(inst, heuristic);
}
