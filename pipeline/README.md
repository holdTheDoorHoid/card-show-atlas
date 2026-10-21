# Card Show Atlas pipeline

Python 3.12 package that turns many sources into the one list of shows the website reads.
The data format is [docs/DATA_MODEL.md](../docs/DATA_MODEL.md). This package follows it.

```
pip install -e "pipeline[dev]"      # from the repository root; use a venv at pipeline/.venv if you like
csa --help
cd pipeline && python -m pytest     # tests never touch the network
```

## How the data moves

```
scripted sources   csa harvest      ->  data/harvest/<source>.jsonl
research agents    csa import-research -> data/research/<wave>.jsonl
GitHub issues      csa import-issues -> data/submissions/pending/*.json
                                         (you move reviewed files to data/submissions/approved/)
data/corrections.yaml (hand fixes, applied last)
        |
        v   csa merge      ->  data/shows.jsonl  series.jsonl  promoters.jsonl  store_events.jsonl
        v   csa geocode        coordinates, precision, time zone   (cache: data/geocache.json)
        v   csa estimate       the crowd estimate on every show
        v   csa check          rules; errors stop the build
        v   csa build      ->  site/public/data/*.json
```

The daily run is `csa harvest all`, `csa import-issues`, `csa merge`, `csa geocode`, `csa estimate`,
`csa check`, `csa build`. `.github/workflows/refresh.yml` does exactly that. Its schedule is off until the
owner turns it on.

Useful options for every command: `--root DIR` (or the `CSA_ROOT` variable) to point at another checkout,
and `--today YYYY-MM-DD` (or `CSA_TODAY`) to pretend it is another day. Commands print plain sentences and
exit with 0 when all is well, 1 when `check` or `build` finds errors, 2 for a mistake in how you called them,
and 3 when a harvest source did not finish.

## The commands

### `csa harvest <source_id>|all`

Runs scripted sources (`method: script` in `data/sources.yaml`) and writes `data/harvest/<source>.jsonl`.
Each source is a module `pipeline/csa/sources/<id>.py` with `harvest(ctx) -> Iterable[dict]`.
`all` runs every source that is not marked `enabled: false`.

The HTTP client every source gets (`ctx.http`) does the polite things for you:

* sends `CardShowAtlas/0.1 (+https://github.com/holdTheDoorHoid/card-show-atlas)` on every request;
* reads robots.txt for each host before the first request and checks every path against it
  (wildcards and `Allow` rules included). Disallowed paths are refused, not fetched. A robots.txt that
  cannot be reached means no fetching from that host. A Crawl-delay is honored;
* waits at least one second between requests to the same host (`min_interval:` in the registry can raise it);
* keeps a copy of every response under `data/raw/<source>/` (not committed) and reuses it for 12 hours.
  `--refresh` fetches again;
* retries server errors and "slow down" replies up to three times with growing waits, and honors
  `Retry-After`, but gives up on a wait longer than a minute;
* **stops dead on a bot challenge.** A Cloudflare or similar challenge page raises `BotChallenge`. The
  client never retries, never tries another route, and the source is reported as `blocked`. The last good
  file stays in place. The result is also recorded in `data/harvest/_status.json`.

A run only replaces `data/harvest/<source>.jsonl` when it finished well. A crash, a block, or a run that
suddenly finds less than a fifth of what the last run found keeps the old file and exits with code 3.

The runner repairs what a source yields (dates, regions, vocabulary, money), keeps only the fields the
registry lists under `fields:`, drops any `summary` (we never copy prose), sets `verification` itself
(`organizer_confirmed` for `kind: promoter` sources, otherwise `listed`) and adds the `sources` credit
entry. A source cannot promote itself.

A source whose registry `url` is on the never use list (below) is not fetched.

### `csa import-research <wave>`

Reads `research/inbox/<wave>/*.json`, one file per agent (DATA_MODEL section 9). A file may also be a bare
list of records or one bare record. Each record is `"kind": "edition"` or `"kind": "series"`.

* Repairs small mistakes: date formats (`11/14/2026`, `Nov 14, 2026`), times (`9am`), region names to codes
  (`Pennsylvania` to `PA`), vocabulary synonyms (`Pokemon TCG` to `pokemon`, `MTG` to `mtg`; the map is in
  `data/vocab.json`), money written as text, `days (year 2026)` style labels in `supports`.
  Every repair is listed in the record's `repairs` field.
* Removes phone numbers from every free text field (only emails and pages the organizer published are
  kept), drops text fields longer than 300 characters (possible copied prose) and ignores any `estimate`.
