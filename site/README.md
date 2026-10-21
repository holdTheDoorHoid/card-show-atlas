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

## For the route planner

* The vendor settings type is `VendorSettings` in `src/lib/settings.ts`, saved under `csa.settings.v1`, with
  `fuelCostPerMile()` and `missingForProfit()` helpers.
* My shows is in `src/lib/myshows.ts` (saved under `csa.myshows.v1`). Each tracked show keeps its table price, dates
  and the vendor's own results, which the planner can use as history.
* Distance and drive time estimates (`src/lib/geo.ts`) use a road factor of 1.25 and an average speed that is lower on
  short legs, as in DESIGN section 6.1. Keep the planner's constants in step with them.
* `src/islands/PlanApp.tsx` is the placeholder to replace. It already reads `?show=<id>`.

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
