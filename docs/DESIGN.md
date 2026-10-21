# Card Show Atlas: design

This document is the source of truth for what the site does and why. The data format lives in
[DATA_MODEL.md](DATA_MODEL.md); where the data comes from lives in [SOURCES.md](SOURCES.md).

## 1. Goal

Make it easy for anyone in the US or Canada to find trading card shows near them, and make it easy
for vendors to choose shows, keep track of when to apply and what tables cost, and plan routes that
hit several shows in one trip or across a season.

Two kinds of people use it:

* **Show goers** (collectors, players, parents): "What is on near me this weekend, and is it worth the drive?"
* **Vendors**: "Which shows should I do this season, when do I apply, what will it cost, which order
  do I drive them in, and will it pay?"

## 2. Decisions (owner interview, 2026-10-21)

These were made by the owner. Do not reopen them without asking.

| Topic | Decision |
| --- | --- |
| Name | **Card Show Atlas** |
| Show scope | Every card show: sports, TCG and mixed, each tagged by what is sold. Filters hide sports only shows. |
| Other event types | Also: big tournaments with vendor halls, pop culture and anime cons with card vendors, and store events (prereleases, leagues). Store events are a separate layer that is **off by default**. |
| Geography | US and Canada. Data model ready for other countries. |
| Other listing sites | Copy the facts (name, dates, venue, prices) where the site's rules allow it, with credit and a link on every show, marked "listed by X" until the organizer's own page confirms it. Never copy anyone's write up. |
| Submissions | A Google Form the owner runs (no account needed to submit) plus GitHub issue forms. Everything goes to a review queue before it is published. |
| Route planning | Weekend run, season planner, and a profit estimate on every plan. |
| Research | AI research agents on Haiku. Launch push of up to about 35% of a week's allowance, then small nightly top ups. |
| Credit | No credit line on the site. |
| Launch | Public repo and live site from day one, with an "early preview" notice. |

Defaults chosen by the builder (owner informed, may change):

* Vendor tracking and plans are saved **in the browser**, with a backup file and share links. No accounts.
* Code under MIT, data under CC BY 4.0.
* Site: Astro with Preact islands and Leaflet, published to GitHub Pages. Data pipeline: Python.

## 3. Pages

### 3.1 Find (home page)

Three questions, answered in one row on desktop and stacked on a phone:

1. **Where are you?** ZIP or postal code, or "use my location". The answer stays on the device.
2. **How far will you go?** A slider in miles (km in Canada) from 10 to 500, with the estimated drive
   time shown next to it ("about 2 h 10 min").
3. **When?** Chips: This weekend, Next 2 weeks, Next 30 days, Pick dates.

Below that, filters as chips: what is sold (Pokémon, Magic, Yu-Gi-Oh, One Piece, Lorcana, sports,
more...), event type (card shows, conventions, tournaments, pop culture cons), size, free entry, and
"has vendor tables available".

Results are a list. Each row shows date, name, town, distance and drive time, a size badge, what is
sold, entry price, and a "vendors" note when table info is known. Sort by date (default), distance,
size, or best match. The same results can be flipped to the map with one tap.

### 3.2 Map

* Leaflet with OpenStreetMap tiles, clustered markers, marker shape and color by event type (shape so
  color is never the only cue).
* **Time window bar** along the bottom: a timeline of the next 12 months with a small bar chart of how
  many shows fall on each day, and a window you drag along it. The window's width is adjustable (one
  day to three months; default seven days from today). Markers update live as the window moves. A play
  button steps the window forward a week at a time so you can watch the season.
* Tapping a marker opens a card with the essentials and links to the show page.
* The same filters as Find. Store events appear only when their layer is switched on.

### 3.3 Show page

One static page per show edition (good for search engines), with:

* Dates and hours with time zone, status (scheduled, tentative, postponed, cancelled), venue, address
  and a small map, directions link.
* Entry price, what is sold, event type, size badge with **how we know** ("reported by the organizer",
  "estimated from 120 vendor tables", "estimated from past years").
* Vendor box: table prices and sizes, application link, application opens and deadline, status (open,
  waitlist, sold out, closed, unknown), electricity, setup times.