* Rejects bad records into `research/inbox/<wave>/_rejected.jsonl` with the reasons: missing name, no real
  dates, dates in an unbelievable year, more than 14 days in one show, no usable venue city and state,
  unknown event type, a past show with no size information, a series rule that cannot be expanded, no
  usable evidence.
* **Evidence rules.** Domains in `data/never_use_domains.yaml` (sites whose terms forbid automated use)
  are dropped as evidence and their addresses are removed from every link field. If what remains does not
  support the name, the dates and the venue, the record is rejected with "evidence only from never use
  sources". Social and ticketing sites (`link_only_domains`: Facebook, Instagram, TikTok, X, Eventbrite,
  Meetup, AllEvents, Reddit) may stay in `links` but never count as evidence. Subdomains match too, and
  `eventbrite.*` covers any ending. To add a domain, add a line to that file.
* Marks `verification` itself: `organizer_confirmed` only when an evidence link is on the organizer's own
  site, otherwise `listed`.
* Writes good records to `data/research/<wave>.jsonl`, and leads and blocked pages to
  `data/research/leads/<wave>.jsonl`.

Running it again is safe. Records are filed under the agent that wrote them, so a rewritten agent file
replaces only that agent's records.

A **series** record (a show that repeats) is stored as it is and expanded by `csa merge` on every run, so the
window moves with the calendar:

* each date in `known_dates` becomes a `scheduled` edition (`cancelled` if it is also in `cancelled_dates`);
* `rule` makes `tentative` editions for the next 90 days only, never past `until`, skipping `skip_months`,
  `cancelled_dates` and dates already known. `nth` is 1 to 4, or -1 for the last weekday of the month;
* a series with no `last_confirmed`, or one older than 120 days, makes no tentative editions;
* a tentative edition says "Usually on this date. Check with the organizer before you go." in `summary`,
  is `unverified`, and disappears again if the rule stops making it. A real listing for the same date
  replaces the guess. Known dates stay as history after they pass.

### `csa import-issues`

Reads open issues labeled `add-show`, `fix-show`, `organizer` and `removal` from the public repository
(`gh api` when the GitHub command line tool is installed, otherwise the REST API; no token is needed, and
`GITHUB_TOKEN` or `GH_TOKEN` is used when present). It parses the issue form bodies by reading the forms in
`.github/ISSUE_TEMPLATE/`, so changing a form's field labels there changes what is read.

Each issue becomes `data/submissions/pending/issue-<number>.json`:

* `add-show` and `organizer`: `records` (one per run of dates) in the show format, `verification: community`,
  plus `review_notes` saying what could not be read (a repeating date such as "second Sunday" is not
  turned into dates; prices are listed for you to enter by hand);
* `fix-show`: `target` (the show id found in the page link), `change_request` and an empty `patch`;
* `removal`: `target`, `request`, `suppress: false` and an empty `patch`.

**Nothing goes live without review.** To approve a file, edit it if needed and move it to
`data/submissions/approved/`. To refuse one, move it to `data/submissions/rejected/` so it does not come back.
A file moved there is skipped on later runs unless the issue text changes, in which case it returns to
`pending/` with a warning.

* Approved `add-show` and `organizer` records join the merge as community records. Set
  `verification: organizer_confirmed` on a record after you have checked the organizer's own page.
* Approved `fix-show`: fill `patch` with dotted field names, for example `{"venue.city": "Edison"}`. It is
  applied after the merge, just before `data/corrections.yaml`.
* Approved `removal`: `suppress: true` removes the whole show for good (it stays out even if a source still
  lists it). Or list fields to clear in `patch`, for example `{"vendor.contact": null}`.

Privacy: the issue author's username is never read or stored, `@handles` in the text are replaced, and phone
numbers are removed.

### `csa merge`

Combines every contribution into `data/shows.jsonl`, `series.jsonl`, `promoters.jsonl` and
`store_events.jsonl` (DATA_MODEL sections 5 and 8).

* **Same edition.** Two records are one edition when they share a start date and country, the venues are
  within 1.5 km or the venue names match after normalizing, and the names are similar (generic words such as
  "card show" and "expo" are ignored). Near misses go to `data/review/possible_duplicates.jsonl` and are not
  merged: same venue and date with different names, same name and date at different venues in one town, and
  overlapping dates with different start days.
* **Precedence**, field by field: `data/corrections.yaml`; the organizer's own page (`organizer_confirmed`);
  a promoter's feed; listing sites in `priority` order from `sources.yaml` (smaller number wins); research;
  community. Dates, admission, table prices, the organizer block and each `sells` group are taken whole from
  one source so numbers stay with their currency. Opening hours are filled day by day from other sources.
  The venue and its coordinates travel together.
* **Stable ids.** `data/registry.jsonl` remembers which match keys belong to which id, so an id never changes
  when a name is corrected or a venue renamed. Series ids are reused for the same show in the same place.
