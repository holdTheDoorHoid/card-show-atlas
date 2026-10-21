from __future__ import annotations

import json
import shutil
from datetime import date

import pytest

from csa import research
from csa.paths import Paths
from csa.vocab import Vocab
from conftest import FIXTURES, read_jsonl_file

TODAY = date(2026, 10, 21)


@pytest.fixture
def vocab(root):
    return Vocab.load(root / "data" / "vocab.json")


@pytest.fixture
def wave(root):
    shutil.copytree(FIXTURES / "research" / "w1", root / "research" / "inbox" / "w1")
    return root / "research" / "inbox" / "w1"


def edition(**over) -> dict:
    rec = {"kind": "edition", "name": "Example Fall Card Show", "event_type": "card_show",
           "days": [{"date": "2026-11-14", "open": "09:00", "close": "15:00"}],
           "venue": {"city": "Media", "region": "PA"},
           "organizer": {"name": "Example Promotions", "url": "https://example.com"},
           "evidence": [{"url": "https://example.com/fall-show", "seen": "2026-10-21", "supports": ["days", "venue"]}],
           "agent_confidence": "high"}
    rec.update(over)
    return rec


def put(wave_dir, name, data):
    (wave_dir / name).write_text(json.dumps(data))


def test_import_accepts_repairs_and_rejects_with_reasons(root, vocab, wave):
    rep = research.import_wave(Paths(root), "w1", vocab, TODAY)
    assert (rep.accepted, rep.editions, rep.series, rep.rejected) == (2, 1, 1, 2)
    assert rep.searches_used == 4 and rep.fetches_used == 31 and rep.leads == 1 and rep.blocked == 1
    rows = read_jsonl_file(root / "data/research/w1.jsonl")
    ed = next(r for r in rows if r["kind"] == "edition")
    assert ed["venue"]["region"] == "PA" and ed["venue"]["country"] == "US"
    assert ed["sells"] == {"tcg": ["pokemon", "one_piece"], "sports": ["multi_sport"], "other": []}
    assert ed["days"] == [{"date": "2026-11-14", "open": "09:00", "close": "15:00"}]
    assert ed["size"]["tables"] == 60 and ed["admission"]["adult"] == 5 and ed["admission"]["currency"] == "USD"
    assert ed["vendor"]["contact"] == "vendors@example.com"  # the phone number is gone
    assert "610" not in json.dumps(ed)
    assert ed["agent_confidence"] == "high" and ed["verification"] == "organizer_confirmed"
    assert ed["sources"] == [{"source": "research", "url": "https://example.com/fall-show", "retrieved": "2026-10-21",
                              "fields": ["name", "days", "venue", "vendor.tables"]}]
    assert ed["research_id"] == "w1/a01/0" and ed["wave"] == "w1" and ed["repairs"]
    rej = read_jsonl_file(wave / "_rejected.jsonl")
    assert len(rej) == 2
    assert "no usable evidence" in rej[0]["reasons"][0] and rej[0]["name"] == "Facebook only show"
    assert "past show" in rej[1]["reasons"][0]
    leads = read_jsonl_file(root / "data/research/leads/w1.jsonl")
    assert [r["type"] for r in leads] == ["lead", "blocked"]


def test_series_records_are_filed_with_their_rule(root, vocab, wave):
    research.import_wave(Paths(root), "w1", vocab, TODAY)
    s = next(r for r in read_jsonl_file(root / "data/research/w1.jsonl") if r["kind"] == "series")
    assert s["rule"] == {"freq": "monthly", "weekday": "sun", "nth": 2, "skip_months": [7, 8], "until": None}
    assert s["known_dates"] == ["2026-11-08", "2026-12-13"] and s["last_confirmed"] == "2026-10-15"
    assert s["hours"] == {"open": "09:00", "close": "14:00"}


