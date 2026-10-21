# Brief: confirm repeating shows

Read `_common.md` first. Its rules always win.

Your input lists repeating shows ("second Sunday of every month") that have no recent dated sign of
life, so the site cannot show their future dates. For each, read the evidence pages and the
organizer's site, and write a `series` record (same name and venue so it merges) with `known_dates`
for every specific upcoming date the organizer posts, `cancelled_dates` if any, and `last_confirmed`
set to the newest date the organizer posted about it (a dated post, a schedule page that names this
season). If you find no dated sign within the last four months, say so in `notes` and leave
`last_confirmed` out.
