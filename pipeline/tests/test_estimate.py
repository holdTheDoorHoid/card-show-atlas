from __future__ import annotations

import copy
import json
from datetime import date

import pytest

from csa import estimate
from csa.estimate import (Model, build_model, calibration_report, fit_factors, load_priors, round_sig, run_calibrate,
                          run_estimate, validate_priors)
from csa.model import complete_show
from csa.paths import Paths
from conftest import REPO, read_jsonl_file, write_jsonl_file


@pytest.fixture
def priors():
    return load_priors(REPO / "data" / "model" / "priors.json")


def mk(day="2026-11-14", ndays=1, event_type="card_show", series="s1", sid=None, **size) -> dict:
    days = [{"date": f"2026-11-{14 + i:02d}" if day == "2026-11-14" else day, "open": None, "close": None} for i in range(ndays)]
    if day != "2026-11-14":
        days = [{"date": day, "open": None, "close": None}]
    rec = complete_show({"id": sid or f"{series}-{day}", "series_id": series, "name": "Show", "event_type": event_type,
                         "days": days, "size": size})
    return rec


def est(show, priors, others=()):
    shows = [show, *others]
    model, _ = build_model(shows, priors)
    return model.estimate(show)


# ---------------------------------------------------------------- priors

def test_every_prior_value_has_a_source_note(priors):
    assert validate_priors(priors) == []
    broken = copy.deepcopy(priors)
    del broken["attendees_per_table"]["card_show"]["1"]["source"]
    assert any("card_show" in p and "no source" in p for p in validate_priors(broken))


def test_placeholders_are_marked_as_such(priors):
    """Only figures that have a real source may omit the placeholder mark."""
    unmarked = []

    def walk(node, where=""):
        if isinstance(node, dict):
            if any(isinstance(node.get(k), (int, float)) and not isinstance(node.get(k), bool) for k in ("low", "mid", "high", "value")):
                if "placeholder" not in str(node.get("basis", "")):
                    unmarked.append(where)
            for k, v in node.items():
                walk(v, f"{where}.{k}")
    walk(priors)
    # the one size cut point that comes from DESIGN.md is the only unmarked number
    assert unmarked == [".size_classes.small_max"]
    assert priors["attendees_per_table"]["card_show"]["1"]["basis"] == "placeholder, tune when data arrives"


def test_the_data_model_example_is_reproduced(priors):
    e = est(mk(tables=120), priors)
    assert e["attendance"] == {"low": 400, "mid": 700, "high": 1100}
    assert e["basis"] == "tables" and e["confidence"] == "estimated" and e["size_class"] == "medium"
    assert e["traffic_per_table"] == 5.8
    assert e["explain"] == "Estimated from 120 vendor tables at a one day card show."


def test_round_sig():
    assert [round_sig(x) for x in (0, 704, 1087, 25, 3049, 99999)] == [0, 700, 1100, 25, 3000, 100000]


# ---------------------------------------------------------------- signals, best first

def test_reported_attendance_wins(priors):
    e = est(mk(tables=120, reported_attendance={"value": 3000, "year": 2026, "source_url": None}), priors)
    assert e["basis"] == "reported" and e["confidence"] == "reported"
    assert e["attendance"] == {"low": 2700, "mid": 3000, "high": 3300}
    assert e["size_class"] == "large" and e["traffic_per_table"] == 25.0


def test_a_figure_without_a_year_counts_for_this_edition(priors):
    e = est(mk(reported_attendance={"value": 800, "year": None, "source_url": None}), priors)
    assert e["basis"] == "reported"


def test_an_earlier_reported_figure_is_carried_forward(priors):
    show = mk(tables=120, reported_attendance={"value": 3000, "year": 2025, "source_url": None})
    e = est(show, priors)
    assert e["basis"] == "history" and e["confidence"] == "estimated"
    assert e["attendance"]["mid"] == 3000 and e["attendance"]["low"] < 3000 < e["attendance"]["high"]
    assert "3,000" in e["explain"] and "2025" in e["explain"]


def test_history_from_an_earlier_edition_with_a_trend_and_table_ratio(priors):
    a = mk(day="2024-11-09", sid="s1-a", reported_attendance={"value": 2000, "year": 2024, "source_url": None}, tables=100)
    b = mk(day="2025-11-08", sid="s1-b", reported_attendance={"value": 2400, "year": 2025, "source_url": None}, tables=100)
    now = mk(tables=110)
    e = est(now, priors, [a, b])
    # 2400 carried forward, trend 2400/2000 = 1.2 (inside the 0.8 to 1.25 clamp), tables 110/100
    assert e["basis"] == "history"
    assert e["attendance"]["mid"] == round_sig(2400 * 1.2 * 1.1)
    assert e["traffic_per_table"] == round(e["attendance"]["mid"] / 110, 1)
    # a wild jump is limited by the clamp
    b["size"]["reported_attendance"]["value"] = 20000
    e = est(now, priors, [a, b])
    assert e["attendance"]["mid"] == round_sig(20000 * 1.25 * 1.1)


def test_figures_older_than_the_limit_are_ignored(priors):
    old = mk(day="2019-11-09", sid="s1-old", reported_attendance={"value": 5000, "year": 2019, "source_url": None}, tables=100)
    e = est(mk(tables=60), priors, [old])
    assert e["basis"] == "tables"


