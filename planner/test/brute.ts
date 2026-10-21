/**
 * Brute force references for the property tests. They share no search code with the planners:
 *
 *  * Vending: every subset of shows in date order, every combination of the model's per step
 *    options (how to leave home, how to spend nights at a multi day show, straight on or home in
 *    between, how to get home). Show counts per month are counted directly from the subset.
 *  * Shopping: depth first search over every order of visits and every split into days, with its
 *    own simulation of times, opening hours and the driving cap.
 */
import type { ShopInstance } from '../src/shopping.js';
import { dateFromEpochDay, monthIndex } from '../src/time.js';
import type { VendingEngine } from '../src/vending.js';

export interface BruteVendingOptions {
  homeOnly: boolean;
  chain: boolean;
  countCap: number | null;
  countReset: 'month' | 'never';
  maxNights: number | null;
  maxGap: number;
  hStart: number;
  hEnd: number;
  tripWithinRange: boolean;
  rangeStart: number;
}

type State = { kind: 'home'; night: number; v: number } | { kind: 'show'; i: number; m: number; na: number; v: number };

export function bruteVending(engine: VendingEngine, o: BruteVendingOptions): number {
  const nodes = engine.nodes;
  if (nodes.length > 11) throw new Error('too many for brute force');
  const order = nodes.map((_, i) => i).sort((a, b) => nodes[a]!.first - nodes[b]!.first);
  const maxN = o.maxNights ?? Infinity;
  const cf = engine.costFactor;
  let best = 0;

  const countOk = (seq: number[]): boolean => {
    if (o.countCap === null) return true;
    const counts = new Map<number, number>();
    for (const i of seq) {
      const key = o.countReset === 'month' ? monthIndex(dateFromEpochDay(nodes[i]!.first)) : 0;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const c of counts.values()) if (c > o.countCap) return false;
    return true;
  };

  const departArrivals = (t: number, homeNight: number, v: number) => {
    const T = nodes[t]!;
    const out: { m: number; na: number; v: number }[] = [];
    for (const opt of engine.departOptions(t, o.homeOnly)) {
      const depNight = T.first - 1 - opt.j;
      if (depNight < homeNight || depNight < o.hStart) continue;
      if (opt.j > 0) {
        if (opt.j > maxN) continue;
        if (o.tripWithinRange && T.first - opt.j < o.rangeStart) continue;
        if (engine.anyBlackout(T.first - opt.j, T.first - 1)) continue;
      }
      out.push({ m: opt.m, na: opt.j, v: v + opt.gain - cf * opt.cost });
    }
    return out;
  };

  const goHome = (st: Extract<State, { kind: 'show' }>): { night: number; v: number } | null => {
    const S = nodes[st.i]!;
    const r = engine.returnOption(st.i, st.m, o.homeOnly);
    if (!r) return null;
    const rDay = S.last + r.j;
    if (rDay > o.hEnd) return null;
    if (r.j > 0 && (st.na + r.j > maxN || engine.anyBlackout(S.last + 1, rDay))) return null;
    return { night: rDay, v: st.v - cf * r.cost };
  };

  const rec = (seq: number[], pos: number, st: State): number => {
    if (pos === seq.length) {
      if (st.kind === 'home') return st.v;
      const h = goHome(st);
      return h ? h.v : -Infinity;
    }
    const t = seq[pos]!;
    const T = nodes[t]!;
    const arrivals: { m: number; na: number; v: number }[] = [];
    if (st.kind === 'home') {
      arrivals.push(...departArrivals(t, st.night, st.v));
    } else {
      const S = nodes[st.i]!;
      const gap = T.first - S.last;
      if (o.chain && !o.homeOnly && gap >= 1 && gap <= o.maxGap && st.na + gap <= maxN && !engine.anyBlackout(S.last + 1, T.first - 1)) {
        const d = engine.directOption(st.i, t, st.m);
        if (d) arrivals.push({ m: d.m, na: st.na + gap, v: st.v + d.gain - cf * d.cost });
      }
      if (engine.sameBase) {
        const h = goHome(st);
        if (h) arrivals.push(...departArrivals(t, h.night, h.v));
      }
    }
    let bestV = -Infinity;
    for (const a of arrivals) {
      for (const vo of engine.variantOptions(t, a.m, a.na, o.homeOnly, maxN)) {
        const v = rec(seq, pos + 1, { kind: 'show', i: t, m: vo.m, na: vo.na, v: a.v + T.valueBase - cf * vo.cost });
        if (v > bestV) bestV = v;
      }
    }
    return bestV;
  };

  const choose = (from: number, seq: number[]) => {
    if (seq.length > 0 && countOk(seq)) {
      const v = rec(seq, 0, { kind: 'home', night: o.hStart, v: 0 });
      if (v > best) best = v;
    }
    for (let p = from; p < order.length; p++) {
      const i = order[p]!;
      if (seq.length && nodes[i]!.first <= nodes[seq[seq.length - 1]!]!.last) continue;
      seq.push(i);
      choose(p + 1, seq);
      seq.pop();
    }
  };
  choose(0, []);
  return best;
}

/** Best value, then least driving, by exhaustive depth first search. */
export function bruteShop(inst: ShopInstance): { value: number; drive: number } {
  const { n, D, tt, win, dwell, cap, mode } = inst;
  const BASE = n;
  const END = n + 1;
  let bestV = 0;
  let bestDrive = Infinity;
  const used = new Array<boolean>(n).fill(false);

  // Value zero and no driving is always possible only if staying put all trip is allowed.
  const offer = (v: number, drive: number) => {
    if (v > bestV + 1e-9 || (Math.abs(v - bestV) <= 1e-9 && drive < bestDrive - 1e-9)) {
      bestV = v;
      bestDrive = drive;
    }
  };

  const dfs = (day: number, loc: number, time: number, dd: number, total: number, v: number, count: number): void => {
    // Option: end the day here.
    const lastDay = day === D - 1;
    if (mode === 'home' || lastDay) {
      const target = lastDay ? END : BASE;
      const h = tt[loc]![target]!;
      const okCap = dd + h <= cap + 1e-9;
      const okTime = (h === 0 && loc === target) || time + h <= inst.dayEnd[day]![target]! + 1e-9;
      if (okCap && okTime) {
        if (lastDay) offer(v, total + h);
        else dfs(day + 1, BASE, inst.dayStart[day + 1]![BASE]!, 0, total + h, v, count);
      }
    } else {
      dfs(day + 1, loc, inst.dayStart[day + 1]![loc]!, 0, total, v, count);
    }
    // Option: visit another show today.
    if (count >= inst.maxStops) return;
    for (let s = 0; s < n; s++) {
      if (used[s]) continue;
      const w = win[s]![day];
      if (!w) continue;
      const h = tt[loc]![s]!;
      if (dd + h > cap + 1e-9) continue;
      const start = Math.max(time + h, w[0]);
      if (start > w[1] + 1e-9) continue;
      used[s] = true;
      dfs(day, s, start + dwell, dd + h, total + h, v + inst.value[s]!, count + 1);
      used[s] = false;
    }
  };
  dfs(0, BASE, inst.dayStart[0]![BASE]!, 0, 0, 0, 0);
  return { value: bestV, drive: bestDrive === Infinity ? 0 : bestDrive };
}
