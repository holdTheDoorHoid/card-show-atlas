# Card Show Atlas site

The website: Astro 7 with Preact islands and Leaflet, built as static files for GitHub Pages at
https://holdthedoorhoid.github.io/card-show-atlas/. The design is in [../docs/DESIGN.md](../docs/DESIGN.md) and the
data contract in [../docs/DATA_MODEL.md](../docs/DATA_MODEL.md).

## Run it

Node 24 and npm 11.

```
cd site
npm ci
npm run dev        # dev server, with made up SAMPLE data when there is no real data
npm test           # unit tests (vitest)
npx astro check    # type check
npm run build      # production build into dist/ (never uses sample data)
npm run preview    # serve dist/ (needs a build first)
```

The site is served under the base path `/card-show-atlas/`, so the dev server is at
`http://localhost:4321/card-show-atlas/`.

## Where the data comes from

The pipeline (`csa build`) writes full records into `site/public/data/` (DATA_MODEL section 6). That folder is
generated and never committed. A step that runs before every `dev` and `build`, `scripts/prepare-data.mjs`, turns
`shows.json` into the compact index the browser loads.

| File in `public/data/` | Written by | Used for |
| --- | --- | --- |
| `shows.json` | pipeline | one static page per show, browse pages, and the index |
| `store_events.json` | pipeline | the store events layer (becomes `store_index.json`) |
| `series.json`, `promoters.json` | pipeline | extra facts on series and promoter pages (cadence, history, contact) |
| `vocab.json` | pipeline | display names for what is sold (a built in list is the fallback) |
| `manifest.json` | pipeline | sources and credit text for the About page and show pages, `built`, `fixture` |
| `postal/US.json`, `postal/CA.json` | pipeline | postal code lookup, loaded on demand |
| `index.json` | prepare step | compact rows for the list and the map |
| `store_index.json` | prepare step | compact store event rows, fetched only when the layer is switched on |
| `planner.json` | prepare step | the route planner's rows (hours, time zone, table prices, estimates), fetched only by the Plan page and by "Best for my table" |

### Formats the site reads

The site is forgiving about missing optional parts and strict about what it cannot work without. A record in
`shows.json` is used only if it has an `id`, a `name`, a known `event_type`, at least one valid day, and a venue with a
`city` and a `region`. Records that fail are skipped and counted in the build log; if none of them can be read the
build stops. Lists may be a bare array or an object holding the array (`{"shows": [...]}`).

* `shows.json`: full show records exactly as in DATA_MODEL section 2. `venue.lat` and `venue.lon` may be null (the
  show then has a page but is not on the map or in distance searches). `store_event` records are moved out of the main
  index.
* `store_events.json`: full records, same shape as shows.
* `series.json`: records as in DATA_MODEL section 5. Optional: series pages are also derived from `series_id`.
* `promoters.json`: records as in DATA_MODEL section 5. Optional: promoter pages are also derived from
  `organizer.promoter_id` (or the organizer name).
* `vocab.json`: `{"tcg": [{"id": "pokemon", "name": "Pokémon", "label": "Pokémon"}, ...], "sports": [...], "other": [...]}`.
  A map of ids to names, or the same thing under a `groups` key, also works. Unknown ids are kept.
* `manifest.json`: `{"built": "2026-10-21T04:00:00Z", "fixture": false, "counts": {...}, "sources": [{"id": "example_calendar", "name": "...", "url": "...", "kind": "aggregator", "credit": "Listed by ..."}]}`.
  A show's `sources[].source` is looked up in `sources` for its credit text.

### Postal code files

Small JSON objects from a code to `[latitude, longitude]`:

```
postal/US.json   {"08837": [40.52, -74.35], "90210": [34.1, -118.41], ...}   five digit ZIP codes (leading zeros kept)
postal/CA.json   {"M5V": [43.64, -79.4], "V6B": [49.28, -123.12], ...}       first three characters, upper case
```

A visitor can type `08837`, `08837-1234`, `M5V 2T6`, `m5v2t6` or `M5V`. The site works out the country from the shape and
fetches only that country's file, once, when the first code is typed. Source: GeoNames (CC BY 4.0).

### The compact index (`index.json`)

`{"v": 1, "generated", "fixture", "count", "vocab", "rows": [...]}`. Rows are sorted by first day and use short keys:

