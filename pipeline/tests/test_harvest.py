from __future__ import annotations

import json
import shutil
from datetime import date
from pathlib import Path

import pytest

from csa import harvest
from csa.http import FixtureTransport
from csa.paths import Paths
from csa.vocab import Vocab
from conftest import FIXTURES, Site, read_jsonl_file

TODAY = date(2026, 10, 21)
NO_SLEEP = {"sleep": lambda s: None}


@pytest.fixture
def vocab(root):
    return Vocab.load(root / "data" / "vocab.json")


@pytest.fixture
def hroot(root):
    shutil.copy(Path(__file__).resolve().parents[2] / "data" / "sources.yaml", root / "data" / "sources.yaml")
    return root


def fixture_transport():
    return FixtureTransport(FIXTURES / "example_calendar")


def test_example_source_end_to_end(hroot, vocab):
    paths = Paths(hroot)
    res = harvest.run_source(paths, "example_calendar", vocab, today=TODAY, transport=fixture_transport(),
                             force_disabled=True, http_options=NO_SLEEP)
    assert res.status == "ok" and res.records == 3 and res.skipped == 0
    rows = read_jsonl_file(hroot / "data/harvest/example_calendar.jsonl")
    assert [r["name"] for r in rows] == ["Garden State Card Show", "Lakeside Sports Card Show", "Maple Leaf Card Expo"]
    gs = rows[0]
    assert gs["venue"] == {"name": "Example Expo Hall", "address": "97 Sunfield Ave", "city": "Edison", "region": "NJ",
                           "postal": "08837", "country": "US"}
    assert [d["date"] for d in gs["days"]] == ["2026-11-14", "2026-11-15"]
    assert gs["admission"] == {"free": False, "adult": 5, "currency": "USD"}
    assert gs["sources"] == [{"source": "example_calendar", "url": "https://calendar.example.org/shows/123",
                              "retrieved": "2026-10-21", "fields": ["name", "days", "venue", "admission", "organizer"]}]
    assert gs["verification"] == "listed" and gs["last_checked"] == "2026-10-21"
    assert rows[1]["status"] == "cancelled"
    assert rows[2]["venue"]["region"] == "ON" and rows[2]["admission"]["free"] is True
    assert "description" not in json.dumps(rows) and "write up" not in json.dumps(rows)  # never copied
    status = json.loads((hroot / "data/harvest/_status.json").read_text())
    assert status["example_calendar"]["status"] == "ok"
    assert (hroot / "data/raw/example_calendar").is_dir() and list((hroot / "data/raw/example_calendar").glob("*.body"))


def test_disabled_sources_are_skipped_unless_forced(hroot, vocab):
    res = harvest.run_source(Paths(hroot), "example_calendar", vocab, today=TODAY, transport=fixture_transport(), http_options=NO_SLEEP)
    assert res.status == "disabled"
    assert not (hroot / "data/harvest/example_calendar.jsonl").exists()
    all_res = harvest.run_all(Paths(hroot), vocab, today=TODAY, transport=fixture_transport(), http_options=NO_SLEEP)
    assert [r.status for r in all_res] == ["disabled"]


def test_unknown_and_non_script_sources_are_clear_errors(hroot, vocab):
    with pytest.raises(KeyError, match="not_there"):
        harvest.run_source(Paths(hroot), "not_there", vocab)
    with pytest.raises(ValueError, match="only script"):
        harvest.run_source(Paths(hroot), "research", vocab)


def test_registry_fields_limit_what_a_source_may_supply(hroot, vocab, tmp_path):
    text = (hroot / "data/sources.yaml").read_text().replace("fields: [name, days, venue, admission, organizer, status]", "fields: [name, days, venue]")
    (hroot / "data/sources.yaml").write_text(text)
    harvest.run_source(Paths(hroot), "example_calendar", vocab, today=TODAY, transport=fixture_transport(), force_disabled=True, http_options=NO_SLEEP)
    gs = read_jsonl_file(hroot / "data/harvest/example_calendar.jsonl")[0]
    assert "admission" not in gs and "organizer" not in gs
    assert gs["sources"][0]["fields"] == ["name", "days", "venue"]


def test_robots_disallowed_pages_are_not_fetched(hroot, vocab, tmp_path):
    folder = tmp_path / "site"
    shutil.copytree(FIXTURES / "example_calendar", folder)
    (folder / "robots.txt").write_text("User-agent: *\nDisallow: /shows/\n")
    res = harvest.run_source(Paths(hroot), "example_calendar", vocab, today=TODAY, transport=FixtureTransport(folder),
                             force_disabled=True, http_options=NO_SLEEP)
    assert res.status == "error" and "robots.txt" in res.message
    assert any("disallowed" in r for r in res.refused)


def test_bot_challenge_is_a_hard_stop_that_keeps_the_old_file(hroot, vocab):
    paths = Paths(hroot)
    harvest.run_source(paths, "example_calendar", vocab, today=TODAY, transport=fixture_transport(), force_disabled=True, http_options=NO_SLEEP)
    before = (hroot / "data/harvest/example_calendar.jsonl").read_text()
    cf = "<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>"
    site = Site({"/shows/": (403, cf, {"cf-mitigated": "challenge"})})
    res = harvest.run_source(paths, "example_calendar", vocab, today=TODAY, transport=site.transport(), force_disabled=True,
                             refresh=True, http_options=NO_SLEEP)
    assert res.status == "blocked" and "bot challenge" in res.message and not res.ok
    assert (hroot / "data/harvest/example_calendar.jsonl").read_text() == before
    assert site.log.count("/shows/") == 1
    status = json.loads((hroot / "data/harvest/_status.json").read_text())
    assert status["example_calendar"]["status"] == "blocked"


