# Card Show Atlas planner

The route planning engine for Card Show Atlas: show rankings, profit estimates, the weekend run and
the season planner (DESIGN sections 4 to 7). It is a standalone TypeScript package with **no runtime
dependencies**. The same code runs in a browser Web Worker and in Node, and nothing leaves the device
except one optional request when the user taps "check real drive times".

```
npm install          # dev tools only: typescript 6.0.3 and vitest 4.1.11
npm run build        # compiles src/ to dist/ (ES modules plus .d.ts)
npm test             # type check, unit and property tests, then the benchmark on its own
npm run bench        # only the season planner benchmark
```

## Contents

1. Quick start
2. Inputs
3. API
4. What a plan looks like
5. Algorithms and guarantees
6. Money and currencies
7. Privacy
8. Wiring it into the site
9. Fixtures and tests

## 1. Quick start

### In the site, through the worker

```ts
import { createPlannerClient } from '../../planner/src/index.ts';

const worker = new Worker(new URL('../../planner/src/worker.ts', import.meta.url), { type: 'module' });
const planner = createPlannerClient(worker);

await planner.call('setShows', { shows });          // once, after the data loads
const run = await planner.call('weekendRun', {
  settings,                                         // VendorSettings from the browser
  options: { mode: 'vending', dates: { start: '2026-11-14', end: '2026-11-15' }, today: '2026-10-21' },
});
run.best?.summary;      // "2 shows, no hotel nights, 458 miles, 8 h 40 min of driving"
run.best?.money.label;  // "Expected profit about 1,100 USD (650 to 1,637)"
```

Every call returns a promise. Errors come back as `PlannerCallError` with a `code` and a plain
`message` ("The end date is before the start date."). To cancel a long plan, call
`planner.terminate()` and create a new worker.

### Directly (Node, tests, or the main thread)

```ts
import { planSeason, rankForVendor, estimateProfit } from './src/index.js';

const season = planSeason(shows, settings, {
  range: { start: '2026-11-01', end: '2027-04-30' },
  weekendsOnly: true,
  maxShowsPerMonth: 3,
  maxNightsAway: 3,
  blackout: ['2026-11-26', '2026-12-25'],
  today: '2026-10-21',
});
season.deadlines.map((d) => d.label); // ["Join the waitlist by Nov 1", "Apply by Nov 6", "Apply by Nov 10", ...]
```

## 2. Inputs

### `PlannerShow`

A compact row made from a DATA_MODEL show edition. `toPlannerShow(record)` builds it from the full
record in `shows.json`.

```ts
interface PlannerShow {
  id: string;
  series_id?: string | null;          // links the vendor's own history
  name: string;
  event_type: 'card_show' | 'convention' | 'tournament' | 'pop_culture_con' | 'store_event';
  status?: 'scheduled' | 'tentative' | 'postponed' | 'cancelled' | null;
  days: { date: string; open: string | null; close: string | null }[];   // local, 24 hour
  timezone: string;                   // IANA, for example "America/New_York"
  lat: number;
  lon: number;
  city?: string | null;
  region?: string | null;
  country?: string | null;            // "US" or "CA"
  sells: string[];                    // flat list of vocabulary ids; empty means unknown
  estimate: {
    attendance: { low: number; mid: number; high: number } | null;
    size_class: 'small' | 'medium' | 'large' | 'major' | null;
    traffic_per_table: number | null;
    confidence: 'reported' | 'estimated' | 'rough' | null;
  } | null;
  size: { tables: number | null } | null;
  vendor: {
    min_table_price: number | null;   // cheapest table, in `currency`
    currency: string | null;          // "USD" or "CAD"
    deadline: string | null;          // "YYYY-MM-DD"
    status: 'open' | 'waitlist' | 'sold_out' | 'closed' | 'unknown' | null;
    setup?: string | null;            // local time vendors may set up on day one
    extras?: number | null;           // known extra fees per table, same currency
  } | null;
  admission: { free: boolean | null; adult: number | null; currency: string | null } | null;
}
```

### `VendorSettings`

The names match what the site stores in the browser (DESIGN 3.5).