* Organizer, official links, social links.
* Sources: every source that listed it, with credit and link, and a badge: **Confirmed by organizer**,
  **Listed by (source)**, or **Community submitted**. "Last checked" date.
* Actions: add to calendar (.ics), add to My shows, plan a trip from here, suggest an edit.
* Other editions of the same series (past and future), so people can see it is a regular thing.

### 3.4 Browse pages

State and province pages, and pages for recurring series and promoters. Plain lists that search
engines can read.

### 3.5 My shows (vendor tracker)

Saved in the browser. A board with these columns:

Watching → Applied → Waitlisted / Accepted → Paid → Done, plus Skipped.

For each show: table type and price paid, application date, deadline, payment due, notes, and after
the show, actual gross sales and a 1 to 5 "would do again". A deadlines list shows "apply by" dates in
order, with the soonest highlighted. Export to calendar (.ics) includes reminders a week and a day
before each deadline. Backup and restore to a file (to move between phone and laptop). A clear warning
that clearing browser data deletes it, with a nudge to make a backup after changes.

Vendor settings (also in the browser): home base, vehicle miles per gallon (or L/100 km), fuel price,
hotel price per night, food per day, maximum driving hours per day, typical gross sales at a small,
medium, large and major show, and margin on sales.

### 3.6 Plan a trip

Two modes, explained in section 6:

* **Weekend run**: one trip, several shows over a few days.
* **Season planner**: the best set of shows across a date range, each trip starting from home.

Every plan shows a **profit estimate** and the route on a map, and can be exported (.ics, a Google Maps
directions link, a share link).

### 3.7 About, sources, submit

How the data is gathered, every source credited, how size and crowd are estimated, how to add a show
or fix one (Google Form or GitHub), and how to ask for a removal.

## 4. Expected crowd and show size

Ranking needs a number for "how many people will come". Most shows never publish one, so the site
estimates it and always says how.

### 4.1 Signals, best first

1. Attendance reported by the organizer or press for this edition or a past one.
2. Registration or player counts for tournaments (published by tournament platforms).
3. Number of vendor tables or booths.
4. Venue floor area.
5. History: edition number, years running, how many past editions we have seen.
6. Admission price, number of days, event type.
7. People within reach: population within about an hour's drive (from Census and Statistics Canada).

### 4.2 Model

* Each show gets an expected attendance **range** (low, typical, high) per show and per day, and a
  confidence: reported, estimated, or rough guess.
* From tables: attendance is tables times an "attendees per table" factor that depends on event type
  and number of days. The factor is fitted from the shows that publish both numbers. Until enough exist,
  the factor starts from documented priors in `data/model/priors.json`, each with its source.
* Past editions carry forward, adjusted by the series' recent trend.
* Size badge from the typical value: **Small** (under about 30 tables or 500 people), **Medium**,
  **Large**, **Major** (thousands of people over a weekend). The exact cut points live in the priors
  file and are tuned once real data arrives.
* **Traffic per table** (expected attendance divided by tables) is shown to vendors, because a big show
  with 600 tables can be a worse room than a mid sized show with 60.

## 5. Ranking

### 5.1 Show goers: "best match"

Closer is better (a gentle decay, not a cliff), bigger is better, matching what you collect is better,
sooner is slightly better, free entry is a small bonus.

### 5.2 Vendors: priority score

