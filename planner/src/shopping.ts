/**
 * Shopping mode (DESIGN 6.2 and 6.3): visit several shows a day, staying a set time at each, inside
 * their opening hours. This is an orienteering problem with time windows over one or more days:
 * pick the most valuable set of visits that fits.
 *
 * Exact search (label setting over visited set, position and day, with dominance on time, driving
 * so far today and total driving) is used up to `exactLimit` candidates. Beyond that, a heuristic:
 * greedy insertion by value squared over added driving, then local search (2 opt, relocate,
 * replace, reinsert) inside an iterated local search with a seeded random number generator, so
 * results repeat exactly for the same input.
 */
import { PlannerError } from './types.js';

const EPS = 1e-9;

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
  /** Driving cap per day, hours. */
  cap: number;
  /** `home`: back to base every night. `stay`: sleep near the last show of the day. */
  mode: 'home' | 'stay';
  /** Most visits allowed in total. */
  maxStops: number;
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
  /** Location after the day's last drive (base, end, or the last show when staying). */
  endLoc: number;
  /** Arrival time of the drive back to base or end, or null when staying. */
  endArrive: number | null;
  /** Departure time of that drive. */
  endDepart: number | null;
  driveHours: number;
}

export interface ShopSim {
  feasible: boolean;
  reason: string | null;
  value: number;
  drive: number;
  days: ShopDay[];
}

export interface ShopSolution {
  routes: number[][];
  value: number;
  drive: number;
  exact: boolean;
}

/** Earliest start schedule for fixed routes. Earliest is optimal for a fixed order with time windows. */
export function simulateShop(inst: ShopInstance, routes: number[][]): ShopSim {
  const { n, D, tt, win, dwell, cap } = inst;
  const BASE = n;
  const END = n + 1;
  const seen = new Set<number>();
  let loc = BASE;
  let value = 0;
  let drive = 0;
  let count = 0;
  const days: ShopDay[] = [];
  const fail = (reason: string): ShopSim => ({ feasible: false, reason, value, drive, days });
  if (routes.length !== D) return fail('wrong number of days');
  for (let t = 0; t < D; t++) {
    const route = routes[t]!;
    let time = inst.dayStart[t]![loc]!;
    const day: ShopDay = { startLoc: loc, departAt: time, visits: [], endLoc: loc, endArrive: null, endDepart: null, driveHours: 0 };
    let dd = 0;
    for (const s of route) {
      if (s < 0 || s >= n || seen.has(s)) return fail('repeated or unknown stop');
      seen.add(s);
      count += 1;
      if (count > inst.maxStops) return fail('too many stops');
      const h = tt[loc]![s]!;
      const arrive = time + h;
      dd += h;
      if (dd > cap + EPS) return fail('over the driving cap');
      const w = win[s]![t];
      if (!w) return fail('closed that day');
      const start = Math.max(arrive, w[0]);
      if (start > w[1] + EPS) return fail('arrives too late');
      time = start + dwell;
      day.visits.push({ s, arrive, start, leave: time });
      loc = s;
      value += inst.value[s]!;
    }
    const last = t === D - 1;
    if (inst.mode === 'home' || last) {
      const target = last ? END : BASE;
      const h = tt[loc]![target]!;
      dd += h;
      if (dd > cap + EPS) return fail('over the driving cap');
      if (h > 0) {
        const arr = time + h;
        if (arr > inst.dayEnd[t]![target]! + EPS) return fail('home too late');
        day.endDepart = time;
        day.endArrive = arr;
      }
      loc = target;
    }
    day.endLoc = loc;
    day.driveHours = dd;
    drive += dd;
    days.push(day);
  }
  return { feasible: true, reason: null, value, drive, days };
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
  total: number;
  back: Lab | null;
  prevState: DayState | null;
}

interface Lab {
  mask: number;
  loc: number;
  time: number;
  dd: number;
  total: number;
  s: number;
  prev: Lab | null;
  start: DayState;
}

