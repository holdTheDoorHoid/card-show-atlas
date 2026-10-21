import { describe, expect, it } from 'vitest';
import { deadlinesInOrder, legText, legTitle, monthTitle, money, orderedCosts, stopsByMonth, tripStops } from './plan-view.ts';

const stop = (id: string, first: string) => ({ showId: id, name: id, firstDate: first, lastDate: first }) as never;

describe('showing a plan', () => {
  it('groups stops by the month they start in, in date order', () => {
    const plan = { stops: [stop('c', '2027-01-09'), stop('a', '2026-10-25'), stop('b', '2026-10-31')] } as never;
    expect(stopsByMonth(plan).map((g) => [g.month, g.stops.map((s) => s.showId)])).toEqual([
      ['October 2026', ['a', 'b']],
      ['January 2027', ['c']],
    ]);
    expect(monthTitle('2026-12-05')).toBe('December 2026');
  });

  it('writes a leg in miles or kilometres with the drive time', () => {
    const leg = { from: { name: 'Home' }, to: { name: 'Edison, NJ' }, miles: 140, km: 225.3, hours: 2.33 } as never;
    expect(legText(leg, 'mi')).toBe('140 mi, about 2 h 20 min');
    expect(legText(leg, 'km')).toBe('225 km, about 2 h 20 min');
    expect(legTitle(leg)).toBe('Home to Edison, NJ');
  });

  it('puts deadlines in date order with undated ones last', () => {
    const plan = {
      deadlines: [
        { showId: 'z', name: 'Z', date: null },
        { showId: 'b', name: 'B', date: '2026-11-10' },
        { showId: 'a', name: 'A', date: '2026-11-03' },
        { showId: 'y', name: 'Y', date: null },
      ],
    } as never;
    expect(deadlinesInOrder(plan).map((d) => d.showId)).toEqual(['a', 'b', 'y', 'z']);
  });

  it('orders cost lines the same way every time', () => {
    const lines = [{ kind: 'food' }, { kind: 'table' }, { kind: 'hotel' }, { kind: 'fuel' }, { kind: 'extras' }] as never[];
    expect(orderedCosts(lines).map((l) => l.kind)).toEqual(['table', 'extras', 'fuel', 'hotel', 'food']);
  });

  it('draws a plan with trips trip by trip, and one without as a single route', () => {
    const a = stop('a', '2026-10-25');
    const b = stop('b', '2026-11-01');
    expect(tripStops({ title: 'Best plan', trips: [], stops: [a, b] } as never)).toHaveLength(1);
    const trips = tripStops({ title: 'Season', trips: [{ label: 'Trip 1', showIds: ['a'] }, { label: 'Trip 2', showIds: ['b'] }], stops: [a, b] } as never);
    expect(trips.map((t) => t.stops.map((s) => s.showId))).toEqual([['a'], ['b']]);
  });

  it('formats money the way the planner does', () => {
    expect(money(1234.5, 'USD')).toBe('1,235 USD');
    expect(money(3.4, 'CAD')).toBe('3.40 CAD');
  });
});