* **Sources.** Every contributing source stays in `sources`, with the fields it supplied and the page it came
  from. `verification` is the best of them.
* **History.** A show that no source mentions any more is kept as it was last seen (the site shows a "may be
  out of date" note from `last_checked`). The one exception is a tentative date made from a series rule: it
  goes away when the rule stops making it.
* **Store events** go to `store_events.jsonl` and are left out of series and promoters.
* `estimate` from a source is ignored, and cached coordinates are applied so a merge never loses them.
* Records without a usable date are listed in `data/review/unplaced.jsonl`.

`data/corrections.yaml` is applied last:

```yaml
garden-state-card-show-edison-nj-2026-11-14:
  set:                      # dotted field names; null clears a field
    venue.city: Edison
    vendor.deadline: "2026-11-01"
  note: Confirmed by email.
some-other-show-2026-12-01:
  drop: true                # remove the show
series:garden-state-card-show-edison-nj:
  set: {cadence: Second Saturday of most months}
promoter:example-promotions:
  set: {url: "https://example.com"}
```

### `csa geocode`

Fills `lat`, `lon` and `geo_precision` for every venue that lacks them, then the time zone from the
coordinates. The ladder, stopping at the first answer: **address** (US Census Geocoder batch API, public
domain; then Nominatim for Canada and Census misses), **venue** (Nominatim by venue name and town),
**postal** (centre of the postal code from the GeoNames files made by `csa postal`), **city** (Nominatim for
the town). Nominatim is asked at most once per second with the project's user agent. Answers outside the
stated state or province are refused. Every answer and every miss is kept in `data/geocache.json`, which is
committed so a daily run never repeats work. Misses are retried after 60 days. If a service is down the
command gives up after a few failures and records nothing false. `--limit N` caps Nominatim requests in one
run. `csa merge` uses the cache too, but never the network.

### `csa estimate`

The crowd model of DESIGN section 4. Writes `estimate` (DATA_MODEL section 4) on every show. Signals, best
first: reported attendance, an earlier edition's reported figure carried forward with the series trend,
registered players, vendor tables times an attendees per table factor for the event type and number of
days, an earlier edition's size, venue floor area, and finally a rough guess by event type.

All factors and cut points live in `data/model/priors.json`, each with a `source` note. Where no published
figure exists the entry says `"basis": "placeholder, tune when data arrives"`. Today almost every figure is
a placeholder: only the "small is under about 500 people" cut point (DESIGN) and the one day card show row
(the DATA_MODEL worked example) have a stated origin.

`csa estimate --calibrate` prints the attendees per table fitted from shows that report both numbers, per
event type and number of days, with the count of shows, median and quartiles, and whether the model is
using the fit or the prior. A group switches to its fitted factor once it has `calibration.min_samples`
shows (8 to start). The population within reach of a venue (DESIGN signal 7) is not used yet; it needs a
Census and Statistics Canada feed.

### `csa check`

Prints findings, errors first. Errors block the build; `--strict` makes warnings fail too.

* Errors: required fields missing, bad dates or times, a date in an unlikely year, a run of more than 31
  days, days out of order, an unknown time zone, coordinates outside the stated state or province (simple
  bounding boxes in `csa/regions.py`) or the wrong country, money without a currency, a negative price, a
  vendor deadline after the show, applications opening after the deadline, malformed URLs, any id not in
  `data/vocab.json`, duplicate ids, series and promoter records that point at missing records.
* Warnings: a run of more than 14 days, no coordinates or time zone yet, a close time not after the open
  time, a currency that does not fit the country, unusually high prices, **phone numbers in any free text
  field** (personal phone patterns), an address that looks residential, links to a never use site, a source
  id missing from `sources.yaml`, a long summary, a show that ended long before we first saw it (is the year
  right?).

### `csa build`

Runs `csa check` and stops if there are errors. Otherwise writes into `site/public/data/` (and nothing
else in `site/`). All files are compact JSON, and a file whose content did not change is left alone.

| File | What it holds |
| --- | --- |
| `shows.json` | A JSON array of full records for shows from 30 days ago to 24 months ahead, with `estimate`. |
| `store_events.json` | A JSON array of the same records without `vendor`, `size`, `estimate`, `summary`, `first_seen`, `mix` and `organizer`. |
| `series.json` | A JSON array. Series with an edition in the window; `editions` lists only ids that exist in `shows.json`; `history` keeps every past attendance point. |
| `promoters.json` | A JSON array. Promoters of those series. |
| `vocab.json` | A copy of `data/vocab.json`. |
| `manifest.json` | `built` (date), `fixture: false`, `window`, `counts` (shows, store events, series, promoters, by type, by country), `sources` (id, name, url, kind, credit, number of shows) for every source actually used, and `credits` for GeoNames, OpenStreetMap and the Census geocoder. |

### `csa postal`

Downloads the GeoNames postal code files for the US and Canada (CC BY 4.0) and writes
`site/public/data/postal/US.json` (`{"08837": [40.519, -74.352]}`) and `CA.json` (keyed by the first three
characters and averaged), with coordinates rounded to 3 decimals. Run it when you want fresh data; the
files are committed. GeoNames' robots.txt turns crawlers away from its download server, but this fetches
two named files that GeoNames publishes for download under CC BY 4.0, so robots.txt is not applied here and
nothing else on that server is touched.

### `csa stats`

Counts by type, country, state or province, verification and source, and how many upcoming shows lack
coordinates, opening hours, vendor information, any size signal, or an exact location. `--json` prints
the same as JSON.

### `csa new-source <id> --name "..." --url https://...`

Writes a starter module and prints the registry entry. See the next section.

## Adding a source

A scripted source is only worth adding when the site's robots.txt and terms allow automated use, and the
site is not on `data/never_use_domains.yaml`.

1. `csa new-source my_calendar --name "My Calendar" --url https://my.example/shows` writes
   `pipeline/csa/sources/my_calendar.py` and prints a registry entry.
2. Paste the entry into `data/sources.yaml`. Fill in `kind` (`promoter` if it is the organizer's own
   schedule, otherwise `aggregator`, `publisher`, `platform` or `venue`), `credit` (the text shown on every
   show: "Listed by My Calendar"), `terms` (what you checked and when), `fields` (the show fields we may
   take) and `priority`. Leave `enabled: false` until it works.
3. Edit `harvest(ctx)`. Use `ctx.http.get(url)` for pages (never `httpx` or `requests` directly, so robots.txt,
   rate limits and the cache apply). Yield one dict per show with the fields of DATA_MODEL section 2 that the
   page really states, and `source_url` set to the page it came from. Helpers in `csa/htmlutil.py` read
   schema.org Event data (`jsonld_events`, `event_to_show`) and links (`find_links`). Do not copy prose.
4. Save two or three real pages in a folder laid out like the site (`shows/index.html` for
   `https://my.example/shows/`, plus `robots.txt` if it has one) and run it offline:
   `csa harvest my_calendar --fixture-dir path/to/folder`.
5. Add a test next to `tests/test_harvest.py` that runs it against the saved pages. The existing
   `example_calendar` source and its pages in `tests/fixtures/example_calendar/` are the template.
6. Set `enabled: true` and run `csa harvest my_calendar` once for real, then `csa merge` and `csa check`.

If the site shows a bot challenge, the harvest reports `blocked` and stops. Do not work around it. Tell the
owner, and treat the site as a lead only.

## Folders and files

| Path | What it is |
| --- | --- |
| `data/vocab.json` | Every id of DATA_MODEL section 3 with a display name and a short chip label, the event types, statuses and verification levels, and the `synonyms` the importers use. |
| `data/sources.yaml` | The source registry. |
| `data/never_use_domains.yaml` | The never use and links only domain lists. |
| `data/corrections.yaml` | Hand fixes, applied last. |
| `data/model/priors.json` | Crowd model factors and cut points, each with a source note. |
| `data/geocache.json` | Geocoder answers (committed). |
| `data/registry.jsonl` | Match keys to stable ids (committed). |
| `data/harvest/`, `data/research/`, `data/submissions/` | Inputs to the merge. |
| `data/review/` | Things a person should look at: `possible_duplicates.jsonl`, `unplaced.jsonl`. |
| `data/raw/` | Cached downloads (not committed). |
| `site/public/data/` | What the site loads. |

## Privacy

Only contacts the organizer published for the show are kept. Phone numbers are removed from free text on
the way in (harvest, research and issues), because a number alone cannot show whether it is a business
line; `csa check` warns when one is still there, for example added by hand in `corrections.yaml`.
GitHub usernames are never copied. Nothing from a submission goes live before it is moved to `approved/`.

## Dependencies

| Package | Why |
| --- | --- |
| `pyyaml` | `sources.yaml`, `corrections.yaml`, the domain lists and the issue form templates. |
| `httpx` | The HTTP client. Its mock transport lets every test run without the network. |
| `rapidfuzz` | Name similarity for duplicate detection. |
| `timezonefinder` | Time zone from coordinates, offline. It brings numpy. The alternative is a shapefile and a geometry library, which is heavier. |
| `pytest` (dev) | Tests. |

All four runtime packages are pinned to exact versions in `pyproject.toml`.
