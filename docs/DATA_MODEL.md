# Card Show Atlas: data model

The pipeline (Python, `pipeline/`) turns many sources into one list of shows. The site (Astro, `site/`)
reads that list. This file is the contract between them. Change it here first, then in code.

## 1. Flow

```
sources (scripts, research agents, submissions, corrections)
   |
   v
data/harvest/<source>.jsonl     one file per scripted source, rewritten on each harvest
data/research/<wave>.jsonl      imported research agent findings
data/submissions/*.json         reviewed form and GitHub submissions
data/corrections.yaml           hand fixes; always win
   |
   v  csa merge   (dedupe, pick field values by source precedence, keep every source)
data/shows.jsonl                canonical show editions, one JSON object per line, sorted by id
data/series.jsonl               recurring series
data/promoters.jsonl            organizers and promoters
data/store_events.jsonl         store events layer (kept apart, see DESIGN section 8)
   |
   v  csa estimate (crowd model)  ->  csa check (rules)  ->  csa build
site/public/data/               what the site loads (see section 6)
```

Raw downloads are cached under `data/raw/` and are not committed.

## 2. Show edition

One record is one edition of a show: a specific date or run of dates at a specific venue. A monthly
show is twelve records sharing one `series_id`.

```json
{
  "id": "garden-state-card-show-edison-nj-2026-11-14",
  "series_id": "garden-state-card-show-edison-nj",
  "name": "Garden State Card Show",
  "event_type": "card_show",
  "status": "scheduled",
  "days": [
    {"date": "2026-11-14", "open": "09:00", "close": "15:00"},
    {"date": "2026-11-15", "open": "10:00", "close": "14:00"}
  ],
  "timezone": "America/New_York",
  "venue": {
    "name": "Example Expo Hall",
    "address": "97 Sunfield Ave",
    "city": "Edison",
    "region": "NJ",
    "postal": "08837",
    "country": "US",
    "lat": 40.5187,
    "lon": -74.3518,
    "geo_precision": "address"
  },
  "sells": {
    "tcg": ["pokemon", "mtg", "one_piece"],
    "sports": ["baseball", "basketball", "football"],
    "other": ["comics"]
  },
  "mix": "mixed",
  "admission": {"free": false, "adult": 5, "child": 0, "currency": "USD", "notes": "Under 12 free"},
  "size": {
    "tables": 120,
    "booths": null,
    "venue_sqft": null,
    "players": null,
    "reported_attendance": {"value": 3000, "year": 2025, "source_url": "https://example.com/recap"},
    "first_year": 2019,
    "edition": null
  },
  "vendor": {
    "tables": [{"label": "8 ft table", "price": 150, "currency": "USD", "notes": "2 badges included"}],
    "application_url": "https://example.com/vendors",
    "opens": "2026-08-01",
    "deadline": "2026-10-31",
    "status": "open",
    "electricity": "25 USD extra",
    "setup": "07:00",
    "contact": "vendors@example.com",
    "notes": null
  },
  "organizer": {"name": "Example Promotions", "promoter_id": "example-promotions", "url": "https://example.com"},
  "links": {"official": "https://example.com/show", "tickets": null, "facebook": null, "instagram": null},
  "sources": [
    {"source": "example_calendar", "url": "https://calendar.example.org/show/123", "retrieved": "2026-10-21",
     "fields": ["name", "days", "venue", "admission"]}
  ],
  "verification": "listed",
  "first_seen": "2026-10-21",
  "last_checked": "2026-10-21",
  "summary": null,
  "estimate": null
}
```

### 2.1 Field rules

