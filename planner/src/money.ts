/**
 * Currency handling. Amounts in different currencies are never added together unless the user
 * passed an explicit exchange rate, and every conversion is reported in plain words.
 */
import { formatMoney } from './format.js';
import type { Currency, ExchangeRates } from './types.js';

export interface Money {
  amount: number;
  currency: Currency;
}

/** How many `to` for one `from`, or null when no rate was given. */
export function rateFor(from: Currency, to: Currency, rates?: ExchangeRates | null): number | null {
  if (from === to) return 1;
  if (!rates) return null;
  const direct = rates[`${from}_${to}`];
  if (typeof direct === 'number' && Number.isFinite(direct) && direct > 0) return direct;
  const inverse = rates[`${to}_${from}`];
  if (typeof inverse === 'number' && Number.isFinite(inverse) && inverse > 0) return 1 / inverse;
  return null;
}

export interface Conversion {
  from: Money;
  to: Money;
  rate: number;
  /** "Converted 150 CAD to 110 USD at 0.73, the rate you entered." */
  note: string;
}

/** Converts with an explicit rate. Returns null when no rate is known for the pair. */
export function convert(amount: number, from: Currency, to: Currency, rates?: ExchangeRates | null): Conversion | null {
  const rate = rateFor(from, to, rates);
  if (rate === null) return null;
  const converted = amount * rate;
  return {
    from: { amount, currency: from },
    to: { amount: converted, currency: to },
    rate,
    note:
      from === to
        ? ''
        : `Converted ${formatMoney(amount, from)} to ${formatMoney(converted, to)} at ${formatRate(rate)}, the rate you entered.`,
  };
}

function formatRate(rate: number): string {
  return rate >= 10 ? rate.toFixed(2) : rate.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

/** Sums kept per currency. */
export class MoneyBag {
  private readonly totals = new Map<Currency, number>();

  add(amount: number, currency: Currency): this {
    this.totals.set(currency, (this.totals.get(currency) ?? 0) + amount);
    return this;
  }

  currencies(): Currency[] {
    return [...this.totals.keys()].sort();
  }

  get(currency: Currency): number {
    return this.totals.get(currency) ?? 0;
  }

  toObject(): Record<Currency, number> {
    const out: Record<Currency, number> = {};
    for (const c of this.currencies()) out[c] = this.get(c);
    return out;
  }
}