def test_players_for_tournaments(priors):
    e = est(mk(event_type="tournament", ndays=2, players=1000), priors)
    assert e["basis"] == "players" and e["attendance"] == {"low": 1200, "mid": 1800, "high": 2600}
    assert e["size_class"] == "medium" and "1,000 registered players" in e["explain"]


def test_tables_depend_on_event_type_and_number_of_days(priors):
    one = est(mk(tables=100), priors)["attendance"]["mid"]
    two = est(mk(tables=100, ndays=2), priors)["attendance"]["mid"]
    three = est(mk(tables=100, ndays=3), priors)["attendance"]["mid"]
    con = est(mk(tables=100, event_type="convention"), priors)["attendance"]["mid"]
    assert one < two < three and con > one
    assert est(mk(tables=100, ndays=2), priors)["explain"] == "Estimated from 100 vendor tables at a two day card show."


def test_booths_count_when_tables_are_unknown(priors):
    e = est(mk(booths=80), priors)
    assert e["basis"] == "tables" and e["traffic_per_table"] == 5.8


def test_history_without_a_reported_figure_uses_an_earlier_editions_tables(priors):
    older = mk(day="2025-11-08", sid="s1-old", tables=100)
    e = est(mk(), priors, [older])
    assert e["basis"] == "history" and e["confidence"] == "estimated"
    assert e["attendance"] == {"low": 330, "mid": 580, "high": 920}
    assert e["traffic_per_table"] is None  # this edition has no table count of its own
    assert "earlier edition" in e["explain"]


def test_area_is_a_rough_guess(priors):
    e = est(mk(venue_sqft=40000, ndays=2), priors)
    assert e["basis"] == "area" and e["confidence"] == "rough"
    assert e["attendance"]["mid"] == round_sig(40 * 2 * 2.5)


def test_with_nothing_known_the_event_type_decides(priors):
    e = est(mk(), priors)
    assert e["basis"] == "type_default" and e["confidence"] == "rough" and e["size_class"] == "small"
    assert e["traffic_per_table"] is None
    big = est(mk(event_type="pop_culture_con", ndays=3), priors)
    assert big["size_class"] == "major" and big["attendance"]["mid"] == 18000


def test_size_class_cut_points(priors):
    m = Model(priors, {})
    assert [m.size_class(x) for x in (0, 499, 500, 1999, 2000, 5999, 6000, 50000)] == [
        "small", "small", "medium", "medium", "large", "large", "major", "major"]


def test_ranges_are_ordered_and_store_events_get_no_estimate(priors):
    for show in (mk(tables=3), mk(tables=500), mk(reported_attendance={"value": 7, "year": 2026, "source_url": None}), mk()):
        a = est(show, priors)["attendance"]
        assert 0 <= a["low"] <= a["mid"] <= a["high"]
    assert est(mk(event_type="store_event"), priors) is None


# ---------------------------------------------------------------- calibration

def with_both(n, ratio, **kw):
    out = []
    for i in range(n):
        out.append(mk(day=f"2025-{(i % 12) + 1:02d}-0{(i % 7) + 1}", sid=f"c{i}-{ratio}", series=f"c{i}-{ratio}", tables=100,
                      reported_attendance={"value": int(100 * ratio), "year": 2025, "source_url": None}, **kw))
    return out


def test_calibration_prints_the_fit_and_switches_only_with_enough_shows(priors):
    few = with_both(5, 20.0)
    fits = {f.group: f for f in fit_factors(few, priors)}
    f = fits[("card_show", "1")]
    assert f.n == 5 and f.median == 20.0 and f.used == "prior"
    model, _ = build_model(few + [mk(tables=100)], priors)
    assert model.estimate(mk(tables=100))["attendance"]["mid"] == 580  # still the prior

    many = with_both(8, 20.0)
    fits = {f.group: f for f in fit_factors(many, priors)}
    assert fits[("card_show", "1")].used == "fitted"
    model, _ = build_model(many, priors)
    e = model.estimate(mk(tables=100))
    assert e["attendance"]["mid"] == 2000 and "fitted from 8 shows" in e["explain"]
    text = "\n".join(calibration_report(list(fits.values()), 8))
    assert "card_show" in text and "fitted" in text and "20.0" in text


def test_calibration_ignores_figures_for_other_years_and_missing_tables(priors):
    a = mk(tables=100, reported_attendance={"value": 5000, "year": 2020, "source_url": None})   # not this year's figure
    b = mk(reported_attendance={"value": 5000, "year": 2026, "source_url": None})                   # no tables
    assert estimate.calibration_samples([a, b]) == {}


def test_calibration_report_with_no_data_says_so(priors):
    text = "\n".join(calibration_report(fit_factors([], priors), 8))
    assert "No show reports both" in text


# ---------------------------------------------------------------- the command

def test_run_estimate_writes_into_shows_and_is_repeatable(root):
    paths = Paths(root)
    shows = [mk(tables=120), mk(day="2026-12-05", sid="s2-x", series="s2", event_type="pop_culture_con"),
             mk(day="2026-11-20", sid="ev-1", series="ev", event_type="store_event")]
    write_jsonl_file(paths.shows, shows)
    rep = run_estimate(paths)
    out = read_jsonl_file(paths.shows)
    assert rep.shows == 2 and out[0]["estimate"]["attendance"]["mid"] == 700
    assert out[2]["estimate"] is None
    first = paths.shows.read_text()
    run_estimate(paths)
    assert paths.shows.read_text() == first
    assert run_calibrate(paths)[0].startswith("Attendees per table")
