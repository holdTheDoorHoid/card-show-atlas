# Brief: promoter chains

Read `_common.md` first. Its rules always win.

You get a short list of show promoters (from `research/leads/promoters.yaml`). For each one, find
every upcoming show they run from now through the end of 2027, plus past shows from 2025 and 2026 that
state a size (tables or attendance).

## Steps for each promoter

1. If the lead has a `url`, start there. If it has none, use ONE WebSearch to find the promoter's own
   site (not Facebook, not a listing site). If the only presence is Facebook or Instagram, put it in
   `leads_only` with that note and move on.
2. Before fetching pages on a new site, fetch its `/robots.txt`. If it disallows the path you need for
   `User-agent: *`, or has `Disallow: /` for ClaudeBot, Claude-User or anthropic-ai, do not fetch it:
   add it to `blocked` with note "robots" and move on.
3. Read the schedule or events page, every per show page it links, and the vendor or dealer page
   (look for "vendors", "dealers", "tables", "exhibit", "apply"). Record per show: dates and hours,
   venue and full address, admission, table count, what is sold, vendor table prices and sizes,
   application link, deadline, sold out or waitlist.
4. Recurring shows ("every second Sunday") are `series` records. Shows with specific dates are
   `edition` records. A promoter that lists specific dates for a repeating show gets ONE series record
   with all those dates in `known_dates` (do not also write an edition per date).
5. Other promoters or shows you see linked or named go in `leads_only` with their URL.

## Good evidence

The promoter's schedule page, the show's own page, its vendor page, its ticket page on a ticketing
site (allowed as evidence for dates and prices, but record only facts), the venue's own event page,
a news article.

## Write

Your output path is given in your prompt. Aim for every upcoming show of every promoter you were given.
