"""Store events from the scripted sources live in data/store/, which is not committed (csa/store.py).

These tests use the saved real responses of the Play Hub, the Riftbound locator and the Star Wars Unlimited calendar.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from datetime import date, timedelta

import httpx
import pytest

from csa import cli, geocode, harvest, merge, store
from csa.check import ID_RX
from csa.geocode import GeoCache, Services, rung_keys
from csa.paths import Paths
from csa.vocab import Vocab
from conftest import FIXTURES, REPO, read_jsonl_file
from source_helpers import NO_SLEEP, TODAY, Router, file_response, fixture_site, harvest_rows, run, store_rows
from test_sources_playhub import lorcana_site, riftbound_site


def vocab_of(root):
    return Vocab.load(root / "data" / "vocab.json")


def all_store_sites() -> Router:
    """One fake internet holding the three sources that list store events."""
    lorcana, riftbound = lorcana_site(), riftbound_site()

    def answer(request: httpx.Request) -> httpx.Response:
        if request.url.host == "api.cloudflare.ravensburgerplay.com":
            return lorcana.answer(request)
        if request.url.host == "api.cloudflare.riftbound.uvsgames.com":
            return riftbound.answer(request)
        if request.url.host == "starwarsunlimited.com":
            return file_response(FIXTURES / "swu_calendar" / "organized-play-calendar.html")
        return httpx.Response(404)
    return Router(answer)


# ---------------------------------------------------------------- where they are written

def test_store_events_are_written_to_the_store_folder_and_only_tournaments_stay_in_the_harvest_file(sroot):
    res, _ = run(sroot, "lorcana_playhub", lorcana_site())
    assert res.status == "ok" and res.records == 2 and res.store_records == 7
    assert [r["event_type"] for r in harvest_rows(sroot, "lorcana_playhub")] == ["tournament", "tournament"]
    stores = store_rows(sroot, "lorcana_playhub")
    assert len(stores) == 7 and {r["event_type"] for r in stores} == {"store_event"}
    assert "data/store/" in (REPO / ".gitignore").read_text()


def test_store_event_ids_come_from_the_sources_own_event_id_and_need_no_registry(sroot):
    run(sroot, "lorcana_playhub", lorcana_site())
    stores = store_rows(sroot, "lorcana_playhub")
    ids = [r["id"] for r in stores]
    assert len(set(ids)) == 7 and all(ID_RX.match(i) for i in ids)
    weekly = next(r for r in stores if r["name"] == "Wednesday afternoon weekly play")
    assert weekly["id"] == "lorcana-1103727-2026-10-21" and weekly["series_id"] == "lorcana-1103727"
    assert weekly["links"]["official"].endswith("/events/1103727")
    # a complete record in the canonical shape, ready for the site
    assert weekly["verification"] == "listed" and weekly["first_seen"] == "2026-10-21" and weekly["last_checked"] == "2026-10-21"
    assert weekly["estimate"] is None and weekly["mix"] == "tcg" and weekly["sources"][0]["source"] == "lorcana_playhub"
    assert set(weekly["venue"]) >= {"name", "address", "city", "region", "postal", "country", "lat", "lon", "geo_precision"}
    # the same event keeps the same id on another day, with nothing remembered in between
    run(sroot, "lorcana_playhub", lorcana_site(), today=date(2026, 10, 21), refresh=True)
    assert [r["id"] for r in store_rows(sroot, "lorcana_playhub")] == ids


def test_the_merge_neither_reads_nor_remembers_store_events(sroot):
    run(sroot, "lorcana_playhub", lorcana_site())
    paths = Paths(sroot)
    merge.run_merge(paths, vocab_of(sroot), today=TODAY)
    assert read_jsonl_file(paths.store_events) == []
    registry = read_jsonl_file(paths.registry)
    assert registry and not any(e["id"].startswith("lorcana-1") or e.get("series_id", "").startswith("lorcana-1") for e in registry)
    assert len(registry) == 2  # the two tournaments, nothing else
    assert len(read_jsonl_file(paths.shows)) == 2


def test_star_wars_unlimited_store_rounds_get_the_stores_own_number_in_their_id(sroot):
    res, _ = run(sroot, "swu_calendar", fixture_site("swu_calendar"))
    stores = store_rows(sroot, "swu_calendar")
    assert res.records == 4 and res.store_records == len(stores) >= 80
    assert [r["event_type"] for r in harvest_rows(sroot, "swu_calendar")] == ["tournament"] * 4
    # the store's number, or (for the one row with no link) a short fingerprint of its name and town
    assert all(re.fullmatch(r"swu-planetary-(\d+|[0-9a-f]{10})-\d{4}-\d{2}-\d{2}(-\d+)?", r["id"]) for r in stores)
    assert all(ID_RX.match(r["id"]) for r in stores) and len({r["id"] for r in stores}) == len(stores)
    first = stores[0]
    assert first["id"].startswith("swu-planetary-" + first["links"]["official"].rsplit("=", 1)[1])
    assert not any("amp" in (r["links"]["official"] or "") for r in stores)  # the double escaped links were cleaned
    assert sum(1 for r in stores if re.search(r"swu-planetary-[0-9a-f]{10}-", r["id"]) and not re.search(r"swu-planetary-\d{1,9}-", r["id"])) <= 2


def test_store_events_without_coordinates_are_placed_from_the_committed_geocode_cache(sroot):
    run(sroot, "swu_calendar", fixture_site("swu_calendar"))
    first = next(r for r in store_rows(sroot, "swu_calendar") if r["venue"]["region"] == "ON")
    assert first["venue"].get("lat") is None
    cache = GeoCache(Paths(sroot).geocache, TODAY)
    cache.hit(rung_keys(first["venue"])["venue"], 43.55, -79.66, "nominatim")  # the answer an earlier `csa geocode` found, in Ontario
    cache.save()
    run(sroot, "swu_calendar", fixture_site("swu_calendar"), refresh=True)
    placed = next(r for r in store_rows(sroot, "swu_calendar") if r["id"] == first["id"])
    assert (placed["venue"]["lat"], placed["venue"]["lon"], placed["venue"]["geo_precision"]) == (43.55, -79.66, "venue")
    assert placed["timezone"] == "America/Toronto"


def test_csa_geocode_places_store_events_and_rewrites_their_file(sroot, monkeypatch):
    run(sroot, "swu_calendar", fixture_site("swu_calendar"))
    paths = Paths(sroot)
    before = store_rows(sroot, "swu_calendar")
    n = sum(1 for r in before if r["venue"].get("lat") is None)
    assert n > 50

    class Nobody:
        def census_batch(self, items):
            return {}

        def nominatim(self, params):
            return [{"lat": "39.0", "lon": "-95.0", "place_rank": 30}]
    # everyone is "found" at one point in Kansas; the region check keeps the answer only for places in Kansas
    rep = geocode.run_geocode(paths, Services(Nobody().census_batch, Nobody().nominatim), today=TODAY)
    after = store_rows(sroot, "swu_calendar")
    assert rep.nominatim_asked > 0
    ks = [r for r in after if r["venue"]["region"] == "KS"]
    assert ks and all(r["venue"]["lat"] == 39.0 for r in ks)
    assert len(after) == len(before)


# ---------------------------------------------------------------- csa harvest --store

def test_store_harvest_writes_only_the_store_files(sroot):
    site = all_store_sites()
    results = harvest.run_all(Paths(sroot), vocab_of(sroot), today=TODAY, transport=site, store_only=True, http_options=NO_SLEEP)
    assert [(r.source_id, r.status) for r in results] == [("swu_calendar", "ok"), ("lorcana_playhub", "ok"), ("riftbound_locator", "ok")]
    assert not (sroot / "data" / "harvest").exists() or not list((sroot / "data" / "harvest").glob("*.jsonl"))  # nothing committed is touched
    assert sorted(p.name for p in (sroot / "data" / "store").glob("*.jsonl")) == ["lorcana_playhub.jsonl", "riftbound_locator.jsonl", "swu_calendar.jsonl"]
    assert all(r.store_records > 0 for r in results)


def test_the_websites_are_asked_once_a_day_however_many_times_it_runs(sroot):
    paths, vocab = Paths(sroot), vocab_of(sroot)
    first = all_store_sites()
    harvest.run_all(paths, vocab, today=TODAY, transport=first, store_only=True, http_options=NO_SLEEP)
    assert first.requests
    kept = {p.name: p.read_text() for p in (sroot / "data" / "store").glob("*.jsonl")}

    def nobody_answers(request):
        raise AssertionError(f"a website was asked again: {request.url}")
    again = harvest.run_all(paths, vocab, today=TODAY, transport=Router(nobody_answers), store_only=True, http_options=NO_SLEEP)
    assert [r.status for r in again] == ["ok", "ok", "ok"] and all(r.network_requests == 0 for r in again)
    assert all("already harvested today" in r.message for r in again)
    assert {p.name: p.read_text() for p in (sroot / "data" / "store").glob("*.jsonl")} == kept
    # --refresh asks again, and so does the next day
    refreshed = all_store_sites()
    harvest.run_all(paths, vocab, today=TODAY, transport=refreshed, store_only=True, refresh=True, http_options=NO_SLEEP)
    assert refreshed.requests
    tomorrow = all_store_sites()
    harvest.run_all(paths, vocab, today=TODAY + timedelta(days=1), transport=tomorrow, store_only=True, http_options=NO_SLEEP)
    assert tomorrow.requests


def test_a_source_that_lists_no_store_events_is_not_part_of_a_store_harvest(sroot):
    res = harvest.run_source(Paths(sroot), "collectacon", vocab_of(sroot), today=TODAY, store_only=True,
                             transport=Router(lambda r: httpx.Response(500)), http_options=NO_SLEEP)
    assert res.status == "disabled" and "no store events" in res.message
    names = [r.source_id for r in harvest.run_all(Paths(sroot), vocab_of(sroot), today=TODAY, store_only=True, transport=all_store_sites(),
                                                  http_options=NO_SLEEP)]
    assert "collectacon" not in names and "pokemon_championships" not in names


def test_a_failed_store_harvest_keeps_the_last_good_store_file(sroot):
    run(sroot, "lorcana_playhub", lorcana_site())
    good = (sroot / "data/store/lorcana_playhub.jsonl").read_text()
    res = harvest.run_source(Paths(sroot), "lorcana_playhub", vocab_of(sroot), today=TODAY + timedelta(days=1), store_only=True,
                             transport=Router(lambda r: httpx.Response(503, text="down")), http_options=NO_SLEEP)
    assert res.status == "error"
    assert (sroot / "data/store/lorcana_playhub.jsonl").read_text() == good
    assert store.done_today(Paths(sroot), "lorcana_playhub", TODAY + timedelta(days=1)) is None  # so the next try is not skipped


def test_a_run_that_suddenly_finds_almost_no_store_events_is_not_trusted(sroot):
    run(sroot, "swu_calendar", fixture_site("swu_calendar"))
    good = (sroot / "data/store/swu_calendar.jsonl").read_text()
    html = (FIXTURES / "swu_calendar/organized-play-calendar.html").read_text(encoding="utf-8")
    # the store level section is renamed, so the page still reads but yields no store events at all
    renamed = html.replace('<span class="text-left">Planetary Qualifiers</span>', '<span class="text-left">Planetary Rounds</span>')
    assert renamed != html
    res, _ = run(sroot, "swu_calendar", Router(lambda r: httpx.Response(200, text=renamed)), refresh=True)
    assert res.status == "suspicious" and "store events" in res.message
    assert (sroot / "data/store/swu_calendar.jsonl").read_text() == good


# ---------------------------------------------------------------- the command line

def test_harvest_needs_a_source_or_store(sroot, capsys):
    assert cli.main(["--root", str(sroot), "harvest"]) == 2
    assert "give a source id" in capsys.readouterr().err


def test_harvest_store_without_a_source_means_all_store_sources(sroot, monkeypatch, capsys):
    seen = {}

    def fake_run_all(paths, vocab, **kw):
        seen.update(kw)
        return []
    monkeypatch.setattr(harvest, "run_all", fake_run_all)
    assert cli.main(["--root", str(sroot), "harvest", "--store"]) == 0
    assert seen["store_only"] is True


# ---------------------------------------------------------------- git and the workflows

def test_git_ignores_the_store_folder():
    if not shutil.which("git") or not (REPO / ".git").exists():
        pytest.skip("not a git checkout")
    out = subprocess.run(["git", "-C", str(REPO), "check-ignore", "-q", "data/store/lorcana_playhub.jsonl"])
    assert out.returncode == 0


def test_no_store_file_is_committed():
    if not shutil.which("git") or not (REPO / ".git").exists():
        pytest.skip("not a git checkout")
    out = subprocess.run(["git", "-C", str(REPO), "ls-files", "data/store"], capture_output=True, text=True)
    assert out.stdout.strip() == ""
