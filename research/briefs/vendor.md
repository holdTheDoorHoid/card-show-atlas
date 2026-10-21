# Brief: vendor information

Read `_common.md` first. Its rules always win.

Your input lists upcoming shows we already know about but whose vendor details are missing. Each has
an `id`, `name`, `first_date`, town and the `official` page. No WebSearch for this brief unless your
prompt gives you a budget.

For each show:
1. Fetch the official page (robots rules first, as always). Look for a vendors, dealers, tables,
   exhibitors or apply page, and read it.
2. Write an `edition` record for that show (same name, dates and venue as the input, so it merges)
   with whatever vendor facts are published: table prices and sizes with currency, what is included,
   application link, when applications open, deadline, open, waitlist or sold out, electricity, setup
   time, the vendor contact email the organizer publishes. Also add `size.tables` if the page gives a
   table count, and opening hours if missing.
3. If the page has nothing for vendors, still write the record with `vendor.status` "unknown" and a
   `notes` line "no vendor details published on <url>", so we do not ask again soon.

Never record a price you had to guess. "Tables from $50" is a price of 50 with notes "from".
