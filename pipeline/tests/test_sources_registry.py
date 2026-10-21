"""Checks that hold for every scripted source in data/sources.yaml, and what each does when its website misbehaves."""

from __future__ import annotations

import importlib
import re

import httpx
import pytest

from csa import harvest
from csa.domains import DomainPolicy
from csa.sourcesreg import load_sources
from conftest import REPO
from source_helpers import Router, run

SCRIPTED = ["collectacon", "yugioh_events", "pokemon_championships", "swu_calendar", "mtg_premier", "lorcana_playhub",
            "riftbound_locator", "limitless_results"]
REGISTRY = {s["id"]: s for s in load_sources(REPO / "data" / "sources.yaml")}
DASH = re.compile(r"[–—]| - |--")


@pytest.mark.parametrize("source_id", SCRIPTED)
def test_registry_entry_is_complete_and_the_module_exists(source_id):
    entry = REGISTRY[source_id]
    assert entry["method"] == "script" and entry["enabled"] is True
    for key in ("name", "url", "credit", "terms", "checked", "kind", "priority"):
        assert entry.get(key), f"{source_id} has no {key}"
    assert len(entry["terms"]) > 80 and entry["checked"] == "2026-10-21"
    assert entry["fields"] and set(entry["fields"]) <= harvest.SHOW_FIELDS
    assert "name" in entry["fields"] and "days" in entry["fields"] and "venue" in entry["fields"]
    assert not DomainPolicy.load(REPO / "data" / "never_use_domains.yaml").is_never_use(entry["url"])
    module = importlib.import_module(f"csa.sources.{source_id}")
    assert callable(module.harvest)
    for key in ("name", "credit", "terms"):  # plain words: no dashes used as a pause
        assert not DASH.search(entry[key]), f"{source_id}.{key}: {entry[key]!r}"


def test_priorities_are_distinct_and_the_organizers_come_first():
    priorities = [REGISTRY[s]["priority"] for s in SCRIPTED]
    assert len(set(priorities)) == len(priorities)
    promoters = [REGISTRY[s]["priority"] for s in SCRIPTED if REGISTRY[s]["kind"] == "promoter"]
    assert max(promoters) < min(REGISTRY[s]["priority"] for s in SCRIPTED if REGISTRY[s]["kind"] != "promoter")
    assert REGISTRY["limitless_results"]["priority"] == max(priorities)  # it only adds counts, so it never outranks a listing


def test_the_platform_sources_ask_slowly():
    for source_id in ("lorcana_playhub", "riftbound_locator"):
        assert REGISTRY[source_id]["min_interval"] >= 1.0


def test_credit_for_the_play_hub_is_by_name():
    assert REGISTRY["lorcana_playhub"]["credit"] == "Listed by Ravensburger Play Hub"


@pytest.mark.parametrize("source_id", SCRIPTED)
def test_a_site_that_is_down_never_replaces_good_data(source_id, sroot):
    good = [{"name": f"Old {i}", "days": [{"date": "2026-11-01"}], "venue": {"city": "A", "region": "NJ"}} for i in range(8)]
    out = sroot / "data" / "harvest" / f"{source_id}.jsonl"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("".join(__import__("json").dumps(r) + "\n" for r in good))
    before = out.read_text()
    res, _ = run(sroot, source_id, Router(lambda r: httpx.Response(503, text="down")))
    assert res.status == "error" and not res.ok
    assert out.read_text() == before


@pytest.mark.parametrize("source_id", SCRIPTED)
def test_a_bot_check_is_a_hard_stop(source_id, sroot):
    page = "<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>"
    site = Router(lambda r: httpx.Response(403, text=page, headers={"cf-mitigated": "challenge"}))
    res, rows = run(sroot, source_id, site)
    assert res.status == "blocked" and "bot challenge" in res.message and not rows
    assert len([r for r in site.requests if r.url.path != "/robots.txt"]) <= 1  # it stopped at once and tried nothing else


@pytest.mark.parametrize("source_id", SCRIPTED)
def test_a_page_that_looks_like_nothing_we_know_is_an_error_not_an_empty_file(source_id, sroot):
    def answer(request):
        if "json" in request.url.path or request.url.path.endswith("/events/") or "wp-json" in request.url.path:
            return httpx.Response(200, json={"unexpected": True})
        return httpx.Response(200, text="<html><body><p>Hello</p></body></html>")
    res, rows = run(sroot, source_id, Router(answer))
    assert res.status == "error", (source_id, res.status, res.message)
    assert not (sroot / "data" / "harvest" / f"{source_id}.jsonl").exists()


@pytest.mark.parametrize("source_id", SCRIPTED)
def test_robots_txt_that_forbids_everything_is_respected(source_id, sroot):
    site = Router(lambda r: httpx.Response(200, text="<html></html>"))
    site.robots = lambda r: httpx.Response(200, text="User-agent: *\nDisallow: /\n")
    res, rows = run(sroot, source_id, site)
    assert res.status == "error" and "robots.txt" in res.message and not rows
    assert [r.url.path for r in site.requests if r.url.path != "/robots.txt"] == []


def test_the_test_suite_cannot_reach_a_real_website():
    """conftest.py refuses real connections, so 'harvest all' in a test can never visit the registered sites."""
    from csa.http import HttpClient
    with HttpClient("probe", None, respect_robots=False) as client:
        with pytest.raises(RuntimeError, match="a test tried to reach"):
            client.get("https://example.org/")