def test_import_is_repeatable_and_replaces_only_that_agents_records(root, vocab, wave):
    first = research.import_wave(Paths(root), "w1", vocab, TODAY)
    again = research.import_wave(Paths(root), "w1", vocab, TODAY)
    assert (first.accepted, again.accepted) == (2, 2)
    assert len(read_jsonl_file(root / "data/research/w1.jsonl")) == 2
    put(wave, "a02.json", {"agent": "a02", "records": [edition(name="Second Agent Show")]})
    research.import_wave(Paths(root), "w1", vocab, TODAY)
    assert len(read_jsonl_file(root / "data/research/w1.jsonl")) == 3
    # agent a02 rewrites its file with a different show: a01's records stay, a02's are replaced
    put(wave, "a02.json", {"agent": "a02", "records": [edition(name="Replacement Show")]})
    research.import_wave(Paths(root), "w1", vocab, TODAY)
    names = sorted(r["name"] for r in read_jsonl_file(root / "data/research/w1.jsonl"))
    assert names == ["Example Fall Card Show", "Example Monthly Card Show", "Replacement Show"]


def test_a_bare_single_record_and_a_bare_list_are_accepted(root, vocab, wave):
    for f in wave.glob("*.json"):
        f.unlink()
    put(wave, "single.json", edition(name="Bare Single"))
    put(wave, "list.json", [edition(name="Bare List One"), edition(name="Bare List Two", days=[{"date": "2026-11-15"}])])
    rep = research.import_wave(Paths(root), "w1", vocab, TODAY)
    assert rep.accepted == 3
    assert sorted(r["name"] for r in read_jsonl_file(root / "data/research/w1.jsonl")) == ["Bare List One", "Bare List Two", "Bare Single"]


def test_a_record_with_a_rule_but_no_kind_is_treated_as_a_series(root, vocab, wave):
    for f in wave.glob("*.json"):
        f.unlink()
    rec = edition()
    rec.pop("kind")
    rec.pop("days")
    rec.update(rule={"freq": "monthly", "weekday": "sat", "nth": 1}, last_confirmed="2026-10-01")
    put(wave, "x.json", rec)
    research.import_wave(Paths(root), "w1", vocab, TODAY)
    assert read_jsonl_file(root / "data/research/w1.jsonl")[0]["kind"] == "series"


@pytest.mark.parametrize("change, expect", [
    ({"name": ""}, "name is missing"),
    ({"days": []}, "days is empty"),
    ({"days": [{"date": "1999-01-01"}]}, "believable"),
    ({"days": [{"date": "2026-11-01"}, {"date": "2026-12-20"}]}, "more than 14 days"),
    ({"venue": {"city": "Media"}}, "venue.region is missing"),
    ({"venue": {"city": "London", "region": "ENG"}}, "not a US state"),
    ({"venue": {"city": "Paris", "region": "PA", "country": "France"}}, "France"),
    ({"event_type": "garage sale"}, "event_type"),
    ({"evidence": []}, "no usable evidence"),
    ({"evidence": [{"url": "https://www.instagram.com/p/1", "seen": "2026-10-21"}]}, "no usable evidence"),
    ({"evidence": [{"url": "not a url"}]}, "no usable evidence"),
    ({"kind": "festival"}, "kind"),
])
def test_rejections_say_why(root, vocab, wave, change, expect):
    for f in wave.glob("*.json"):
        f.unlink()
    put(wave, "x.json", {"agent": "x", "records": [edition(**change)]})
    rep = research.import_wave(Paths(root), "w1", vocab, TODAY)
    assert rep.accepted == 0 and rep.rejected == 1
    reasons = read_jsonl_file(wave / "_rejected.jsonl")[0]["reasons"]
    assert any(expect in r for r in reasons), reasons


def test_bad_json_is_rejected_as_a_file(root, vocab, wave):
    for f in wave.glob("*.json"):
        f.unlink()
    (wave / "broken.json").write_text("{not json")
    rep = research.import_wave(Paths(root), "w1", vocab, TODAY)
    assert rep.rejected == 1
    assert "not valid JSON" in read_jsonl_file(wave / "_rejected.jsonl")[0]["reasons"][0]


