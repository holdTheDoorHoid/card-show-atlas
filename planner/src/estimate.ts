/**
 * Profit estimate for one show done on its own from home (DESIGN 7), fully itemized.
 */
import { resolveCommon, type CommonPlanOptions } from './common.js';
import { buildPriceContext, type PriceContext, type Weights } from './factors.js';
import {
  addShowCosts,
  addTripCosts,
  CostSheet,
  estimateSales,
  finishEstimate,
  vendorCurrency,
  type ProfitEstimate,
  type ProfitModel,
} from './profit.js';
import type { Travel } from './travel.js';
import type { ExchangeRates, Place, PlannerShow, PlanningRules, VendorSettings } from './types.js';
import { PlannerError } from './types.js';
import { VendingEngine } from './vending.js';

export interface StandaloneContext {
  settings: VendorSettings;
  from: Place;
  rules: PlanningRules;
  travel: Travel;
  rates: ExchangeRates | null;
  profitModel: ProfitModel;
  weights: Weights;
  priceContext: PriceContext;
}

/** Cheapest feasible way to do one show alone from the start point, priced in full. */
export function standaloneProfit(show: PlannerShow, ctx: StandaloneContext): { estimate: ProfitEstimate | null; reason: string } {
  const days = show.days.map((d) => d.date).sort();
  const engine = new VendingEngine({
    candidates: [
      {
        show,
        flags: { waitlist: false, tentative: false, deadlinePassed: false, notes: [] },
        days: [...new Map(show.days.map((d) => [d.date, d])).values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
      },
    ],
    allShows: [show],
    settings: ctx.settings,
    base: ctx.from,
    end: ctx.from,
    rangeStart: days[0]!,
    rangeEnd: days[days.length - 1]!,
    tripWithinRange: false,
    overnight: 'stay',
    chain: false,
    maxNightsAway: null,
    countCap: null,
    countReset: 'never',
    blackout: [],
    objective: ctx.settings.typical_sales ? 'profit' : 'score',
    rules: ctx.rules,
    travel: ctx.travel,
    rates: ctx.rates,
    profitModel: ctx.profitModel,
    weights: ctx.weights,
    priceContext: ctx.priceContext,
    maxChainGapDays: 0,
    travelSlackDays: 7,
    minScore: 0,
    travelHalfLifeHours: 2,
  });
  if (engine.nodes.length === 0) return { estimate: null, reason: engine.excluded[0]?.reason ?? 'Cannot be planned' };
  // Force the show into the plan even when it loses money, so the estimate is honest.
  const node = engine.nodes[0]!;
  const saved = node.valueBase;
  node.valueBase = saved + 1e9;
  const sol = engine.solve();
  node.valueBase = saved;
  if (sol.steps.length === 0) return { estimate: null, reason: 'Too far to reach in time with your driving limit' };
  let miles = 0;
  let hotelNights = 0;
  let foodDays = 0;
  for (const st of sol.steps) {
    if (st.t === 'depart') {
      miles += engine.legBase(0).miles;
      hotelNights += st.j;
      foodDays += st.j;
    } else if (st.t === 'show') {
      const nights = node.last - node.first;
      if (st.variant === 'hotel') {
        hotelNights += nights;
        foodDays += nights + 1;
      } else if (st.variant === 'commute') {
        miles += (node.dates.length - 1) * (engine.legBase(0).miles + engine.legHome(0).miles);
        foodDays += node.dates.length;
      } else {
        foodDays += 1;
      }
    } else if (st.t === 'return') {
      miles += engine.legEnd(0).miles;
      hotelNights += st.j;
      foodDays += st.j;
    }
  }
  const sheet = new CostSheet(vendorCurrency(ctx.settings), ctx.rates);
  addShowCosts(sheet, show, ctx.settings, ctx.profitModel);
  addTripCosts(sheet, { miles, hotelNights, foodDays }, ctx.settings, engine.fuel);
  const sales = estimateSales(show, ctx.settings, ctx.profitModel);
  return { estimate: finishEstimate(sales, sheet, ctx.settings), reason: '' };
}


export interface EstimateProfitOptions extends CommonPlanOptions {
  /** Where the trip starts and ends. Defaults to home. */
  from?: Place;
}

/**
 * Itemized estimate for doing one show alone: sales range, contribution, table, extras, fuel,
 * hotel and food. The trip is the cheapest one that fits the driving limit.
 */
export function estimateProfit(show: PlannerShow, settings: VendorSettings, opts: EstimateProfitOptions = {}): ProfitEstimate {
  const r = resolveCommon(settings, { ...opts, objective: 'score' });
  const from = opts.from ?? settings.home;
  if (!from) throw new PlannerError('no_home', 'Add your home location (or a start point) to estimate profit.');
  const out = standaloneProfit(show, {
    settings,
    from,
    rules: r.rules,
    travel: r.travel,
    rates: r.rates,
    profitModel: r.profitModel,
    weights: r.weights,
    priceContext: buildPriceContext([show], settings, r.rates),
  });
  if (!out.estimate) throw new PlannerError('cannot_estimate', out.reason);
  return out.estimate;
}
