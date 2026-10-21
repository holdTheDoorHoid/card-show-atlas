import type { Plan } from '../../../planner/src/vending.ts';
import { stopsByMonth } from './plan-view.ts';

export function groupByMonthHelper(plan: Plan) {
  return stopsByMonth(plan);
}
