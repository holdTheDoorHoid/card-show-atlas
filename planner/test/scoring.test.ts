import { describe, expect, it } from 'vitest';
import { rankForShowGoer, rankForVendor, resolveWeights, scoreForShowGoer, scoreForVendor, WEIGHT_PRESETS, type PlannerShow } from '../src/index.js';
import { closeness } from '../src/factors.js';
import { sampleShows, sampleVendor, sampleVendorNoSales } from './fixtures.js';
import { genShows, genVendor, rng } from './gen.js';
import { mk, PHILLY, vendor } from './helpers.js';

const day: [string, string, string][] = [['2026-11-14', '09:00', '15:00']];
const NEAR = { lat: 40.05, lon: -75.2 };
const MID = { lat: 40.6084, lon: -75.4902 };
const FAR = { lat: 40.4406, lon: -79.9959 };

describe('show goer best match', () => {
  const q = { origin: PHILLY, interests: ['pokemon'], today: '2026-11-01' };

  it('prefers closer, bigger, matching, sooner and free, all else equal', () => {
    const base = mk('base', { days: day, ...MID, mid: 800, sells: ['pokemon'], free: false });
    const s = (x: PlannerShow) => scoreForShowGoer(x, q).score;
    expect(s({ ...base, ...NEAR })).toBeGreaterThan(s(base));
    expect(s(mk('big', { days: day, ...MID, mid: 6000, sells: ['pokemon'], free: false }))).toBeGreaterThan(s(base));
    expect(s(mk('nomatch', { days: day, ...MID, mid: 800, sells: ['baseball'], free: false }))).toBeLessThan(s(base));
    expect(s({ ...base, days: [{ date: '2026-12-20', open: '09:00', close: '15:00' }] })).toBeLessThan(s(base));
    expect(s(mk('free', { days: day, ...MID, mid: 800, sells: ['pokemon'], free: true }))).toBeGreaterThan(s(base));
  });

  it('decays gently with distance: no cliffs', () => {
    let prev = 1;
    for (let h = 0; h <= 8; h += 0.25) {
      const c = closeness(h, 1.5);
      expect(c).toBeLessThanOrEqual(prev);
      expect(prev - c).toBeLessThan(0.12);
      prev = c;
    }
  });

  it('gives plain reasons', () => {
    const r = scoreForShowGoer(mk('x', { days: day, ...MID, mid: 3000, sells: ['pokemon', 'mtg'], free: true }), { ...q, interests: ['pokemon', 'mtg'] });
    expect(r.reasons[0]).toMatch(/^\d+ h( \d+ min)? drive$|^\d+ min drive$/);
    expect(r.reasons).toContain('Has Pokémon and Magic');
    expect(r.reasons).toContain('Good sized show (about 3,000 people)');
    expect(r.reasons).toContain('In 13 days');
    expect(r.reasons).toContain('Free entry');
  });

  it('ranks the sample shows and hides past and cancelled ones', () => {
    const ranked = rankForShowGoer(sampleShows(), { ...q, today: '2026-11-20' });
    expect(ranked.length).toBeGreaterThan(5);
    for (let i = 1; i < ranked.length; i++) expect(ranked[i - 1]!.score).toBeGreaterThanOrEqual(ranked[i]!.score);
    expect(ranked.some((x) => x.showId.includes('2026-11-14'))).toBe(false);
    expect(ranked.some((x) => x.showId.startsWith('poconos'))).toBe(false);
  });
});