Shown as a number out of 100 with the reasons listed underneath ("big crowd, cheap table, 3 h drive,
you rated it 4 last year"). Inputs:

* Expected crowd and traffic per table.
* Table cost.
* Travel time and cost from home (or from the previous show in a route).
* How well what is sold matches what the vendor sells.
* The vendor's own history with this series (from My shows).
* Application status: closed or sold out shows drop out, waitlists are marked.

Weights are sliders with presets: **Biggest crowds**, **Cheapest**, **Closest**, **Balanced** (default).
When the vendor has filled in typical sales, the score switches to expected profit (section 7).

## 6. Route planning

All planning runs in the browser in a background worker. Nothing is sent to a server.

### 6.1 Travel model

* Planning uses straight line distance times a road factor (1.25 to start, tuned against real routes)
  and an average speed that is lower on short legs. Fast enough to compare thousands of options.
* The final plan can ask a public routing service for real drive times, once, when the user taps
  "check real drive times". If the service is unavailable the estimate stands, clearly labeled.

### 6.2 Two ways of attending

* **Vending**: you are at your table for the whole show. A multi day show takes all its days. Driving
  happens before setup and after teardown, capped by maximum driving hours per day. One show per day.
* **Shopping**: you visit several shows in a day, staying a set time at each (default 90 minutes),
  inside their opening hours.

Weekend run asks which one; the season planner is for vending.

### 6.3 Weekend run

Inputs: start and end point (default home), dates, vending or shopping, maximum driving hours per day,
whether to stay overnight or come home each night.

* Vending: shows are blocks of days. The best plan is the best chain of non overlapping shows where each
  next show is reachable in the time between, plus the trip home. This is solved exactly.
* Shopping: an orienteering problem with opening hours (pick the most valuable set of stops that fits
  the day). Small enough to search well: exact for a handful of candidates, a tested heuristic beyond.

The result shows each day, each leg (miles, hours), overnight towns, costs, expected sales and profit,
and two or three alternatives ("one fewer show, home Saturday night").

### 6.4 Season planner

Inputs: date range (for example the next 3 or 6 months), blackout dates (day job, family), weekends
only or any day, maximum shows per month, longest stretch away from home, and whether to chain shows
into longer trips or go home between them.

The planner picks the set of shows that maximizes total expected profit (or priority score) within those
rules, never two at once, and lists every application deadline in the plan in date order. Shows whose
deadline has passed are left out, or marked "waitlist only" when the organizer keeps one.

### 6.5 Sharing

A share link encodes the plan's shows and settings. It does **not** include the home location unless
the user ticks "include my start point", so a link pasted in a group chat never reveals someone's address.

## 7. Profit estimate

```
expected gross sales  = typical sales for the show's size class
                        x the vendor's own past results at this series, if any
                        x a traffic per table adjustment
contribution          = expected gross sales x margin on sales
costs                 = table fee + extras (electricity, extra badge)
                        + fuel (miles / mpg x fuel price)
                        + hotel nights x price per night
                        + food per day x days away
estimated profit      = contribution - costs
```

Every number is shown and editable in place, and the estimate is labeled as an estimate with a range,
not a promise.

## 8. Store events layer

Store events (prereleases, leagues, weekly tournaments) come from publisher locators and organizer
platforms where their rules allow. They live in their own data file, are loaded only when the layer is
switched on, never count toward "shows near you", and are left out of route planning unless the user
asks for them.

## 9. Freshness

* **Daily**: scripted feeds refresh, the pipeline rebuilds, and the site redeploys (GitHub Action).
* **Nightly**: AI research runs work through a queue (new shows, missing vendor info, re checks of shows
  coming up in the next 60 days), within the budget in `research/budget.yaml`.
* Every show carries "last checked". Shows not seen in any source for a while get a "may be out of
  date" note rather than vanishing.
* Past shows stay in the data as history (they feed crowd estimates and series pages) but drop off the
  map and lists.

## 10. Privacy and safety

* Location, My shows and plans stay on the device. No accounts, no tracking, no analytics.
* Only public organizer contacts are published (a show's own email, page or phone). No personal phone
  numbers or home addresses, even if a source shows them.
* Removal requests are honored.
* Share links leave out the start point by default (section 6.5).

## 11. Look and feel

Mobile first: vendors use this in parking lots. Big tap targets, readable in sunlight, light and dark
themes, works on a slow connection (the main data file is kept small, store events load separately).
Plain words: "Apply by Nov 3", not "Application deadline (ISO 8601)".

## 12. Open questions for later

* Reading Google Form responses from the daily job needs a credential stored as a GitHub secret. Ask
  the owner before creating it.
* Real drive times: which free routing service, within its usage policy.
* Whether to let visitors report "how busy was it" after a show, which would need a small server.