| Key | Meaning |
| --- | --- |
| `i`, `n`, `t` | id, name, event type |
| `d`, `e`, `ds` | first day; last day when different; every day only when the days are not an unbroken run |
| `c`, `r`, `k` | city, state or province, country |
| `ll`, `g` | `[lat, lon]` to 4 decimals; geo precision when not `address` |
| `st` | status when not `scheduled` |
| `sz`, `at` | size class and expected attendance (typical value) |
| `sl`, `mx` | everything sold as vocabulary ids; mix when not `unknown` |
| `fr`, `ad`, `cu` | free entry flag; adult price; currency when not USD |
| `vs`, `vp`, `vd` | vendor status (present when any vendor info is known); lowest table price; application deadline |
| `vf` | verification: `o` organizer confirmed, `l` listed, `c` community, `u` unverified |
| `u` | official link, store event rows only |

About 35 bytes per show once compressed: 12,000 shows download as roughly 420 KB.

### The planner file (`planner.json`)

`{"v": 1, "generated", "fixture", "count", "vocab", "rows": [...]}`. Each row is a `PlannerShow` (see
`planner/src/types.ts`) built by `src/lib/planner-rows.ts` from the normalized show, with null values left out and put
back on load (`expandPlannerRow`). A test keeps this in step with the planner's own `toPlannerShow`. Shows with no
coordinates or time zone are left out (the prepare step says how many). About 50 bytes per show once compressed.

## The sample data safety rule

Sample data must never reach the public site: someone could drive to a show that does not exist.

* `fixtures/` holds a generator and its output: a few hundred made up shows, every name starting with "Sample", every
  link on example.com, every record carrying the source id `fixture`, and a manifest with `fixture: true`.
  `npm run fixtures` regenerates it (dates are relative to today; `npm run dev` does this by itself when the sample
  dates are more than two weeks old).
* Only `npm run dev` and the tests use it. In dev, while `public/data/shows.json` does not exist, a small dev server
  plugin serves `fixtures/data` under `/data/`. Nothing is copied into `public/`.
* The dev site shows a red "SAMPLE DATA" banner on every page and is marked `noindex`.
* `npm run build` never uses fixtures. With no `public/data/shows.json` it builds the empty state ("Shows are being
  added, check back soon"). If `public/data` holds anything that looks like sample data (manifest `fixture: true`, the
  `fixture` source, or a "Sample" show at a "Sample" venue, in `shows.json` or `store_events.json`) the build fails
  before it starts. After the build, `scripts/check-dist.mjs` scans `dist/` for the banner, fixture flags and sample
  show pages and fails the build if it finds any.
* These guards have their own tests (`src/lib/guard.test.ts`, `src/lib/build-guard.test.ts`).

## Settings you may want to change

All in `src/lib/config.ts`:

* `GOOGLE_FORM_URL`: the no account submission form. It is empty for now, and every button that uses it is hidden while
  it is empty.
* `TILE_URL` and `TILE_ATTRIBUTION`: one place to swap the map tile source. The default is the public OpenStreetMap tile
  server, which has a usage policy for light use; a busy site should move to a provider with an agreement.
* `SITE_ORIGIN`, `BASE_PATH`, `GITHUB_REPO`. `BASE_PATH` must match `base` in `astro.config.mjs`.

## What is on the site

| URL | Page |
| --- | --- |
| `/` | Find: place, distance, dates, filters, list or map |
| `/map/` | Map with the time window bar |
| `/shows/<id>/` | One static page per show |
| `/states/`, `/states/<code>/` | Browse by state or province (Canada is `ca-on` and so on, to avoid clashing with US codes) |
| `/series/`, `/series/<id>/` | Regular shows |
| `/promoters/`, `/promoters/<id>/` | Organizers |
| `/my-shows/` | The vendor tracker, backup and restore, vendor settings |
| `/plan/` | Placeholder for the route planner; accepts `?show=<id>` |
| `/about/`, `/add/` | About, sources and credits; add, fix and removal requests |

Everything a visitor saves stays in `localStorage` in their browser: `csa.location.v1`, `csa.filters.v1`, `csa.find.v1`,
`csa.myshows.v1`, `csa.settings.v1`, `csa.lastbackup.v1`, `csa.theme.v1`.

## The route planner

The engine lives in `../planner` (a package with no dependencies, with its own README and tests). The site uses its
source directly: Vite compiles it, the dev server is allowed to read the parent folder (`server.fs.allow` in
`astro.config.mjs`), and the worker is built as an ES module (`worker.format`).