```ts
interface VendorSettings {
  home: { lat: number; lon: number; name?: string; timezone?: string } | null;
  currency?: string;                 // hotel, food, sales and history are in this; default "USD"
  mpg?: number | null;               // US gallons; or
  l_per_100km?: number | null;
  fuel_price: { amount: number; unit: 'gallon' | 'litre'; currency?: string } | null;
  hotel_per_night: number;
  food_per_day: number;
  max_drive_hours_per_day: number;
  typical_sales: { small: number; medium: number; large: number; major: number } | null;
  margin_percent: number;            // 0 to 100
  sells: string[];                   // vocabulary ids
  extras_per_show?: number;          // own extra cost per show (badge, parking)
  time_value_per_hour?: number | null; // optional: what an hour of driving is worth to you; default 0
  history?: Record<string, { gross_sales: number[]; rating?: number | null }>;  // by series_id
}
```

When hotel or food is not filled in, the site passes placeholders (140 USD or 180 CAD a night,
35 USD or 45 CAD a day) and lists them on the plan, so a hotel never looks free.

### Options every planner accepts (`CommonPlanOptions`)

| Option | Meaning |
| --- | --- |
| `today` | `YYYY-MM-DD`. Pass the user's local date. Defaults to the runtime's date. |
| `rates` | Exchange rates the user typed in, for example `{ CAD_USD: 0.73 }`. The other direction is derived. |
| `objective` | `auto` (default): profit when typical sales are set, else priority score. Or `profit`, `score`. |
| `weights` | `biggest_crowds`, `cheapest`, `closest`, `balanced` (default), or custom numbers. |
| `rules` | Timing rules, see below. |
| `travel` | Travel model overrides, see section 5.1. |
| `knownLegs` | Real drive times from a plan check, used before the estimate. |
| `profitModel` | Profit model overrides, see section 5.4. |
| `keepPastDeadline` | Keep shows whose deadline passed, marked "waitlist only". Default false. |
| `includeStoreEvents` | Store events are left out unless this is true (DESIGN 8). |
| `skipIds`, `onlyIds` | Leave shows out, or plan only these. |
| `labels` | Display names for vocabulary ids (from `vocab.json`). Defaults are built in. |
| `minScore` | Score mode only: points a show must beat to be worth a spot. Default 0. |
| `mindDriving` | "How much do you mind driving?": `little`, `some` (default) or `lot`. Sets the points an hour of driving and a hotel night cost a plan made by score, and every shopping plan (section 5.7). |
| `penalties` | Your own `{ perDriveHour, perHotelNight }` in points, instead of a `mindDriving` preset. |

Timing rules (`PlanningRules`), all local to the show:

| Rule | Default | Meaning |
| --- | --- | --- |
| `setupLeadMinutes` | 90 | Be at the table this long before opening on day one, unless the show lists a setup time. |
| `laterDayLeadMinutes` | 30 | Same, for later days of a multi day show. |
| `teardownMinutes` | 60 | Teardown after closing on the last day. |
| `earliestDrive` | 05:00 | No driving before this. |
| `latestDrive` | 23:00 | No driving after this. |
| `defaultOpen`, `defaultClose` | 09:00, 17:00 | Assumed when a show lists no hours (the plan says so). |
| `shoppingDayStart` | 08:00 | Shopping: earliest departure each morning. |

## 3. API

| Function | What it does |
| --- | --- |
| `rankForShowGoer(shows, query)` | Best match for show goers, highest first, with reasons. |
| `scoreForShowGoer(show, query)` | The same for one show. |
| `rankForVendor(shows, settings, options)` | Vendor priority score 0 to 100 with reasons; excluded shows last with the reason. |
| `scoreForVendor(show, settings, options)` | The same for one show. |
| `estimateProfit(show, settings, options)` | Itemized profit estimate for doing one show alone from home. |
| `planWeekendRun(shows, settings, options)` | Best weekend run plus up to three alternatives, vending or shopping. |
| `planSeason(shows, settings, options)` | Best set of shows over a date range, with deadlines and totals. |
| `checkRealDriveTimes(plan, request, provider)` | One routing request, then the same shows planned again with real drive times. |
| `OsrmRouteProvider`, `EstimateRouteProvider` | Route providers behind the `RouteProvider` interface. |
| `googleMapsUrls(plan, options)` | Google Maps driving directions, one link per trip, split at 9 waypoints. |
| `encodeShareLink(payload, options)`, `decodeShareLink(link)` | Compact URL safe share links with validation. |
| `toPlannerShow(record)` | DATA_MODEL show record to `PlannerShow`. |
| `verifyPlan(plan, shows, options)` | Independent feasibility and money check; an empty list means the plan is sound. |
| `zonedTimeToInstant(date, time, zone)` | Local date and time in an IANA zone to an absolute instant. |
| `handlePlannerRequest`, `createPlannerClient` | The worker protocol, see section 3.9. |