| Field | Rule |
| --- | --- |
| `id` | `<series_id>-<first date>`. Stable: once assigned it never changes, even if the name is corrected later (the merge step keeps a registry of match keys to ids in `data/registry.jsonl`). |
| `series_id` | Slug of name plus city plus region. Same promoter running the same show at the same venue. |
| `event_type` | `card_show`, `convention` (collectibles or card convention), `tournament` (premier event with a vendor hall), `pop_culture_con` (comic, anime, gaming con with card vendors), `store_event`. |
| `status` | `scheduled`, `tentative` (date announced but not confirmed, or "usually the second Sunday"), `postponed`, `cancelled`. Past shows keep their last status; "past" is derived from dates. |
| `days` | At least one. Local dates and 24 hour local times. `open` and `close` may be null when unknown. |
| `timezone` | IANA name, filled from coordinates when the source does not give it. |
| `venue.region` | Two letter state or province code. |
| `venue.geo_precision` | `address`, `venue` (looked up by venue name), `postal`, `city`. The map shows a softer marker for `postal` and `city`. |
| `sells` | Ids from `data/vocab.json`. Empty lists mean unknown, not "none". |
| `mix` | `tcg`, `sports`, `mixed`, `unknown`. Derived from `sells` when not stated. |
| Money | Numbers in the listed `currency` (`USD` or `CAD`). Never convert silently. |
| `vendor.status` | `open`, `waitlist`, `sold_out`, `closed`, `unknown`. |
| Contacts | Only contacts the organizer published for the show (its own email, form, page or business phone). Never a personal number or home address, even when a source shows one. |
| `sources` | Every source that listed this edition, with the fields it supplied. Used for the credit lines on the show page. |
| `verification` | `organizer_confirmed` (seen on the organizer's own page or post), `listed` (seen on a listing site), `community` (reviewed submission only), `unverified`. |
| `summary` | Our own one or two sentences, or null. Never copied text. |
| `estimate` | Written by `csa estimate` only (section 4). Anything a source supplies here is ignored. |

## 3. Vocabulary (`data/vocab.json`)

* `tcg`: `pokemon`, `mtg`, `yugioh`, `one_piece`, `lorcana`, `dragon_ball`, `digimon`, `fab` (Flesh and
  Blood), `swu` (Star Wars Unlimited), `weiss_schwarz`, `union_arena`, `riftbound`, `sorcery`, `gundam`,
  `metazoo`, `grand_archive`, `vanguard`, `altered`, `other_tcg`.
* `sports`: `baseball`, `basketball`, `football`, `hockey`, `soccer`, `racing`, `wrestling`, `combat`,
  `golf`, `multi_sport`.
* `other`: `non_sport`, `comics`, `toys`, `video_games`, `memorabilia`, `coins`, `anime`.

Each id has a display name and a short label for chips. New ids are added here first.

## 4. Estimate (written by `csa estimate`)

```json
"estimate": {
  "attendance": {"low": 400, "mid": 700, "high": 1100},
  "basis": "tables",
  "confidence": "estimated",
  "size_class": "medium",
  "traffic_per_table": 5.8,
  "explain": "Estimated from 120 vendor tables at a one day card show."
}
```

* `basis`: `reported`, `players`, `tables`, `area`, `history`, `type_default`.
* `confidence`: `reported`, `estimated`, `rough`.
* `size_class`: `small`, `medium`, `large`, `major`. Cut points and factors live in
  `data/model/priors.json`, each with a source note.

## 5. Series and promoters

`data/series.jsonl`: `id`, `name`, `promoter_id`, `venue` (usual), `cadence` (text, for example "second
Sunday of most months"), `editions` (ids), `links`, `history` (past attendance points).

`data/promoters.jsonl`: `id`, `name`, `url`, `region`, `series` (ids), `links`, `public_contact`.

## 6. Site data (written by `csa build`)

| File | Contents |
| --- | --- |
| `site/public/data/shows.json` | Full records for shows from 30 days ago to 24 months ahead, plus `estimate`. Used to build static show pages. |
| `site/public/data/index.json` | Compact rows for the map and lists (built by the site's prepare step from `shows.json`). |
| `site/public/data/store_events.json` | The store events layer, compact rows. Loaded only when switched on. |
| `site/public/data/series.json`, `promoters.json` | For series pages. |
| `site/public/data/vocab.json` | Copy of the vocabulary. |
| `site/public/data/postal/US.json`, `CA.json` | Postal code to coordinates (GeoNames, CC BY 4.0). Canada uses the first three characters. Loaded on demand. |
| `site/public/data/manifest.json` | Build time, counts by type and country, list of sources with credit text, and `fixture: true` when sample data is in use. |

## 7. Sources registry (`data/sources.yaml`)

```yaml
- id: example_calendar
  name: Example Card Show Calendar
  url: https://calendar.example.org
  kind: aggregator          # aggregator, promoter, publisher, platform, venue, community, submission
  method: script            # script, research, manual
  credit: "Listed by Example Card Show Calendar"
  terms: "No scraping clause found; robots allows /shows/ (checked 2026-10-21)"
  fields: [name, days, venue, admission]
  checked: 2026-10-21
```

A source is only harvested if its robots.txt and terms allow it. Sources that forbid automated
collection may still be used by hand as leads, confirmed on the organizer's own page.

## 8. Merge precedence

When sources disagree, the value comes from the first of:

1. `data/corrections.yaml`
2. The organizer's own page or post (`organizer_confirmed`)
3. A promoter's own schedule harvested by script
4. Listing sites, in the order of `sources.yaml` `priority`
5. Research agent findings
6. Community submissions

Two records are the same edition when they share a start date and country, and either the venues are
within 1.5 km or the venue names match after normalizing, and the names are similar. Near misses go to
a review list (`data/review/possible_duplicates.jsonl`) instead of being merged.

## 9. Research agent output

Each research agent writes ONE file, `research/inbox/<wave>/<agent>.json`:

```json
{
  "wave": "w1-promoters-pa",
  "agent": "a03",
  "model": "haiku",
  "searches_used": 4,
  "fetches_used": 31,
  "records": [ {"kind": "edition", "...": "..."}, {"kind": "series", "...": "..."} ],
  "leads_only": [{"name": "Example Monthly Show", "url": "https://example.com", "note": "named on a promoter page, not checked"}],
  "blocked": [{"url": "https://example.org", "status": 403, "note": "bot check"}],
  "notes": "anything surprising"
}
```

A record with `"kind": "edition"` is a partial show record (section 2). A record with
`"kind": "series"` describes a recurring show (section 9.1). Every record also carries:

```json
"evidence": [{"url": "https://organizer.example.com/schedule", "seen": "2026-10-21", "supports": ["days", "venue", "vendor.tables"]}],
"agent_confidence": "high"
```

No copied prose: `summary` is written fresh, and `evidence` holds links and the fields each link
supports, not quotes. `csa import-research <wave>` validates, repairs small mistakes, writes rejects
with reasons to `research/inbox/<wave>/_rejected.jsonl`, and appends good records to
`data/research/<wave>.jsonl`. The importer also accepts a bare single record file.

### 9.1 Recurring series

Many local shows run on a pattern ("second Sunday of every month") and post dates only a few weeks out.

```json
{
  "kind": "series",
  "name": "Example Monthly Card Show",
  "venue": {"name": "VFW Post 123", "address": "1 Main St", "city": "Media", "region": "PA", "postal": "19063", "country": "US"},
  "cadence": "Second Sunday of every month except July and August",
  "rule": {"freq": "monthly", "weekday": "sun", "nth": 2, "skip_months": [7, 8], "until": null},
  "hours": {"open": "09:00", "close": "14:00"},
  "known_dates": ["2026-11-08", "2026-12-13"],
  "cancelled_dates": [],
  "last_confirmed": "2026-10-15",
  "event_type": "card_show",
  "sells": {"tcg": ["pokemon"], "sports": ["multi_sport"], "other": []},
  "admission": {"free": true, "currency": "USD"},
  "vendor": {"tables": [{"label": "6 ft table", "price": 40, "currency": "USD"}], "status": "open"},
  "organizer": {"name": "Example Promotions", "url": "https://example.com"}
}
```

* `rule.freq`: `weekly`, `monthly` (with `weekday` and `nth`, where `nth` is 1 to 4 or `-1` for last),
  or `none` (only `known_dates`).
* `csa merge` turns `known_dates` into `scheduled` editions, and expands `rule` into `tentative`
  editions for the next 90 days only, never past `until`, skipping `skip_months` and `cancelled_dates`.
  Tentative editions say "Usually on this date. Check with the organizer before you go."
* A series whose `last_confirmed` is older than 120 days stops generating tentative editions.