def test_repairs_dates_regions_and_vocabulary(root, vocab, wave):
    for f in wave.glob("*.json"):
        f.unlink()
    rec = edition(days=["11/14/2026", "Nov 15, 2026"], venue={"city": "Toronto", "region": "Ontario", "country": "Canada"},
                  sells=["Pokemon TCG", "MTG", "Yu-Gi-Oh!", "baseball", "comic books"], status="Canceled",
                  vendor={"deadline": "Oct 31, 2026", "status": "applications open", "tables": [{"label": "8 ft", "price": "$75"}]},
                  summary="Our own sentence.")
    put(wave, "x.json", {"agent": "x", "records": [rec]})
    research.import_wave(Paths(root), "w1", vocab, TODAY)
    r = read_jsonl_file(root / "data/research/w1.jsonl")[0]
    assert [d["date"] for d in r["days"]] == ["2026-11-14", "2026-11-15"]
    assert r["venue"]["region"] == "ON" and r["venue"]["country"] == "CA"
    assert r["sells"]["tcg"] == ["pokemon", "mtg", "yugioh"] and r["sells"]["sports"] == ["baseball"] and r["sells"]["other"] == ["comics"]
    assert r["status"] == "cancelled" and r["vendor"]["status"] == "open"
    assert r["vendor"]["tables"][0]["currency"] == "CAD"  # taken from the venue's country, and reported
    assert any("assumed CAD" in n for n in r["repairs"])


def test_wrong_claims_and_oversized_text_are_fixed_not_trusted(root, vocab, wave):
    for f in wave.glob("*.json"):
        f.unlink()
    rec = edition(verification="organizer_confirmed", links={"official": "https://elsewhere.example/x"},
                  organizer={"name": "P", "url": "https://elsewhere.example"},
                  summary="x" * 400, vendor={"deadline": "2026-12-01", "contact": "call 215-555-0100"},
                  estimate={"attendance": {"low": 1, "mid": 2, "high": 3}})
    put(wave, "x.json", {"agent": "x", "records": [rec]})
    research.import_wave(Paths(root), "w1", vocab, TODAY)
    r = read_jsonl_file(root / "data/research/w1.jsonl")[0]
    assert r["verification"] == "listed"  # no evidence link is on elsewhere.example
    assert r["summary"] is None
    assert r["vendor"]["deadline"] is None  # after the show on 2026-11-14
    assert r["vendor"].get("contact") is None
    assert "estimate" not in r


def test_coordinates_outside_the_region_are_dropped(root, vocab, wave):
    for f in wave.glob("*.json"):
        f.unlink()
    rec = edition(venue={"city": "Media", "region": "PA", "lat": 25.0, "lon": -80.0, "geo_precision": "address"})
    put(wave, "x.json", {"agent": "x", "records": [rec]})
    research.import_wave(Paths(root), "w1", vocab, TODAY)
    v = read_jsonl_file(root / "data/research/w1.jsonl")[0]["venue"]
    assert v.get("lat") is None


@pytest.mark.parametrize("rule, expect", [
    ({"freq": "monthly", "weekday": "sun"}, "rule.nth"),
    ({"freq": "weekly"}, "rule.weekday"),
    ({"freq": "none"}, "known_dates"),
])
def test_series_with_an_unusable_rule_are_rejected(root, vocab, wave, rule, expect):
    for f in wave.glob("*.json"):
        f.unlink()
    rec = edition(kind="series", rule=rule, last_confirmed="2026-10-01")
    rec.pop("days")
    put(wave, "x.json", {"agent": "x", "records": [rec]})
    rep = research.import_wave(Paths(root), "w1", vocab, TODAY)
    assert rep.rejected == 1
    assert expect in " ".join(read_jsonl_file(wave / "_rejected.jsonl")[0]["reasons"])


def test_series_without_last_confirmed_is_kept_but_will_make_no_guesses(root, vocab, wave):
    for f in wave.glob("*.json"):
        f.unlink()
    rec = edition(kind="series", rule={"freq": "monthly", "weekday": "sun", "nth": 2}, known_dates=["2026-11-08"])
    rec.pop("days")
    put(wave, "x.json", {"agent": "x", "records": [rec]})
    rep = research.import_wave(Paths(root), "w1", vocab, TODAY)
    assert rep.series == 1
    assert any("last_confirmed" in n for n in read_jsonl_file(root / "data/research/w1.jsonl")[0]["repairs"])


def test_missing_inbox_is_a_clear_error(root, vocab):
    with pytest.raises(FileNotFoundError):
        research.import_wave(Paths(root), "nope", vocab, TODAY)


def test_rejected_file_goes_away_when_nothing_is_rejected(root, vocab, wave):
    research.import_wave(Paths(root), "w1", vocab, TODAY)
    assert (wave / "_rejected.jsonl").exists()
    (wave / "a01.json").write_text(json.dumps({"agent": "a01", "records": [edition()]}))
    research.import_wave(Paths(root), "w1", vocab, TODAY)
    assert not (wave / "_rejected.jsonl").exists()