### 3.1 Show goers

```ts
rankForShowGoer(shows, { origin: { lat, lon }, interests: ['pokemon', 'mtg'], today: '2026-11-01' });
// [{ showId: 'delaware-valley-tcg-fest-cherry-hill-nj-2026-11-15', score: 72,
//    reasons: ['20 min drive', 'Has Pokémon and Magic', 'Medium sized show (about 900 people)', 'In 2 weeks', 'Entry 5 USD'],
//    miles, km, hours, factors }, ...]
```

Weights: distance 0.35, size 0.25, what you collect 0.25, how soon 0.10, free entry 0.05. Distance
uses a gentle decay that halves every 1.5 hours of driving (`halfLifeHours`), so there is no cliff.
Shows that are over or cancelled are left out.

### 3.2 Vendors

```ts
rankForVendor(shows, settings, { today, weights: 'cheapest' });
// [{ showId: 'jersey-shore-collectibles-toms-river-nj-2026-11-15', score: 68, mode: 'points',
//    reasons: ['Table is 45 USD, cheaper than most', 'Small crowd expected (about 250)', '1 h 20 min drive from home', ...],
//    waitlist: false, excluded: false, factors, hours, miles, profit: null }, ...,
//  { showId, score: null, excluded: true, excludedReason: 'Sold out', ... }]
```

Factors, each from 0 to 1: crowd (attendance on a log scale), traffic per table, table cost (rank
among the shows being compared), travel from home or from `from` (the previous show in a route),
match with what the vendor sells, and own history (rating and past sales). Presets:

| Preset | crowd | traffic | cost | travel | match | history |
| --- | --- | --- | --- | --- | --- | --- |
| `balanced` | 0.25 | 0.15 | 0.15 | 0.20 | 0.15 | 0.10 |
| `biggest_crowds` | 0.45 | 0.20 | 0.05 | 0.10 | 0.10 | 0.10 |
| `cheapest` | 0.10 | 0.10 | 0.45 | 0.15 | 0.10 | 0.10 |
| `closest` | 0.10 | 0.05 | 0.10 | 0.50 | 0.15 | 0.10 |

Custom weights are any numbers zero or more; they are scaled to add up to one. When typical sales are
filled in, the score switches to expected profit (`mode: 'profit'`): the profit of doing the show
alone, mapped to 0 to 100 so that breaking even scores 50 and a typical medium show's profit scores
about 73. `scoreBy: 'points'` keeps the weighted points instead. Closed and sold out shows drop out,
waitlists are marked "Waitlist only", a passed deadline drops the show unless the organizer keeps a
waitlist or `keepPastDeadline` is set.

### 3.3 Profit estimate

```ts
const e = estimateProfit(show, settings, { today });
e.costs;   // [{ kind: 'table', label: 'Table fee', amount: 95, currency: 'USD', detail: 'Cheapest listed table, 95 USD' },
           //  { kind: 'extras', label: 'Your extras', amount: 10, ... },
           //  { kind: 'fuel', label: 'Fuel', amount: 2.79, detail: '18 miles at 22 mpg, 3.40 USD a gallon' },
           //  { kind: 'food', label: 'Food', amount: 45, detail: '1 day at 45 USD' }]
e.sales;   // { low, mid, high, sizeClass, trafficFactor, matchFactor, historyAverage, explain: [...] }
e.profit;  // { low, mid, high } or null
e.label;   // "Expected profit about 506 USD (343 to 699)"
```

The trip behind the estimate is the cheapest one that fits the driving limit (drive the morning of,
or arrive the night before; come home that evening or the next day; for a multi day show, a hotel or
driving home each night).

### 3.4 Weekend run

