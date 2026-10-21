"""The daily refresh workflow is on, and it does not geocode more than the cache needs."""

from __future__ import annotations

import yaml

from conftest import REPO

WORKFLOW = yaml.safe_load((REPO / ".github" / "workflows" / "refresh.yml").read_text())


def test_the_daily_schedule_is_switched_on():
    triggers = WORKFLOW.get("on") or WORKFLOW.get(True)  # YAML reads a bare 'on' as true
    assert "workflow_dispatch" in triggers
    assert triggers["schedule"] == [{"cron": "23 10 * * *"}]


def test_geocoding_in_the_daily_run_is_capped_and_uses_the_committed_cache():
    steps = WORKFLOW["jobs"]["refresh"]["steps"]
    geocode = next(s for s in steps if "geocode" in str(s.get("run", "")))
    assert geocode["run"].split() == ["csa", "geocode", "--limit", "300"]
    commit = next(s for s in steps if s.get("id") == "commit")
    assert "git add data" in commit["run"]  # data/geocache.json lives in data/, so every answer and every miss is kept
    order = [s.get("run", "") for s in steps]
    assert order.index("csa harvest all") < order.index("csa merge") < order.index("csa geocode --limit 300")


# ---------------------------------------------------------------- store events are not committed, and the deploy brings them

PAGES = yaml.safe_load((REPO / ".github" / "workflows" / "pages.yml").read_text())


def _steps(workflow, job):
    return workflow["jobs"][job]["steps"]


def test_the_deploy_harvests_store_events_before_the_build_and_never_blocks_on_it():
    steps = _steps(PAGES, "deploy")
    runs = [str(s.get("run", "")) for s in steps]
    harvest_at = next(i for i, r in enumerate(runs) if "csa harvest --store" in r)
    build_at = next(i for i, r in enumerate(runs) if "csa build" in r)
    install_at = next(i for i, r in enumerate(runs) if "pip install -e pipeline" in r)
    assert install_at < harvest_at < build_at
    harvest = steps[harvest_at]
    assert harvest["continue-on-error"] is True and harvest["id"] == "store"
    assert "cache-hit != 'true'" in harvest["if"]  # a hit means today's files are already here
    assert "csa build" in runs[build_at] and "if" in steps[build_at]  # the build does not depend on the harvest step succeeding
    assert "store" not in str(steps[build_at].get("if", ""))


def test_store_events_are_cached_by_utc_date_and_saved_only_after_a_clean_harvest():
    steps = _steps(PAGES, "deploy")
    day = next(s for s in steps if s.get("id") == "today")
    assert "date -u +%Y-%m-%d" in day["run"]
    restore = next(s for s in steps if str(s.get("uses", "")).startswith("actions/cache/restore"))
    save = next(s for s in steps if str(s.get("uses", "")).startswith("actions/cache/save"))
    for step in (restore, save):
        assert step["with"]["path"] == "data/store"
        assert step["with"]["key"] == "store-events-${{ steps.today.outputs.day }}"
    assert save["if"] == "steps.store.outcome == 'success'"  # a failed or skipped harvest saves nothing
    assert steps.index(restore) < steps.index(next(s for s in steps if s.get("id") == "store")) < steps.index(save)


def test_the_daily_refresh_never_commits_store_files():
    steps = _steps(WORKFLOW, "refresh")
    commit = next(s for s in steps if s.get("id") == "commit")["run"]
    assert "git add data\n" in commit and "git rm -r -q --cached --ignore-unmatch data/store" in commit
    assert "git add data/store" not in commit
    save = next(s for s in steps if str(s.get("uses", "")).startswith("actions/cache/save"))
    assert save["with"]["path"] == "data/store" and save["with"]["key"].startswith("store-events-")
    order = [s.get("name", "") for s in steps]
    assert order.index("Geocode (new places only)") < order.index(save["name"]) < order.index("Commit the refreshed data")
