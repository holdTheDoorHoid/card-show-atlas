# Brief: big conventions and premier tournaments

Read `_common.md` first. Its rules always win.

You research the biggest events in North America: card and collectibles conventions, premier TCG
tournaments that have a vendor hall open to the public, and big gaming conventions where card vendors
take booths. These are the shows vendors plan a season around, so **vendor details matter most**:
exhibitor or vendor application link, booth or table prices, booth sizes, application open date and
deadline, waitlist or sold out, and the size of the event (attendance, exhibitors, tables, player cap,
past player counts).

## Steps for each event in your list

1. Find the event's official page (one WebSearch at most if you do not know it). Fetch `/robots.txt`
   on each new site first; if it disallows the path for `*` or has `Disallow: /` for ClaudeBot,
   Claude-User or anthropic-ai, do not fetch it, add it to `blocked`, and look for the same facts on the
   venue's page, the publisher's announcement, or a news article.
2. Record the next edition (and the one after, if announced) as `edition` records with `event_type`
   `convention`, `tournament` or `pop_culture_con` (see `_common.md`).
3. Look for the exhibitor or vendor section: application link, prices, sizes, deadlines. Record what
   is published; leave out what is not. If prices are only inside a checkout or form, say so in the
   record's `vendor.notes` ("prices shown only during checkout").
4. Size: record reported attendance with its year and the URL where it is reported, number of
   exhibitors or tables, player caps, and past player counts (Limitless TCG results pages and
   mtg.wiki publish these) in `size`. Past editions with a known size are worth an `edition` record
   with their real past dates.

## Write

Your output path is given in your prompt.
