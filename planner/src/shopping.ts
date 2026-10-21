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
      if (h > 0 || loc !== target) {
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
          if ((h > 0 || L.loc !== target) && L.time + h > inst.dayEnd[t]![target]! + EPS) continue;
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

interface Evaluated {
  routes: number[][];
  value: number;
  drive: number;
}

function better(a: Evaluated, b: Evaluated): boolean {
  if (a.value > b.value + EPS) return true;
  if (a.value < b.value - EPS) return false;
  return a.drive < b.drive - 1e-7;
}

function clone(r: number[][]): number[][] {
  return r.map((d) => d.slice());
}

function evaluate(inst: ShopInstance, routes: number[][]): Evaluated | null {
  const sim = simulateShop(inst, routes);
  return sim.feasible ? { routes, value: sim.value, drive: sim.drive } : null;
}

/** Inserts unvisited stops one at a time, best value squared per added hour first. */
function insertGreedy(inst: ShopInstance, startSol: Evaluated): Evaluated {
  let cur = startSol;
  for (;;) {
    const used = new Set(cur.routes.flat());
    if (used.size >= inst.maxStops) return cur;
    let bestCand: Evaluated | null = null;
    let bestScore = -Infinity;
    for (let s = 0; s < inst.n; s++) {
      if (used.has(s) || inst.value[s]! <= 0) continue;
      for (let t = 0; t < inst.D; t++) {
        if (!inst.win[s]![t]) continue;
        const day = cur.routes[t]!;
        for (let pos = 0; pos <= day.length; pos++) {
          const routes = clone(cur.routes);
          routes[t]!.splice(pos, 0, s);
          const ev = evaluate(inst, routes);
          if (!ev) continue;
          const added = Math.max(0, ev.drive - cur.drive);
          const score = (inst.value[s]! * inst.value[s]!) / (added + 0.05);
          if (score > bestScore + EPS || (Math.abs(score - bestScore) <= EPS && bestCand && ev.drive < bestCand.drive)) {
            bestScore = score;
            bestCand = ev;
          }
        }
      }
    }
    if (!bestCand) return cur;
    cur = bestCand;
  }
}

/** Shorter drives without changing the set: 2 opt inside a day and relocating a stop anywhere. */
function tighten(inst: ShopInstance, startSol: Evaluated): Evaluated {
  let cur = startSol;
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 200) {
    improved = false;
    for (let t = 0; t < inst.D && !improved; t++) {
      const day = cur.routes[t]!;
      for (let i = 0; i < day.length - 1 && !improved; i++) {
        for (let j = i + 1; j < day.length && !improved; j++) {
          const routes = clone(cur.routes);
          const seg = routes[t]!.slice(i, j + 1).reverse();
          routes[t]!.splice(i, j - i + 1, ...seg);
          const ev = evaluate(inst, routes);
          if (ev && better(ev, cur)) {
            cur = ev;
            improved = true;
          }
        }
      }
    }
    for (let t = 0; t < inst.D && !improved; t++) {
      for (let i = 0; i < cur.routes[t]!.length && !improved; i++) {
        const s = cur.routes[t]![i]!;
        for (let t2 = 0; t2 < inst.D && !improved; t2++) {
          if (!inst.win[s]![t2]) continue;
          const len = cur.routes[t2]!.length - (t2 === t ? 1 : 0);
          for (let pos = 0; pos <= len && !improved; pos++) {
            const routes = clone(cur.routes);
            routes[t]!.splice(i, 1);
            routes[t2]!.splice(pos, 0, s);
            const ev = evaluate(inst, routes);
            if (ev && better(ev, cur)) {
              cur = ev;
              improved = true;
            }
          }
        }
      }
    }
  }
  return cur;
}

/** Try removing one stop and refilling; keeps the change when the result is better. */
function replaceMoves(inst: ShopInstance, startSol: Evaluated): Evaluated {
  let cur = startSol;
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let t = 0; t < inst.D && !improved; t++) {
      for (let i = 0; i < cur.routes[t]!.length && !improved; i++) {
        const routes = clone(cur.routes);
        routes[t]!.splice(i, 1);
        const base = evaluate(inst, routes);
        if (!base) continue;
        const refilled = tighten(inst, insertGreedy(inst, base));
        if (better(refilled, cur)) {
          cur = refilled;
          improved = true;
        }
      }
    }
  }
  return cur;
}

export interface HeuristicOptions {
  seed?: number;
  /** Rounds of perturb and repair. Default 60 plus 4 per candidate. */
  iterations?: number;
  /** Stop early after this long. Default 400 ms. */
  timeBudgetMs?: number;
}

/** Insertion plus local search inside an iterated local search. Always returns a feasible plan. */
export function solveShopHeuristic(inst: ShopInstance, opts: HeuristicOptions = {}): ShopSolution {
  const rnd = seededRandom(opts.seed ?? 1);
  const empty: Evaluated = { routes: Array.from({ length: inst.D }, () => []), value: 0, drive: 0 };
  const emptyEval = evaluate(inst, empty.routes) ?? empty;
  const deadline = Date.now() + (opts.timeBudgetMs ?? 400);
  const iterations = opts.iterations ?? 60 + 4 * inst.n;

  const polish = (e: Evaluated) => replaceMoves(inst, tighten(inst, insertGreedy(inst, tighten(inst, e))));
  let best = polish(emptyEval);
  let cur = best;
  for (let it = 0; it < iterations; it++) {
    if (Date.now() > deadline) break;
    const routes = clone(cur.routes);
    const visits: [number, number][] = [];
    routes.forEach((d, t) => d.forEach((_, i) => visits.push([t, i])));
    const k = visits.length === 0 ? 0 : 1 + Math.floor(rnd() * Math.min(3, visits.length));
    const picked = new Set<number>();
    while (picked.size < k) picked.add(Math.floor(rnd() * visits.length));
    const remove = [...picked].map((x) => visits[x]!).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    for (const [t, i] of remove) routes[t]!.splice(i, 1);
    let start = evaluate(inst, routes) ?? emptyEval;
    if (rnd() < 0.3) {
      const flipped = clone(start.routes);
      flipped[Math.floor(rnd() * inst.D)]!.reverse();
      start = evaluate(inst, flipped) ?? start;
    }
    const cand = polish(start);
    if (better(cand, best)) best = cand;
    // Accept sideways moves sometimes so the search does not stall.
    cur = better(cand, cur) || rnd() < 0.2 ? cand : best;
  }
  return { routes: best.routes, value: best.value, drive: best.drive, exact: false };
}

/** Exact search for small sets, heuristic beyond `exactLimit`. */
export function solveShop(inst: ShopInstance, exactLimit = 12, heuristic: HeuristicOptions = {}): ShopSolution {
  return inst.n <= exactLimit ? solveShopExact(inst) : solveShopHeuristic(inst, heuristic);
}
