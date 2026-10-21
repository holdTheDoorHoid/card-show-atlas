import showsJson from '../fixtures/SampleShows.json' with { type: 'json' };
import vendorJson from '../fixtures/SampleVendorSettings.json' with { type: 'json' };
import noSalesJson from '../fixtures/SampleVendorNoSales.json' with { type: 'json' };
import canadaJson from '../fixtures/SampleVendorCanada.json' with { type: 'json' };
import weekendJson from '../fixtures/SampleWeekendRequest.json' with { type: 'json' };
import shoppingJson from '../fixtures/SampleShoppingRequest.json' with { type: 'json' };
import seasonJson from '../fixtures/SampleSeasonRequest.json' with { type: 'json' };
import type { PlannerShow, VendorSettings } from '../src/index.js';
import type { SeasonOptions, WeekendRunOptions } from '../src/index.js';

const clone = <T>(x: unknown): T => JSON.parse(JSON.stringify(x)) as T;

export const sampleShows = (): PlannerShow[] => clone(showsJson);
export const sampleVendor = (): VendorSettings => clone(vendorJson);
export const sampleVendorNoSales = (): VendorSettings => clone(noSalesJson);
export const sampleVendorCanada = (): VendorSettings => clone(canadaJson);
export const sampleWeekend = (): WeekendRunOptions => clone(weekendJson);
export const sampleShopping = (): WeekendRunOptions => clone(shoppingJson);
export const sampleSeason = (): SeasonOptions => clone(seasonJson);
