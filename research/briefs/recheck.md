# Brief: recheck shows coming up soon

Read `_common.md` first. Its rules always win.

Your input lists shows happening in the next three weeks. People will drive to these, so we check them
again. No WebSearch unless your prompt gives you a budget.

For each show, fetch its `official` page and confirm the dates, hours and venue are still the same and
the show is not cancelled or postponed. Write an `edition` record for EVERY show you checked (same name,
dates and venue so it merges), with `status` set to what the page says now, and evidence dated today.
If the page changed the date, record the new date and add a `notes` line saying it moved. If the page
no longer mentions the show at all, write the record with `agent_confidence` "low" and a `notes` line
"no longer listed on <url>": the orchestrator decides what to do.
