# The research runner

How one research run works: the nightly scheduled task, or the orchestrator by hand. Owner decisions
behind this (2026-10-21): research on Haiku; a launch push of up to about 35% of a week's allowance in
the first week (Oct 21 to 28), then small nightly top ups of about 3%; research goes live once it
passes the checks; a short plain summary after every run.

The orchestrator's own work is light: pick, launch, import, check, publish, log. All research is done
by Haiku agents. Never use Opus or Fable agents for research.

## 0. Preconditions (stop quietly if any fails)

* `cd ~/Desktop/card-show-atlas`. The working tree must be clean apart from `research/inbox/` and on
  `main`. Run `git pull --ff-only origin main` (the daily refresh Action commits data). If either
  fails, stop and report; never stash, reset or force.
* Never touch other projects, other worktrees, or lab hardware.

## 1. Budget gate

Load the usage tool (`ToolSearch` with `select:mcp__ccd_session_mgmt__get_usage`) and call it. Take
the weekly percent (Weekly, all models), the 5 hour percent, and the weekly reset time.

Read `research/budget.yaml` and `research/waves/usage.jsonl`. This week's Card Show Atlas spend is the
sum of `after - before` over log lines inside the current week (the 7 days before the reset). The cap
is `launch.cap_weekly_percent` while today is inside `launch.window`, otherwise
`nightly.cap_percent_per_run` for this run.

Skip the run (append `{"wave": "skipped", "time": ..., "reason": ...}` to the log, commit and push the
log, finish with one line) when any of these hold:
* the account's weekly usage is above `nightly.skip_if_weekly_above`;
* the 5 hour usage is above `nightly.skip_if_five_hour_above`;
* this run or this week has reached its cap.

Check the gate again before every wave, not only at the start.

## 2. Pick the work

In this order, take the first that has work (`python3 research/tools/make_batches.py <mode> <wave>`
prints "nothing left" when a mode is empty). Name waves `n<YYYYMMDD>-<mode>`.

1. `recheck` (shows in the next 21 days; one recheck per show per week). Brief `recheck`. 0 searches.
2. `vendor` (upcoming shows with no vendor details). Brief `vendor`. 0 searches.
3. `series` (repeating shows with no recent dated sign). Brief `series`. 2 searches per agent.
4. `leads` (shows seen but not confirmed). Brief `leads`. 6 searches per agent.
5. When all of those are empty, write a new region or source sweep wave into `research/queue.yaml`
   (brief `regions`, a slice of states with the fewest upcoming shows per person, from `csa stats`)
   and run that. 6 searches per agent.

WebSearch is limited to about 200 calls per session for everything together. Before launching, check
that agents times searches fits in what this session has left.

## 3. Launch Haiku agents

Up to eight at once, in the background, one per batch file. Use `subagent_type: "csa-researcher"`
(defined in `.claude/agents/csa-researcher.md`: Haiku, research tools only). If that type is not
listed, use `subagent_type: "general-purpose"` with `model: "haiku"`. Prompt, filled in:

> You are a Card Show Atlas research agent. Read `~/Desktop/card-show-atlas/research/briefs/_common.md`,
> then `~/Desktop/card-show-atlas/research/briefs/<brief>.md`.
> Wave: `<wave>`. Agent: `<agent>`. WebSearch budget: `<n>` calls, hard cap. WebFetch: up to 60.
> Your input: `~/Desktop/card-show-atlas/research/batches/<wave>/<agent>.json`.
> Write your output to `~/Desktop/card-show-atlas/research/inbox/<wave>/<agent>.json`.
> Today's date is `<YYYY-MM-DD>`.
> Only use the tools Read, Write, Bash, WebFetch and WebSearch. Never use any other tool (no browser,
> preview, widget, task or spawn_task tools).

Wait for all of them. An agent that returns without writing its file gets one retry. Dismiss any task
chip an agent creates by mistake (`dismiss_task`).

## 4. Import, check, publish

```
C=pipeline/.venv/bin/csa
$C import-research <wave>
$C merge && $C geocode && $C estimate && $C check
pipeline/.venv/bin/pytest -q pipeline/tests
$C build
(cd site && npm ci --silent && npm test --silent && npm run build --silent)
```

**Spot check.** Pick three changed or new upcoming shows at random. WebFetch each one's evidence URL
and confirm the show exists with those dates and that nothing was copied. If two or more of the three
are wrong, the wave fails: revert data changes (`git checkout -- data`), move the inbox files to
`research/held/<wave>/`, note it in the queue, and report.

If everything passes, commit `data/` and `research/` with a plain message (no dashes as punctuation,
ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`) and `git push origin main`. The
Pages workflow deploys the site.

If tests or the site build fail for a reason that is not this wave's data, do not fix code in a
scheduled run: commit the research inbox and log only, and report the failure.

## 5. Log

* Call the usage tool again. Append to `research/waves/usage.jsonl`:
  `{"wave": "<wave>", "time": "<ISO>", "before": <weekly % before>, "after": <weekly % now>, "agents": n, "records": n}`.
* Write `research/waves/<YYYY-MM-DD>-<wave>.md`: agents, searches used, records in, rejected (top
  reasons), blocked sources, the spot check result, anything surprising. No dashes as punctuation.

## 6. Next wave or finish

If the gate still passes, go back to step 2. Otherwise finish with a short summary for the owner in
plain language (they are not a programmer): how many shows were added or updated tonight, the total
upcoming now, anything held back and why, and this week's spend against the cap. Lead with what a
visitor will notice.
