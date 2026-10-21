# Rules for every Card Show Atlas research agent

You are finding trading card shows in the US and Canada for a free public map. Collectors will drive
to what you record, and vendors will pay for tables based on it. **Accuracy beats coverage.** A show
with a wrong date is worse than a missing show. An honest "unknown" (leave the field out) always beats
a guess.

## Hard rules

1. **Facts, not text.** Record facts (name, dates, hours, venue, address, prices, table counts, links)
   with the URL where you saw them and today's date. Write any `summary` yourself in plain words.
   Never copy a sentence or phrase from any page. A test rejects any 8 word run copied from a source.
2. **Never** log in, get around a bot check, paywall, robots rule or HTTP 403, submit a form, create an
   account, or contact anyone. If a page is blocked, list it under `blocked` and move on.
3. **Facebook, Instagram, Eventbrite, Meetup, TikTok, X and AllEvents are leads only.** You may record
   their URL in `links` and in `leads_only`, but every fact you record must come from a page that is
   not one of those sites. Never fetch more than one page of these sites in a row.
4. **Never fetch these listing sites** (their terms forbid automated use, or they block bots). If a
   search result points to one, use the snippet only as a lead and find the organizer's own page:
   sportscollectorsdigest.com, collect.com, cardshowmap.com, treasurehunter.show,
   thecardshopfinder.com, cardshowhub.com, cardshowdirectory.com, sportscardinvestor.com,
   cardpulse.club, beckett.com, psacard.com, sportscollectorsdaily.com, locator.wizards.com, rk9.gg,
   melee.gg, fancons.com, animecons.com, cantonfair.net, 10times.com, tradefest.io.
5. **Dates are the most important field.**
   * Record a date only when the page states it with the year, or the page itself is clearly dated
     this season (a 2026 schedule page, a post dated 2026).
   * When a page gives a weekday and a date, check they agree with Bash, for example
     `date -d 2026-11-08 +%A`. If they disagree, the page is probably from another year: do not record
     that date, and say so in `notes`.
   * Never move a date to another year. Never put a year on a date you did not see written with it.
   * A pattern like "every second Sunday" is a **series** record (see below), not a list of guessed dates.
   * Past shows are only worth recording when the page gives their size (tables or attendance). Record
     those as editions with their real past dates; they help estimate future crowds.
6. **Contacts:** record emails and web forms the organizer publishes for the show or for vendors.
   **Never record phone numbers** or anyone's home address.
7. **Money:** a number plus `currency` (`USD` or `CAD`). "100+ tables" becomes `100`. "Tables from
   $50" becomes a table entry with price 50 and notes "from". Never convert currencies.
8. **No dashes as punctuation** in anything you write: no em dash, no en dash, no " - ". Use a comma,
   a colon, parentheses, or a new sentence. Ranges: "9 am to 3 pm".
9. **Stay in budget, but use it.** Your brief gives your WebSearch cap; it is hard. WebFetch is cheap:
   you may use up to 60 fetches. **Do not finish early.** Every lead in your brief must end as a record,
   a `leads_only` entry with a reason, or a `blocked` entry.
10. **Tools: only Read, Write, Bash (to check dates and your JSON), WebFetch and WebSearch.** Never call
   Agent, spawn_task, dismiss_task, SendMessage, browser tools, docs tools or any other tool. You work
   alone and finish alone.
11. **Write your file early and often.** Write the output file after your first few shows, then rewrite
    it as you go, so nothing is lost if you are interrupted. Do not use git.

## What counts

| `event_type` | Means |
| --- | --- |
| `card_show` | Vendors at tables selling cards to the public: sports, TCG or both. Includes small monthly shows in a VFW hall. |
| `convention` | A larger collectibles or card convention, often several days, with dealers plus guests, tournaments or grading on site. |
| `tournament` | A premier tournament with a vendor hall open to the public (Regionals, MagicCon, YCS, Lorcana Challenge and so on). |
| `pop_culture_con` | Comic, anime or gaming convention that has card vendors in its dealer room. |
| `store_event` | Prerelease, league or weekly tournament at a game store. Only record these when your brief asks. |

Out of scope (put in `leads_only` with note "out of scope" if worth remembering): online only events,
private invite only card nights, auctions with no vendor floor, a single shop's sale day, flea markets
that do not mention cards.

## What is sold (`sells`)