/** Exact optimum: most value, then least driving. Practical up to about 12 to 14 candidates. */
export function solveShopExact(inst: ShopInstance): ShopSolution {
  const { n, D, tt, win, dwell, cap } = inst;
  if (n > 20) throw new PlannerError('too_many_for_exact', 'Too many stops for the exact search.');
  const BASE = n;
  const END = n + 1;
  const key = (mask: number, loc: number) => mask * (n + 2) + loc;
  let starts = new Map<number, DayState>();
  starts.set(key(0, BASE), { mask: 0, loc: BASE, total: 0, back: null, prevState: null });
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
        if (o.time <= L.time + EPS && o.dd <= L.dd + EPS && o.total <= L.total + EPS) return;
      }
      for (let i = list.length - 1; i >= 0; i--) {
        const o = list[i]!;
        if (L.time <= o.time + EPS && L.dd <= o.dd + EPS && L.total <= o.total + EPS) list.splice(i, 1);
      }
      list.push(L);
    };
    for (const st of starts.values()) {
      insert({ mask: st.mask, loc: st.loc, time: inst.dayStart[t]![st.loc]!, dd: 0, total: st.total, s: -1, prev: null, start: st });
    }
    for (let p = 0; p <= n; p++) {
      const keys = buckets[p]!;
      for (let ki = 0; ki < keys.length; ki++) {
        const list = labels.get(keys[ki]!)!;
        if (p + 1 > inst.maxStops) continue;
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
            insert({ mask: L.mask | (1 << s), loc: s, time: start + dwell, dd, total: L.total + h, s, prev: L, start: L.start });
          }
        }
      }
    }
    const next = new Map<number, DayState>();
    const offer = (st: DayState) => {
      const k = key(st.mask, st.loc);
      const o = next.get(k);
      if (!o || st.total < o.total - EPS) next.set(k, st);
    };
    for (const list of labels.values()) {
      for (const L of list) {
        if (inst.mode === 'home' || last) {
          const target = last ? END : BASE;
          const h = tt[L.loc]![target]!;
          if (L.dd + h > cap + EPS) continue;
          if (h > 0 && L.time + h > inst.dayEnd[t]![target]! + EPS) continue;
          offer({ mask: L.mask, loc: target, total: L.total + h, back: L, prevState: L.start });
        } else {
          offer({ mask: L.mask, loc: L.loc, total: L.total, back: L, prevState: L.start });
        }
      }
    }
    starts = next;
  }

  let best: DayState | null = null;
  let bestV = -Infinity;
  for (const st of starts.values()) {
    const v = valueOf(st.mask);
    if (v > bestV + EPS || (Math.abs(v - bestV) <= EPS && best && st.total < best.total - EPS)) {
      best = st;
      bestV = v;
    }
  }
  if (!best) return { routes: Array.from({ length: D }, () => []), value: 0, drive: 0, exact: true };
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
  return { routes, value: sim.value, drive: sim.drive, exact: true };
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

/** Total driving when the routes are feasible, else minus one. Allocation free, for the heuristic. */
function quickDrive(inst: ShopInstance, routes: number[][]): number {
  const { n, D, tt, win, dwell, cap } = inst;
  const BASE = n;
  const END = n + 1;
  let loc = BASE;
  let drive = 0;
  let count = 0;
  for (let t = 0; t < D; t++) {
    const route = routes[t]!;
    let time = inst.dayStart[t]![loc]!;
    let dd = 0;
    for (let i = 0; i < route.length; i++) {
      const st = route[i]!;
      const h = tt[loc]![st]!;
      dd += h;
      if (dd > cap + EPS) return -1;
      const w = win[st]![t];
      if (!w) return -1;
      const arrive = time + h;
      const start = arrive > w[0] ? arrive : w[0];
      if (start > w[1] + EPS) return -1;
      time = start + dwell;
      loc = st;
    }
    count += route.length;
    if (count > inst.maxStops) return -1;
    if (inst.mode === 'home' || t === D - 1) {
      const target = t === D - 1 ? END : BASE;
      const h = tt[loc]![target]!;
      if (h > 0) {
        dd += h;
        if (dd > cap + EPS) return -1;
        if (time + h > inst.dayEnd[t]![target]! + EPS) return -1;
      }
      loc = target;
    }
    drive += dd;
  }
  return drive;
}

interface Sol {
  routes: number[][];
  used: boolean[];
  value: number;
  drive: number;
}

function better(a: Sol, b: Sol): boolean {
  if (a.value > b.value + EPS) return true;
  if (a.value < b.value - EPS) return false;
  return a.drive < b.drive - 1e-7;
}

function cloneSol(x: Sol): Sol {
  return { routes: x.routes.map((d) => d.slice()), used: x.used.slice(), value: x.value, drive: x.drive };
}

type Criterion = 0 | 1 | 2;

/** Adds stops one at a time until none fits. 0: value squared per added hour, 1: value per added hour, 2: value first. */
function construct(inst: ShopInstance, sol: Sol, crit: Criterion): boolean {
  let changed = false;
  for (;;) {
    let count = 0;
    for (const d of sol.routes) count += d.length;
    if (count >= inst.maxStops) return changed;
    let bs = -1;
    let bt = -1;
    let bp = -1;
    let bd = 0;
    let bScore = -Infinity;
    for (let s = 0; s < inst.n; s++) {
      const v = inst.value[s]!;
      if (sol.used[s] || v <= 0) continue;
      for (let t = 0; t < inst.D; t++) {
        if (!inst.win[s]![t]) continue;
        const r = sol.routes[t]!;
        for (let pos = 0; pos <= r.length; pos++) {
          r.splice(pos, 0, s);
          const d = quickDrive(inst, sol.routes);
          r.splice(pos, 1);
          if (d < 0) continue;
          const added = Math.max(0, d - sol.drive);
          const score = crit === 0 ? (v * v) / (added + 0.05) : crit === 1 ? v / (added + 0.05) : v * 1e6 - added;
          if (score > bScore + EPS || (Math.abs(score - bScore) <= EPS && d < bd)) {
            bScore = score;
            bs = s;
            bt = t;
            bp = pos;
            bd = d;
          }
        }
      }
    }
    if (bs < 0) return changed;
    sol.routes[bt]!.splice(bp, 0, bs);
    sol.used[bs] = true;
    sol.value += inst.value[bs]!;
    sol.drive = bd;
    changed = true;
  }
}