```ts
planWeekendRun(shows, settings, {
  mode: 'vending',                  // or 'shopping'
  dates: { start: '2026-11-13', end: '2026-11-15' },
  start: settings.home,             // default home
  end: undefined,                   // default the start point
  overnight: 'stay',                // or 'home': back home every night
  maxShows: 3,
  alternatives: 3,
  mindDriving: 'some',               // score mode and shopping: how much driving and hotels count
  // shopping only:
  dwellMinutes: 90, interests: ['pokemon'], values: { 'some-show-id': 80 }, people: 1, exactLimit: 10, seed: 1,
  farHours: 3, farFactor: 1.5,       // the far stop rule, section 5.6
});
// { mode, best: Plan | null, alternatives: Plan[], excluded: [{ id, name, reason }], warnings, candidates, exact, ms }
```

Alternatives are re planned under one change each and kept only when they differ from the best plan
and from each other: "One fewer show", "Home by Saturday night", "No hotel nights", "Without
(show)". Each has a `note` such as "About 90 USD less profit, 1 show fewer, 4 h 25 min less
driving".

The best plan is always on top: if an alternative turns out at least as good as the best plan on
every measure plans are ranked by (its value, its hours of driving and its total cost), it becomes
the best plan and the plan it beat is dropped. Alternatives that tie on all three are dropped too.