* `src/islands/plannerSession.ts` owns the Web Worker (`planner/src/worker.ts`): it fetches `planner.json`, starts the
  worker, sends the rows once (`setShows`), and `cancel()` ends the worker so a fresh one starts with the next call.
* `src/islands/PlanApp.tsx` is the Plan page: two tabs (Weekend run, Season planner), the forms in `PlanForms.tsx`, and a
  `PlanCard.tsx` for each plan (map, day by day, drives, money, deadlines, exports). `?show=<id>` makes that show a "must
  include" chip. `#plan=<link>` opens a shared plan.
* The glue is plain functions in `src/lib/`, tested against the real planner code: `planner-settings.ts` (My shows settings
  to planner settings, what is missing, placeholders, the vendor's history from My shows), `plan-options.ts` (forms to
  planner options), `plan-run.ts` (running a plan, the must include rule, exchange rates), `plan-share.ts`, `plan-ics.ts`,
  `vendor-rank.ts` (the Find page score) and `planner-rows.ts`.
* When a setting needed for profit is empty, the Plan page lists it with a link to its field on My shows and plans by
  priority score instead (`objective: 'score'`). The planner's engine always wants a fuel economy and price, a hotel price
  and food money, so placeholders are used for those (and listed on the plan, with a "placeholder" badge on the cost
  lines and in the "Change a number" box) rather than refusing to plan: 20 mpg or 10 L/100 km, 3.50 a gallon or 1.80 a
  litre, a hotel at 140 USD or 180 CAD a night, food at 35 USD or 45 CAD a day.
* "How much do you mind driving?" (A little, Some, A lot; default Some) is on both forms and becomes the planner's
  `mindDriving`. It decides how much each hour of driving and each hotel night counts against a plan ranked by score and
  every shopping plan (planner README section 5.7). With sales filled in, plans count money; the optional "What an hour of
  your driving is worth" setting on My shows (`timeValuePerHour`) then adds the time as a cost.
* The planner has no "force this show in" switch. A must include show is handled in `plan-run.ts`: plans that contain it
  come first; if none does, a plan with only that show (planned by score with no driving penalty, so a losing or far show
  is still planned and says so) comes first.
* Numbers typed into a plan (table fee, hotel, food, fuel price) are for that plan only. Table fees change the rows sent to the
  worker; the others change the settings passed with each call.
* A share link goes in the part of the address after `#`, which browsers never send to a server. It carries the show ids
  and the planning knobs, never sales, margin or costs, and the start point only when "Include my start point" is ticked.
* "Check real drive times" is the only network request the planner makes, and only when tapped (one request to the public
  OSRM demo server, from the worker). The result is kept as `knownLegs` for later plans.
* "Best for my table" on Find appears when a home is saved in the vendor settings. It scores shows with the planner's
  vendor priority score (expected profit when the settings allow it, otherwise the weighted points) and shows the score
  out of 100 with its top reasons. The four weight presets only change the score when it is made from points, so a vendor
  with full settings chooses between "Expected profit" and "My priorities".
* The vendor settings type is `VendorSettings` in `src/lib/settings.ts`, saved under `csa.settings.v1`, with
  `fuelCostPerMile()` and `missingForProfit()` helpers.
* My shows is in `src/lib/myshows.ts` (saved under `csa.myshows.v1`). Each tracked show keeps its table price, dates
  and the vendor's own results, which the planner can use as history.
* Distance and drive time estimates for lists (`src/lib/geo.ts`) come straight from the planner's travel model, so a list
  and a plan agree.

## Decisions worth knowing

* Cancelled shows are left out of lists and the map. Their page stays and says "cancelled".
* A show that does not say what it sells is treated as unknown, not as selling nothing, so it still appears when a game is
  chosen. A checkbox hides them.
* The distance slider runs from 10 to 500 miles, or 10 to 800 km, so the largest search is the same either way. Miles or
  km follows the country of the chosen place, and can be switched by hand.
* Store events are a separate layer, off by default, fetched only when switched on, and never counted as shows near you.
* Clustering is a grid pass over the places at the current zoom (`src/lib/cluster.ts`), not a prebuilt index. An index
  such as supercluster takes 100 to 800 ms to rebuild for thousands of markers, too slow when the time window changes
  the markers on every drag step. The grid takes a few milliseconds for 10,000 places.
* Shows only get a page if they are in `shows.json` (30 days back to 24 months ahead), so editions older than that are
  not linked from series pages.