def test_a_crashing_source_does_not_wipe_the_last_good_file(hroot, vocab, monkeypatch):
    paths = Paths(hroot)
    harvest.run_source(paths, "example_calendar", vocab, today=TODAY, transport=fixture_transport(), force_disabled=True, http_options=NO_SLEEP)
    before = (hroot / "data/harvest/example_calendar.jsonl").read_text()

    class Boom:
        @staticmethod
        def harvest(ctx):
            yield {"name": "X", "days": ["2026-11-01"], "venue": {"city": "A", "region": "NJ"}}
            raise RuntimeError("layout changed")
    monkeypatch.setattr(harvest, "load_module", lambda entry: Boom)
    res = harvest.run_source(paths, "example_calendar", vocab, today=TODAY, force_disabled=True, http_options=NO_SLEEP)
    assert res.status == "error" and "layout changed" in res.message
    assert (hroot / "data/harvest/example_calendar.jsonl").read_text() == before


def test_a_run_that_suddenly_finds_almost_nothing_is_not_trusted(hroot, vocab, monkeypatch):
    paths = Paths(hroot)
    big = "".join(json.dumps({"name": f"S{i}", "days": [{"date": "2026-11-01"}]}) + "\n" for i in range(10))
    (hroot / "data/harvest").mkdir(parents=True)
    (hroot / "data/harvest/example_calendar.jsonl").write_text(big)

    class Empty:
        @staticmethod
        def harvest(ctx):
            return iter(())
    monkeypatch.setattr(harvest, "load_module", lambda entry: Empty)
    res = harvest.run_source(paths, "example_calendar", vocab, today=TODAY, force_disabled=True, http_options=NO_SLEEP)
    assert res.status == "suspicious"
    assert (hroot / "data/harvest/example_calendar.jsonl").read_text() == big


def test_records_without_what_the_pipeline_needs_are_skipped_with_reasons(hroot, vocab, monkeypatch):
    class Messy:
        @staticmethod
        def harvest(ctx):
            yield {"name": "Good", "days": ["2026-11-01"], "venue": {"city": "A", "region": "NJ"}, "summary": "copied prose", "id": "mine", "verification": "organizer_confirmed"}
            yield {"days": ["2026-11-01"], "venue": {"city": "A", "region": "NJ"}}
            yield {"name": "No date", "venue": {"city": "A", "region": "NJ"}}
            yield {"name": "No place", "days": ["2026-11-01"], "venue": {"city": "A"}}
            yield "not a dict"
    monkeypatch.setattr(harvest, "load_module", lambda entry: Messy)
    res = harvest.run_source(Paths(hroot), "example_calendar", vocab, today=TODAY, force_disabled=True, http_options=NO_SLEEP)
    assert res.records == 1 and res.skipped == 4 and len(res.skip_reasons) == 4
    row = read_jsonl_file(hroot / "data/harvest/example_calendar.jsonl")[0]
    assert "summary" not in row and "id" not in row
    assert row["verification"] == "listed"  # a source cannot promote itself


def test_promoter_sources_are_marked_organizer_confirmed(hroot, vocab, monkeypatch):
    text = (hroot / "data/sources.yaml").read_text().replace("kind: aggregator", "kind: promoter")
    (hroot / "data/sources.yaml").write_text(text)

    class One:
        @staticmethod
        def harvest(ctx):
            yield {"name": "Good", "days": ["2026-11-01"], "venue": {"city": "A", "region": "NJ"}}
    monkeypatch.setattr(harvest, "load_module", lambda entry: One)
    harvest.run_source(Paths(hroot), "example_calendar", vocab, today=TODAY, force_disabled=True, http_options=NO_SLEEP)
    assert read_jsonl_file(hroot / "data/harvest/example_calendar.jsonl")[0]["verification"] == "organizer_confirmed"


def test_second_run_reads_the_cache(hroot, vocab):
    paths = Paths(hroot)
    t1 = fixture_transport()
    harvest.run_source(paths, "example_calendar", vocab, today=TODAY, transport=t1, force_disabled=True, http_options=NO_SLEEP)
    t2 = fixture_transport()
    res = harvest.run_source(paths, "example_calendar", vocab, today=TODAY, transport=t2, force_disabled=True)
    assert res.cache_hits >= 2
    assert not any(u.endswith("/shows/") for u in t2.requests)


def test_scaffold_makes_a_module_and_a_registry_snippet(hroot, monkeypatch, tmp_path):
    monkeypatch.setattr(harvest, "__file__", str(tmp_path / "csa" / "harvest.py"))
    (tmp_path / "csa" / "sources").mkdir(parents=True)
    module, snippet = harvest.scaffold_source(Paths(hroot), "my_source", "My Source", "https://mine.example/shows", TODAY)
    assert module.name == "my_source.py" and "def harvest(ctx)" in module.read_text()
    assert "id: my_source" in snippet and "enabled: false" in snippet
    with pytest.raises(FileExistsError):
        harvest.scaffold_source(Paths(hroot), "my_source", "My Source", "https://mine.example/shows", TODAY)
    with pytest.raises(ValueError):
        harvest.scaffold_source(Paths(hroot), "Bad-Id", "x", "https://x.example", TODAY)