In `stay` mode hotels are allowed and home is used whenever it is better and fits (also when
shopping: each night is at home or near the day's last stop, whichever is better). In `home` mode
every night is at home; a show too far for that is left out. A run can cover up to 14 days.

### 3.5 Season planner

```ts
planSeason(shows, settings, {
  range: { start, end },            // up to about 13 months
  blackout: ['2026-12-25'],         // days you cannot be away at all
  weekendsOnly: true, fridayIsWeekend: false,
  maxShowsPerMonth: 3,              // a show counts in the month it starts
  maxNightsAway: 3,                 // longest stretch away from home, in nights in a row
  chain: true,                      // false: go home between shows
  maxChainGapDays: 7,
  maxDriveHoursFromHome: 6,         // optional pre filter
});
// { plan, deadlines, totals: { currency, shows, trips, hotelNights, miles, driveHours, money }, excluded, warnings, stats }
```

`plan.trips` lists each trip from home and back. `deadlines` lists every application deadline in the
plan in date order, with shows without a deadline at the end ("No deadline listed, check with the
organizer").

### 3.6 Real drive times

```ts
const provider = new OsrmRouteProvider({ fetch });
const check = await checkRealDriveTimes(plan, { kind: 'weekend', shows, settings, options }, provider);
// { ok, source: 'osrm' | 'estimate', label, plan, matrix, changes: ['Drive to Edison, NJ is 1 h 40 min, 15 min more than estimated.'], problems: [] }
```

The adapter respects the public OSRM demo server's light use policy: one plan check is exactly one
`table` request covering every point, it never retries or loops, it refuses a second request while
one is in flight or within a second of the last, it caches answers, it gives up after 10 seconds,
and it refuses plans with more than 60 points instead of splitting them. `fetch` is injected, so
tests never touch the network. `route(points)` (one request for a route through the points) is
there too. If the service fails, the result says "Real drive times are not available right now, so
the estimates stand." and keeps the original plan. Pass `check.matrix` as `knownLegs` to later plans
to keep using the real times.

### 3.7 Google Maps

`googleMapsUrls(plan, { includeStart })` returns `{ url, label }[]`, one per trip (season plans and
runs that go home in between), split into links of at most 9 waypoints that join end to start. By
default the start point is left out, so Google routes from wherever the phone is and the link does
not carry a home address. `includeStart: true` adds the start and end point.

### 3.8 Share links

```ts
const link = encodeShareLink({ mode: 'season', showIds, settings: { start, end, maxShowsPerMonth: 3, weights: 'cheapest' } });
// "eyJtIjoicCIsImUiOlswLDAsMSwxLDIsNywz...LCJtIjozLCJnIjoxfX0.11ynoqy" (about 400 characters for 7 shows)
decodeShareLink(link);  // { ok: true, value: { mode, showIds, settings } } or { ok: false, error: 'The link was cut off or changed. Ask for it again.' }
```

Show ids that end in a date are stored as a series plus a day offset, so a season of monthly shows
stays short. The JSON is base64url encoded with a checksum. Only planning knobs are shareable
(`ShareSettings`): dates, overnight, driving limit, dwell time, weekends only, caps, chaining,
weights and blackout dates. Sales, margin and history are never included. The start point is left
out unless `includeStart` is set, and then rounded to about 100 m. Decoding never throws; it checks
the checksum, every field, every range and rejects unknown keys.

### 3.9 Worker protocol

The page posts `{ id, type, ...args }`; the worker answers `{ id, type, ok: true, result, ms, version }`
or `{ id, type, ok: false, error: { code, message } }`. Types (`PlannerCalls` has the exact shapes):

| `type` | Arguments | Result |
| --- | --- | --- |
| `ping` | none | `{ version }` |
| `setShows` | `shows` | `{ count }`; later calls may leave `shows` out |
| `rankForShowGoer` | `query`, `shows?` | `ShowGoerScore[]` |
| `rankForVendor` | `settings`, `options?`, `shows?` | `VendorScore[]` |
| `estimateProfit` | `show` (row or id), `settings`, `options?` | `ProfitEstimate` |
| `weekendRun` | `settings`, `options`, `shows?` | `WeekendRunResult` |
| `season` | `settings`, `options`, `shows?` | `SeasonResult` |
| `checkDriveTimes` | `plan`, `kind`, `settings`, `options`, `osrm?`, `shows?` | `DriveTimeCheck` |
| `mapsLinks` | `plan`, `options?` | `MapsLink[]` |
| `encodeShare` | `payload`, `includeStart?` | `string` |
| `decodeShare` | `link` | `DecodeResult` |

All results are plain data (no functions, no classes), safe for structured clone. The worker loads
time zone data when it starts, so the first plan does not pay for it.

## 4. What a plan looks like

```ts
interface Plan {
  kind: 'vending' | 'shopping';
  title: string;                  // "Best plan", "One fewer show"
  note?: string;                  // alternatives: how this differs from the best plan
  summary: string;                // "2 shows, 1 hotel night, 410 miles, 7 h 30 min of driving"
  stops: PlanStop[];              // shows in order, with arrive and leave times, sales, table fee, notes
  legs: PlanLeg[];                // from, to, miles, km, hours, source, and the drive split by day
  days: PlanDay[];                // each day: items such as "6:10 AM: drive 2 h 20 min to Edison, NJ (140 miles)",
                                  // "Vend at Garden State Card Show, 9:00 AM to 3:00 PM (be there by 7:00 AM)",
                                  // and `night` (the night is not repeated in the items)
  nights: PlanNight[];            // where = 'home' | 'hotel'; label "Hotel near Edison, NJ" or "Hotel on the road near Harrisburg, PA"
  trips: TripSummary[];           // each trip from home and back
  money: ProfitEstimate;          // the itemized money for the whole plan, see 3.3
  deadlines: Deadline[];          // { date, label: 'Apply by Nov 3', waitlist, passed }
  warnings: string[];             // "Hours not listed for X, assumed 9:00 AM to 5:00 PM."
  departDate: string | null;
  returnDate: string | null;
  hotelNights: number;
  driveHours: number;
  miles: number;
  value: number;                  // what the search maximized (profit, or score after penalties)
  objective: 'profit' | 'score' | 'visits';
  scoreLine: string | null;       // "Plan score 88: stops worth 121, minus 33 for 3 h 15 min of driving"
  driveTimes: { source: 'estimate' | 'osrm' | 'given'; label: string };
  start: PlanPoint;
  end: PlanPoint;
}
```

Every instant in a plan is given twice: as milliseconds (`arriveMs`, `departMs`) and as ISO 8601 with
the local offset (`"2026-11-01T07:30:00-05:00"`). Overnight towns on the road are named after the
nearest listed show town within 50 miles.

## 5. Algorithms and guarantees

### 5.1 Travel model

Straight line (great circle) distance times a road factor (1.25), driven at a speed that is lower on
short legs: the first 5 road miles at 25 mph, the next 15 at 40, the next 40 at 55, and the rest at
63 (all in `travel`: `roadFactor`, `bands`, `cruiseMph`, `overheadMinutes`). Because time is built up
mile by mile, a longer leg never takes less time than a shorter one, and the estimate obeys the
triangle inequality (tested on random points), so dropping a stop never makes a route longer.
`RouteProvider` is the interface for real drive times; `Travel` uses known legs first and estimates
the rest.

### 5.2 Time

Shows list local dates and times in an IANA zone. `zonedTimeToInstant` turns them into absolute
instants with the Intl API (no time zone data of our own). A time that happens twice when clocks
fall back resolves to the earlier one, and a time skipped when clocks spring forward moves forward by
the gap (the Temporal "compatible" rule). Tests cover the Central and Eastern boundary, Newfoundland's
half hour, Saskatchewan and Arizona, the November 1, 2026 fall back and the March 14, 2027 spring
forward, and 2,000 random round trips across 15 zones. Driving windows are read in the local time of
the show the drive belongs to (shopping: where you are when you leave).

### 5.3 Ranking

See 3.1 and 3.2. Price ranks use the shows being compared (`peers`), so "cheaper than most" means
cheaper than most of the list on screen, in the same currency or converted with the user's rate.

### 5.4 Profit (DESIGN 7)

```
expected gross sales = typical sales for the size class
                       x what is sold adjustment (from 0.5 when nothing matches up to 1; unknown counts as 1)
                       x traffic per table adjustment ((traffic / 6) ^ 0.5, kept between 0.6 and 1.5)
                       blended with your own average at this series, weight n / (n + 1) for n past shows
low and high         = expected sales x (attendance low or high / attendance mid) ^ 0.7
                       or 40 percent either way when there is no attendance range
contribution         = sales x margin
costs                = table fee (assumed by size when not listed, and flagged) + listed extras + your extras
                       + fuel (road miles / mpg x price, or L/100 km) + hotel nights x price + food x days away
profit               = contribution minus costs, as low, mid and high
```

Two choices go beyond the DESIGN formula and are easy to turn off in `profitModel`: the "what is
sold" adjustment (`matchFloor: 1` turns it off), and blending history rather than multiplying, so a
series' strong traffic is not counted twice. The range of a multi show plan adds the low ends and the
high ends, so it is wide on purpose. Every amount says how it was worked out (`detail`, `explain`).

### 5.5 Vending model (weekend run and season planner)

* A show is a block of days. You are at your table from setup on day one (listed setup time, or 90
  minutes before opening) to teardown on the last day (60 minutes after closing); later days from 30
  minutes before opening. One show per day.
* Driving happens only before setup and after teardown, inside 05:00 to 23:00 local, and the hours
  driven on one calendar day never exceed `max_drive_hours_per_day`. On a one day show the morning
  drive in and the evening drive out share that day's cap.
* Long legs split over several days with a hotel on the road. Each night is at home (or the start
  point) or in a hotel. A multi day show is done from a hotel or by driving home each night, whichever
  is cheaper and fits.
* Costs: fuel for every mile, a hotel for every night not at home, food for every day away from home
  (a travel day, a show day, or a day after a hotel night).
* A blackout date is a day you must be home: no show and no travel that day.

**Search.** Shows are nodes of a DAG sorted by first day. A label is a partial plan ending at a show and
carries its value, the morning hours already driven on the show's last day, the shows counted this
month, and the nights away in a row. Labels grow by three moves: leave home for a show (on the day,
or one or more days early), drive straight to the next show, or go home after a show (that evening
or later). "At home on night d" is a state per day, so going home between shows, sleeping at home and
leaving again are all exact. A label is dropped only when another label at the same show is at least
as good on every one of those counts (dominance), and a straight drive is skipped only when going
home in between is provably at least as good on every count. Months reset the show counter.

**Guarantee.** Within the model the result is optimal: no feasible plan has a higher value. This is
checked against brute force (every subset of shows in date order and every combination of the
model's per step options, with month counts and nights away counted directly) on 250 random weekend
instances and 150 random season instances with month caps, nights away limits, blackouts and both
chaining settings, and every returned plan passes `verifyPlan`, which recomputes opening hours,
drive times, daily caps, windows, nights and money from the raw inputs.

**The one approximation.** A straight drive from one show to another is considered only when they are
at most `maxChainGapDays` apart (7 by default in the season planner, the whole run for the weekend
run, and never more than `maxNightsAway`). Further apart, you go home in between. With any hotel cost
above zero, staying away a week to avoid driving home is rarely the better choice; set the option
higher to search more. Season travel may start up to `min(7, maxNightsAway)` days (at least 2) before
the range and end that long after it; the shows themselves are always inside the range.

**Objective.** With typical sales set: expected profit (the mid value), minus your time if you gave
it a value (`time_value_per_hour`, default 0; it shows up as a "Your time driving" cost). Without
sales: the shows' priority scores minus a penalty for every hour of driving and every hotel night
(section 5.7), so a plan does not chase stops it has to drive hours for. Money only breaks ties in
that mode. Waitlisted and tentative shows are planned and marked, not penalized.

**Speed.** Season benchmark (`npm run bench`, about 2,000 candidates over six months, five cases on
fresh data in one fresh process, so the first case also pays for JIT warm up): across several runs the first case took
0.4 to 0.5 s of CPU and 0.7 to 1.6 s of wall clock time while other work held the machine at a load
average of 29 to 43 on 8 cores; the other cases took 0.1 to 0.4 s of CPU. The five cases cover a
dense region with and without limits, a nationwide spread across four time zones, going home
between shows, and score mode. The test fails when the planner's own CPU time passes 2 seconds, and
also when wall time does unless the machine is overloaded (load average above the core count), in
which case wall time is only logged.

What makes it fast: shows are prepared once (instants, capacities, value); time zone offsets are
cached per day and per quarter hour; labels are checked for dominance before they are created;
straight drives are skipped, exactly, when a trip home in between is at least as good, often before
any trigonometry (a latitude only bound decides); and the hot loops avoid allocation.

### 5.6 Shopping (orienteering with time windows)

Several shows a day, a set time at each (default 90 minutes), inside opening hours, with the daily
driving cap and window. Each night is at home, or (in `stay` mode) in a hotel near the day's last
stop when that is better. The goal is the most worthwhile weekend: the value of the visits (from
size, what you collect and free entry, or your own `values`, 0 to 100 each) minus the driving and
night penalties of section 5.7, with less driving breaking ties.

Two sanity rules, so the planner does not drive 6 hours to shop for 90 minutes:

* **No drive longer than your daily limit.** Every drive between two stops fits inside one day's
  driving limit, and `verifyPlan` checks it.
* **The far stop rule.** A show more than 3 hours from your start point is only considered when it
  is worth at least one and a half times the best show within 3 hours (for example a major show
  against a small local one). If nothing is within 3 hours, far shows are all considered. Shows left
  out say so ("5 h 35 min away, and not at least one and a half times as good as the best show
  within 3 h"). One and a half rather than twice, because values stop at 100: with twice, a far
  show could only ever win against near shows scoring under 50. Change it with `farHours` and
  `farFactor`.

* **Exact** up to `exactLimit` candidates (10): label setting over (visited set, position, day) with
  dominance on time, hours driven today and penalty so far, and both night choices at the end of
  each day. Equal to brute force (every order, every split into days and every home or hotel choice
  each night) on 300 random instances with random penalties. Its worst case (every show open every day, close
  together, equal value) grows fast past 10, which is why the default stops there.
* **Heuristic** beyond that: three greedy insertion starts (value squared per added penalty, gain per
  added penalty, biggest gain first; a stop goes in only when it makes the plan better), then local
  search (2 opt within a day, relocate and swap stops anywhere, swap a visited stop for a better
  unvisited one, drop one or two stops and refill), inside an iterated local search that removes a
  few random stops and repairs, with a seeded random generator so the same input gives the same
  plan. The nights for each candidate route are chosen exactly (two places to be each night). It
  always returns a feasible plan. On 150 random instances with 5 to 10 candidates and random
  penalties (where the exact answer is known) it found the optimum on about 95 percent, with an
  average shortfall of about 0.3 percent; the test requires at least 88 percent and under 1 percent.
  It stops after a run of rounds without improvement or 400 ms (150 ms for each alternative).

### 5.7 How much driving counts ("How much do you mind driving?")

Plans made by score, and all shopping plans, take points off for driving and hotel nights. Show
scores and visit values run from 0 to 100.

| Setting | Per hour of driving | Per hotel night |
| --- | --- | --- |
| A little (`little`) | 2 points | 5 points |
| Some (`some`, default) | 10 points | 25 points |
| A lot (`lot`) | 20 points | 50 points |

With "Some", a 3 hour drive each way costs 60 points, so a far show has to be worth that much more
than staying close. Every plan made this way says how its score adds up (`scoreLine`, for example
"Plan score 88: stops worth 121, minus 33 for 3 h 15 min of driving"). Plans made by profit count
money instead; give your time a value (`time_value_per_hour`) to make driving cost something there
too.

On the case that prompted this (shopping from 19103, Philadelphia, October 23 to 25, 2026, no
vendor settings, Balanced), the old plan drove 973 miles in 17 hours with two hotel nights to visit
4 shows, as far as Buffalo. With "Some" it now visits 3 shows near Philadelphia in 123 miles and
3 h 15 min, with no hotel nights.

## 6. Money and currencies

Every amount carries a currency. Amounts in different currencies are never added together unless the
user entered a rate (`rates: { CAD_USD: 0.73 }`), and each conversion is listed in `money.conversions`
("Converted 175 CAD to 128 USD at 0.73, the rate you entered."). Without a rate an estimate keeps
`costsByCurrency` split, `profit` and `totalCost` are null, and a note asks for a rate; the planners
leave such shows out with the reason "Table price is in CAD. Add an exchange rate to include it." A
fuel price in another currency without a rate is an error with a plain message. Losses read "Expected
loss about 120 USD", never a minus sign.

## 7. Privacy

* Nothing is sent anywhere except the single routing request the user asks for, which carries the
  plan's coordinates and nothing else.
* Share links leave out the start point unless `includeStart` is set (DESIGN 6.5), and never carry
  sales, margin or history.
* Maps links leave out the start point by default.

## 8. Wiring it into the site

1. Import from `planner/src` (Vite and Astro compile TypeScript), or run `npm run build` and import
   `dist/`. In Astro dev mode, allow the folder: `vite: { server: { fs: { allow: ['..'] } } }`.
2. Build rows with `toPlannerShow(record)` from `shows.json`, or produce the same fields in the
   site's prepare step for `index.json`. Pass `{ needsElectricity: true }` when the vendor wants
   power, so the listed electricity fee counts as an extra.
3. Start the worker (section 1), send `setShows` once, then make calls. Always pass `today` as the
   user's local date.
4. Store vendor settings with the exact names in section 2, plus `currency`. Show an exchange rate
   box when a plan's excluded list mentions another currency, and pass it as `rates`.
5. Render `plan.days[].items` as the day by day view, `plan.nights`, `plan.legs` for the map,
   `plan.money.costs` as the editable breakdown with each line's `detail`, `plan.deadlines`, and the
   alternatives with their `note`. Show `driveTimes.label` next to every time.
6. "Check real drive times" sends `checkDriveTimes` with the plan and the same options. Call it only
   when the user taps the button.
7. Share: `encodeShare` with `includeStart` only when "include my start point" is ticked; on load,
   `decodeShare` and plan again with `onlyIds: value.showIds`.
8. Store events: pass `includeStoreEvents: true` only when the user asks for them.
9. Cancel a long plan with `client.terminate()` and start a new worker.

## 9. Fixtures and tests

`fixtures/` has sample inputs: `SampleShows.json` (18 shows around Philadelphia from November 2026
to January 2027, with a Canadian show, a sold out convention, a cancelled show, a tentative show
without vendor details and a store event), `SampleVendorSettings.json` (with sales and history),
`SampleVendorNoSales.json`, `SampleVendorCanada.json` (CAD, litres), and requests
`SampleWeekendRequest.json`, `SampleShoppingRequest.json` and `SampleSeasonRequest.json`.

Tests (`test/`): every module has unit tests; property tests run the planners on random instances and
check them against brute force and against `verifyPlan` (never two places at once, never over the
driving cap, never outside opening hours or driving windows, money matches the itinerary); the
writing test scans every string the planner returns, every error message, this README and the
source for dashes used as punctuation; the benchmark runs on its own after the rest.