describe('vendor priority score', () => {
  const shows = [
    mk('cheap-near', { days: day, ...NEAR, price: 40, mid: 400, size: 'small', tpt: 5 }),
    mk('big-far', { days: day, ...FAR, price: 400, mid: 9000, size: 'major', tpt: 20 }),
    mk('mid', { days: day, ...MID, price: 120, mid: 1500, size: 'medium', tpt: 9 }),
    mk('mid2', { days: day, ...MID, price: 150, mid: 1200, size: 'medium', tpt: 8 }),
    mk('mid3', { days: day, ...MID, price: 90, mid: 900, size: 'medium', tpt: 7 }),
    mk('sold', { days: day, ...MID, status: 'sold_out' }),
    mk('closed', { days: day, ...MID, status: 'closed' }),
    mk('wait', { days: day, ...MID, status: 'waitlist' }),
    mk('late', { days: day, ...MID, deadline: '2026-10-01' }),
  ];
  const s = vendor({ typical_sales: null });
  const opts = { today: '2026-10-21' };

  it('presets change the order the way their names say', () => {
    const top = (w: 'biggest_crowds' | 'cheapest' | 'closest') => rankForVendor(shows, s, { ...opts, weights: w })[0]!.showId;
    expect(top('biggest_crowds')).toBe('big-far');
    expect(top('cheapest')).toBe('cheap-near');
    expect(top('closest')).toBe('cheap-near');
  });

  it('drops closed and sold out shows, marks waitlists, and handles past deadlines', () => {
    const ranked = rankForVendor(shows, s, opts);
    const by = new Map(ranked.map((x) => [x.showId, x]));
    expect(by.get('sold')!.excluded).toBe(true);
    expect(by.get('sold')!.excludedReason).toBe('Sold out');
    expect(by.get('closed')!.excludedReason).toBe('Applications closed');
    expect(by.get('wait')!.waitlist).toBe(true);
    expect(by.get('wait')!.reasons[0]).toBe('Waitlist only');
    expect(by.get('late')!.excludedReason).toBe('Deadline passed (Oct 1)');
    const kept = rankForVendor(shows, s, { ...opts, keepPastDeadline: true });
    const late = kept.find((x) => x.showId === 'late')!;
    expect(late.excluded).toBe(false);
    expect(late.reasons[0]).toBe('Deadline passed (Oct 1), waitlist only');
    expect(ranked.slice(-3).every((x) => x.excluded)).toBe(true);
  });

  it('explains itself in plain words', () => {
    const r = scoreForVendor(shows[0]!, s, { ...opts, peers: shows });
    expect(r.mode).toBe('points');
    expect(r.reasons.join(' | ')).toMatch(/Table is 40 USD, cheaper than most/);
    expect(r.reasons.join(' | ')).toMatch(/drive from home/);
    const far = scoreForVendor(shows[1]!, s, { ...opts, peers: shows });
    expect(far.reasons.join(' | ')).toMatch(/Big crowd expected \(about 9,000\)/);
    expect(far.reasons.join(' | ')).toMatch(/pricier than most/);
  });

  it('accepts custom weights and rejects bad ones', () => {
    expect(resolveWeights({ cost: 2, travel: 2 })).toEqual({ crowd: 0, traffic: 0, cost: 0.5, travel: 0.5, match: 0, history: 0 });
    expect(resolveWeights({})).toEqual(WEIGHT_PRESETS.balanced);
    expect(() => resolveWeights({ cost: -1 })).toThrow(/zero or more/);
    expect(() => resolveWeights('fastest' as never)).toThrow(/Unknown weight preset/);
    const onlyCrowd = rankForVendor(shows, s, { ...opts, weights: { crowd: 1 } });
    expect(onlyCrowd[0]!.showId).toBe('big-far');
  });

  it('switches to expected profit when typical sales are set', () => {
    const withSales = vendor();
    const ranked = rankForVendor(shows, withSales, opts);
    const top = ranked[0]!;
    expect(top.mode).toBe('profit');
    expect(top.profit).not.toBeNull();
    expect(top.reasons.some((x) => /^Expected (profit|loss) about/.test(x))).toBe(true);
    const profits = ranked.filter((x) => !x.excluded && x.profit?.profit).map((x) => x.profit!.profit!.mid);
    for (let i = 1; i < profits.length; i++) expect(profits[i - 1]!).toBeGreaterThanOrEqual(profits[i]! - 1e-9);
    const forced = rankForVendor(shows, withSales, { ...opts, scoreBy: 'points' });
    expect(forced[0]!.mode).toBe('points');
  });

  it('mentions own history', () => {
    const settings = sampleVendor();
    const show = sampleShows().find((x) => x.id === 'garden-state-card-show-edison-nj-2026-11-14')!;
    const r = scoreForVendor(show, { ...settings, typical_sales: null }, { today: '2026-10-21' });
    expect(r.reasons.join(' | ')).toMatch(/You rated it 4 last time and you averaged 1,250 USD here/i);
  });

  it('keeps scores between 0 and 100 on random shows', () => {
    const r = rng(21);
    for (let k = 0; k < 20; k++) {
      const list = genShows(r, { n: 40, start: '2026-11-01', spanDays: 60, center: PHILLY, spreadDeg: 3 });
      const v = genVendor(r, PHILLY, k % 2 === 0);
      for (const x of rankForVendor(list, v, { today: '2026-10-21', weights: k % 3 === 0 ? 'cheapest' : 'balanced' })) {
        if (x.score === null) continue;
        expect(x.score).toBeGreaterThanOrEqual(0);
        expect(x.score).toBeLessThanOrEqual(100);
      }
    }
  });

  it('scores the sample fixture without sales', () => {
    const ranked = rankForVendor(sampleShows(), sampleVendorNoSales(), { today: '2026-10-21' });
    expect(ranked[0]!.score).not.toBeNull();
    expect(ranked.find((x) => x.showId.startsWith('big-apple'))!.excludedReason).toBe('Sold out');
  });
});