/** Shorter driving for the same stops: 2 opt inside a day, relocate and swap anywhere. */
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
          const d = quickDrive(inst, sol.routes);
          if (d >= 0 && d < sol.drive - 1e-7) {
            sol.drive = d;
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
        let bd = sol.drive;
        for (let t2 = 0; t2 < inst.D; t2++) {
          if (!inst.win[st]![t2]) continue;
          const r = sol.routes[t2]!;
          for (let pos = 0; pos <= r.length; pos++) {
            if (t2 === t && pos === i) continue;
            r.splice(pos, 0, st);
            const d = quickDrive(inst, sol.routes);
            r.splice(pos, 1);
            if (d >= 0 && d < bd - 1e-7) {
              bd = d;
              bt = t2;
              bp = pos;
            }
          }
        }
        sol.routes[bt]!.splice(bp, 0, st);
        if (bt !== t || bp !== i) {
          sol.drive = bd;
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
            const d = quickDrive(inst, sol.routes);
            if (d >= 0 && d < sol.drive - 1e-7) {
              sol.drive = d;
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

/** Swap a visited stop for a better unvisited one, at the best position anywhere. */
function swapIn(inst: ShopInstance, sol: Sol): boolean {
  for (let t = 0; t < inst.D; t++) {
    for (let i = 0; i < sol.routes[t]!.length; i++) {
      const st = sol.routes[t]![i]!;
      const vs = inst.value[st]!;
      sol.routes[t]!.splice(i, 1);
      let bu = -1;
      let bt = -1;
      let bp = -1;
      let bd = 0;
      let bv = vs;
      for (let u = 0; u < inst.n; u++) {
        const vu = inst.value[u]!;
        if (sol.used[u] || vu < bv - EPS) continue;
        for (let t2 = 0; t2 < inst.D; t2++) {
          if (!inst.win[u]![t2]) continue;
          const r = sol.routes[t2]!;
          for (let pos = 0; pos <= r.length; pos++) {
            r.splice(pos, 0, u);
            const d = quickDrive(inst, sol.routes);
            r.splice(pos, 1);
            if (d < 0) continue;
            const gain = vu > bv + EPS || (Math.abs(vu - bv) <= EPS && d < (bu < 0 ? sol.drive : bd) - 1e-7);
            if (gain) {
              bu = u;
              bt = t2;
              bp = pos;
              bd = d;
              bv = vu;
            }
          }
        }
      }
      if (bu >= 0) {
        sol.routes[bt]!.splice(bp, 0, bu);
        sol.used[st] = false;
        sol.used[bu] = true;
        sol.value += inst.value[bu]! - vs;
        sol.drive = bd;
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
  const removed: number[] = [];
  for (const [t, i] of [...at].sort((a, b) => b[0] - a[0] || b[1] - a[1])) {
    const st = trial.routes[t]!.splice(i, 1)[0]!;
    trial.used[st] = false;
    trial.value -= inst.value[st]!;
    removed.push(st);
  }
  const d = quickDrive(inst, trial.routes);
  if (d < 0) return null;
  trial.drive = d;
  return trial;
}

/** Remove one stop, or two, and refill; keep the change when the result is better. */
function dropAndRefill(inst: ShopInstance, sol: Sol, pairs: boolean, deadline: number): boolean {
  const visits: [number, number][] = [];
  sol.routes.forEach((d, t) => d.forEach((_, i) => visits.push([t, i])));
  for (let a = 0; a < visits.length; a++) {
    const one = removeAt(inst, sol, [visits[a]!]);
    if (one) {
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
  const d = quickDrive(inst, routes);
  return { routes, used: new Array<boolean>(inst.n).fill(false), value: 0, drive: d < 0 ? 0 : d };
}

/**
 * Insertion plus local search inside an iterated local search. Three greedy starts (value squared
 * per hour, value per hour, value first), then rounds that remove a few random stops and repair.
 * Always returns a feasible plan; repeats exactly for the same seed when the time budget is not hit.
 */
export function solveShopHeuristic(inst: ShopInstance, opts: HeuristicOptions = {}): ShopSolution {
  const rnd = seededRandom(opts.seed ?? 1);
  const deadline = Date.now() + (opts.timeBudgetMs ?? 400);
  const iterations = opts.iterations ?? 100 + 10 * inst.n;
  if (quickDrive(inst, Array.from({ length: inst.D }, () => [])) < 0) {
    return { routes: Array.from({ length: inst.D }, () => []), value: 0, drive: 0, exact: false };
  }
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
    const d = quickDrive(inst, cand.routes);
    const start = d >= 0 ? (cand.drive = d, cand) : emptySol(inst);
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
  return { routes: b.routes, value: b.value, drive: b.drive, exact: false };
}

/** Exact search for small sets, heuristic beyond `exactLimit`. */
export function solveShop(inst: ShopInstance, exactLimit = 12, heuristic: HeuristicOptions = {}): ShopSolution {
  return inst.n <= exactLimit ? solveShopExact(inst) : solveShopHeuristic(inst, heuristic);
}
