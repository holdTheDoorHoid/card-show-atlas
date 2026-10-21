# Card Show Atlas: sources

Where listings come from, what we take from each, and how each is credited. The machine readable
registry is `data/sources.yaml`. Full survey notes from 2026-10-21 are summarized here.

## The rule

The owner's decision: copy facts (name, dates, venue, prices) **where the source's rules allow it**,
credit and link the source on every show, and mark a show "listed by X" until the organizer's own page
confirms it. A source is collected automatically only when both its robots.txt and its terms allow it.
We never get around a bot check, log in, or create accounts.

## What the survey found

There is no open nationwide card show feed. Every big listing site either forbids automated
collection in its terms, sits behind a bot check, or is itself compiled from other sites. So Card
Show Atlas is built from:

1. **Promoters' and publishers' own pages**, collected by script where allowed and by research agents
   otherwise.
2. **Organizer submissions** (Google Form and GitHub), which is also the only realistic source of
   vendor deadlines.
3. **Permission requests** to the listing sites below. Their data stays out until they say yes.

## Collected by script (allowed by robots and terms)

| Source | What | Notes |
| --- | --- | --- |
| trainerchampionships.com | Pokémon Regionals, Specials, Internationals in North America | WordPress pages and event sitemap. Fees, dates, venues. |
| yugioh-card.com/en/events | Yu-Gi-Oh YCS and premier events | Server rendered table. |
| starwarsunlimited.com organized play calendar | Star Wars Unlimited Sector Qualifiers and premier events | Calendar page. Its public event API (781 events) is a store events candidate. |
| mtg.wiki Premier Play season pages | Magic Regional Championships, Pro Tours, MagicCons, with attendance | Community wiki citing Wizards. |
| limitlesstcg.com, onepiece.limitlesstcg.com | Past player counts for Pokémon and One Piece premier events | Used to calibrate crowd estimates, not to list shows. |
| Ravensburger Play Hub API | Disney Lorcana events with capacity and registered counts | Undocumented but open. Big events become `tournament`; weekly locals go to the store events layer. Low request rate, store emails never kept. Permission email drafted. |
| Riftbound locator API | Riftbound events | Same platform as Play Hub. Thin right now. |
| collectaconusa.com | Collect-A-Con tour dates, vendor table prices and sold out flags | WordPress and WooCommerce store API. |
| frontrowcardshow.com products | Front Row table prices (history) | Shopify product list. The vendor page itself has a bot check: not collected. |
| dallascardshow.com | Dallas Card Show schedule | Robots says AI input allowed. |
| Venue calendars with an open events API | For example Palm Beach County Convention Center | Probed venue by venue. |
| cgccards.com news | "CGC on site at (show)" posts: a strong sign a show is mid size or larger | Robots allows. |

### Which of these are running

Eight of them are scripted now, in `pipeline/csa/sources/`, registered in `data/sources.yaml` and run by
`csa harvest all` (the daily refresh):

| Source id | Gives | Layer |
| --- | --- | --- |
| `collectacon` | Collect-A-Con tour dates, hours, venue, table counts, table prices and sold out flags | conventions |
| `yugioh_events` | In person Yu-Gi-Oh! Championship Series events in the US and Canada | tournaments |
| `pokemon_championships` | Pokémon Regionals and Specials in the US and Canada, with fees | tournaments |
| `swu_calendar` | Star Wars Unlimited Sector Qualifiers (tournaments) and Planetary Qualifiers (store events) | both |
| `mtg_premier` | Magic Regional Championships, Pro Tours, MagicCons, with reported attendance | tournaments |
| `lorcana_playhub` | Lorcana events: big ones as tournaments, weekly play in the next 21 days as store events (kept in data/store, not committed) | both |
| `riftbound_locator` | The same for Riftbound | both |
| `limitless_results` | Player counts of past Pokémon and One Piece premier events, as history for the crowd estimate | tournaments (past) |

The sources that are only listed above (Front Row, Dallas Card Show, venue calendars, CGC news, the Star Wars
Unlimited store API) are not written yet. Each module says at the top what was checked and when, and each
stops with a plain message, keeping the last good file, when the page it reads changes shape.

## Read by research agents (organizer pages)

Promoter sites run on many builders (Wix, Squarespace, GoDaddy, Shopify, WordPress), so a script per
promoter does not scale. Haiku research agents read promoters' own schedule and vendor pages and record
facts with the page as evidence. The survey listed about 38 promoter chains to start from, from The
National and Collect-A-Con down to monthly VFW hall shows.

## Leads only (never collected automatically)

Facebook, Instagram, TikTok, X, Reddit, Discord, Meetup, Eventbrite, AllEvents. Research agents may
record a link to one of these but take facts only from other pages.

## Off limits until permission

| Source | Why | Status |
| --- | --- | --- |
| Sports Collectors Digest show calendar (AIM Media) | Best table and price data (333 shows, 287 with table counts) but the terms forbid automated access. Collect.com events (same owner) likewise. | Permission email drafted for the owner. |
| CardShowMap.com | About 1,200 venues with table counts and coordinates. One developer's project, all rights reserved. | Permission email drafted. |
| Treasure Hunter | 5,145 upcoming listings and an API, but the terms forbid bulk collection and competing products. | Permission email drafted. |
| The Card Shop Finder | Events and a 1,842 shop directory. Behind a bot check. | Permission email drafted. |
| TopDeck.gg | Best convention and registered player data across games. Official API has no upcoming search. | Feed request drafted. |
| Card Show Hub, CardShowFinder | Competitors compiled from other sources; CardShowFinder's terms forbid copying. | Not used. Counts used only to measure our coverage. |
| Sports Card Investor events, CardPulse | Terms forbid bots. | Not used. |
| Wizards store locator, RK9 | Terms forbid scraping. | Not used. We link to them. |

## Blocked by bot checks (not attempted)

events.pokemon.com, melee.gg, fabtcg.com, beckett.com, psacard.com, sportscollectorsdaily.com,
fancons.com, animecons.com, blowoutforums.com, net54baseball.com, and a few promoter sites.

## Other data

* Postal code coordinates: GeoNames (CC BY 4.0).
* Geocoding: US Census Geocoder (public domain), Nominatim (OpenStreetMap, ODbL) within its usage policy.
* Map tiles: OpenStreetMap contributors.

## Coverage benchmark

Competitors list roughly 1,700 to 5,100 upcoming US dates (Card Show Hub 2,957, CardShowFinder 1,733,
Treasure Hunter 5,145 counting every date of recurring shows). Those counts are our yardstick.