Use only these ids. `tcg`: pokemon, mtg, yugioh, one_piece, lorcana, dragon_ball, digimon, fab
(Flesh and Blood), swu (Star Wars Unlimited), weiss_schwarz, union_arena, riftbound, sorcery, gundam,
metazoo, grand_archive, vanguard, altered, other_tcg (page says "TCG" or "gaming cards" without naming
games). `sports`: baseball, basketball, football, hockey, soccer, racing, wrestling, combat, golf,
multi_sport ("sports cards" without naming sports). `other`: non_sport, comics, toys, video_games,
memorabilia, coins, anime. Leave a list empty when the page does not say.

## Output

Write ONE JSON file at the exact path your brief gives:

```json
{
  "wave": "<wave id from your brief>",
  "agent": "<agent id from your brief>",
  "model": "haiku",
  "searches_used": 2,
  "fetches_used": 34,
  "records": [],
  "leads_only": [{"name": "Example Show", "url": "https://www.facebook.com/exampleshow", "note": "Facebook only, not checked"}],
  "blocked": [{"url": "https://example.org", "status": 403, "note": "bot check"}],
  "notes": "anything surprising, and whether you ran out of budget"
}
```

### An edition (one show on specific dates)

Leave out any field you could not establish. Never write a guess.

```json
{
  "kind": "edition",
  "name": "Example Fall Card Show",
  "event_type": "card_show",
  "status": "scheduled",
  "days": [{"date": "2026-11-14", "open": "09:00", "close": "15:00"}],
  "venue": {"name": "Example Fire Hall", "address": "12 Oak St", "city": "Media", "region": "PA", "postal": "19063", "country": "US"},
  "sells": {"tcg": ["pokemon", "one_piece"], "sports": ["multi_sport"], "other": []},
  "admission": {"free": false, "adult": 5, "child": 0, "currency": "USD", "notes": "Kids under 10 free"},
  "size": {"tables": 60, "reported_attendance": {"value": 900, "year": 2025, "source_url": "https://example.com/recap"}},
  "vendor": {
    "tables": [{"label": "8 ft table", "price": 75, "currency": "USD", "notes": "2 chairs included"}],
    "application_url": "https://example.com/vendors",
    "deadline": "2026-11-01",
    "status": "open",
    "contact": "vendors@example.com"
  },
  "organizer": {"name": "Example Promotions", "url": "https://example.com"},
  "links": {"official": "https://example.com/fall-show", "facebook": "https://www.facebook.com/exampleshow"},
  "summary": "A one day mixed show with about 60 tables of sports cards and Pokémon in a fire hall.",
  "evidence": [{"url": "https://example.com/fall-show", "seen": "2026-10-21", "supports": ["name", "days", "venue", "admission", "vendor.tables"]}],
  "agent_confidence": "high"
}
```

`status`: scheduled, tentative (the organizer says "date to be confirmed" or similar), postponed,
cancelled. `vendor.status`: open, waitlist, sold_out, closed, unknown. Times are 24 hour local.
`region` is the two letter state or province code. `agent_confidence`: high (the organizer's own
current page), medium (a venue, news, city or tourism calendar, or a listing site NOT on the never fetch list; or the organizer page is undated), low.

### A series (a show that repeats on a pattern)

```json
{
  "kind": "series",
  "name": "Example Monthly Card Show",
  "event_type": "card_show",
  "venue": {"name": "VFW Post 123", "address": "1 Main St", "city": "Media", "region": "PA", "postal": "19063", "country": "US"},
  "cadence": "Second Sunday of every month except July and August",
  "rule": {"freq": "monthly", "weekday": "sun", "nth": 2, "skip_months": [7, 8], "until": null},
  "hours": {"open": "09:00", "close": "14:00"},
  "known_dates": ["2026-11-08", "2026-12-13"],
  "cancelled_dates": [],
  "last_confirmed": "2026-10-15",
  "sells": {"tcg": ["pokemon"], "sports": ["multi_sport"], "other": []},
  "admission": {"free": true, "currency": "USD"},
  "vendor": {"tables": [{"label": "6 ft table", "price": 40, "currency": "USD"}], "status": "open"},
  "organizer": {"name": "Example Promotions", "url": "https://example.com"},
  "evidence": [{"url": "https://example.com/schedule", "seen": "2026-10-21", "supports": ["cadence", "known_dates", "hours"]}],
  "agent_confidence": "high"
}
```

`rule.freq` is weekly, monthly (with `weekday` mon to sun and `nth` 1 to 4, or -1 for last) or none
(only `known_dates`). `last_confirmed` is the newest date you saw the organizer post about this series
(a post or page date written with its year). If you cannot find any dated sign within the last 4
months, still record the series but say so in `notes`.

## Finish

Reply with three lines only: records written (editions and series), shows that are new to your
brief's lead list, searches used. Everything else is in the file.
