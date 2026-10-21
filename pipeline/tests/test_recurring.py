from __future__ import annotations

import calendar
from datetime import date, timedelta

import pytest

from csa import merge, recurring
from csa.paths import Paths
from csa.recurring import (STALE_AFTER_DAYS, TENTATIVE_NOTE, expand_series, nth_weekday, repair_series, rule_dates,
                           rule_problems)
from csa.vocab import Vocab
from conftest import read_jsonl_file, write_jsonl_file

TODAY = date(2026, 10, 21)  # a Wednesday


@pytest.fixture
def vocab(merge_root):
    return Vocab.load(merge_root / "data" / "vocab.json")


def series(**over) -> dict:
    rec = {"kind": "series", "name": "Example Monthly Card Show", "event_type": "card_show",
           "venue": {"name": "VFW Post 123", "address": "1 Main St", "city": "Media", "region": "PA", "postal": "19063", "country": "US"},
           "cadence": "Second Sunday of every month except July and August",
           "rule": {"freq": "monthly", "weekday": "sun", "nth": 2, "skip_months": [7, 8], "until": None},
           "hours": {"open": "09:00", "close": "14:00"}, "known_dates": ["2026-11-08", "2026-12-13"],
           "cancelled_dates": [], "last_confirmed": "2026-10-15", "verification": "organizer_confirmed",
           "sources": [{"source": "research", "url": "https://example.org/schedule", "retrieved": "2026-10-21",
                        "fields": ["cadence", "known_dates", "hours"]}],
           "evidence": [], "research_id": "w/a/0", "agent_confidence": "high"}
    rec.update(over)
    return rec


def dates_of(editions, generated=None):
    return [e["days"][0]["date"] for e in editions if generated is None or e["_generated"] == generated]


# ---------------------------------------------------------------- date arithmetic

def brute_nth(year, month, weekday, nth):
    days = [date(year, month, d) for d in range(1, calendar.monthrange(year, month)[1] + 1)
            if date(year, month, d).weekday() == weekday]
    return days[-1] if nth == -1 else (days[nth - 1] if nth <= len(days) else None)


@pytest.mark.parametrize("nth", [1, 2, 3, 4, -1])
def test_nth_weekday_agrees_with_a_brute_force_calendar(nth):
    for year in (2026, 2027, 2028):  # 2028 has a leap February
        for month in range(1, 13):
            for weekday in range(7):
                assert nth_weekday(year, month, weekday, nth) == brute_nth(year, month, weekday, nth)


def test_last_weekday_of_the_month_examples():
    assert nth_weekday(2026, 11, 6, -1) == date(2026, 11, 29)   # last Sunday of November 2026
    assert nth_weekday(2028, 2, 3, -1) == date(2028, 2, 24)     # last Thursday of a leap February
    assert nth_weekday(2027, 2, 4, -1) == date(2027, 2, 26)     # last Friday, 28 day February
    assert nth_weekday(2026, 12, 3, -1) == date(2026, 12, 31)   # the last day itself
    assert nth_weekday(2026, 11, 6, 2) == date(2026, 11, 8)     # second Sunday


def test_rule_dates_monthly_weekly_and_none():
    monthly = {"freq": "monthly", "weekday": "sun", "nth": 2}
    assert rule_dates(monthly, date(2026, 10, 21), date(2027, 1, 19)) == [date(2026, 11, 8), date(2026, 12, 13), date(2027, 1, 10)]
    weekly = {"freq": "weekly", "weekday": "sat"}
    got = rule_dates(weekly, date(2026, 10, 21), date(2026, 11, 11))
    assert got == [date(2026, 10, 24), date(2026, 10, 31), date(2026, 11, 7)]
    assert rule_dates({"freq": "none"}, date(2026, 10, 21), date(2027, 1, 19)) == []
    assert rule_dates({"freq": "monthly", "weekday": "sun"}, date(2026, 10, 21), date(2027, 1, 19)) == []  # no nth


# ---------------------------------------------------------------- repair

def test_repair_series_fixes_words_and_numbers(vocab):
    raw = {"kind": "series", "name": "Example Monthly", "venue": {"city": "Media", "region": "Pennsylvania"},
           "rule": {"freq": "Monthly", "weekday": "Sunday", "nth": "last", "skip_months": ["July", "aug", 9, 9], "until": "Dec 31, 2027"},
           "hours": {"open": "9am", "close": "2 pm"}, "known_dates": ["Nov 8, 2026", "2026-11-08", "12/13/2026"],
           "cancelled_dates": ["2026-12-13"], "last_confirmed": "Oct 15, 2026", "cadence": "Last Sunday except summer"}
    rec, notes = repair_series(raw, vocab, TODAY)
    assert rec["rule"] == {"freq": "monthly", "weekday": "sun", "nth": -1, "skip_months": [7, 8, 9], "until": "2027-12-31"}
    assert rec["hours"] == {"open": "09:00", "close": "14:00"}
    assert rec["known_dates"] == ["2026-11-08", "2026-12-13"]
    assert rec["last_confirmed"] == "2026-10-15" and rec["venue"]["region"] == "PA" and rec["kind"] == "series"
    assert "days" not in rec and notes


def test_rule_problems():
    assert rule_problems({"rule": {"freq": "monthly", "weekday": "sun", "nth": 2}}) == []
    assert rule_problems({"rule": {"freq": "monthly", "weekday": "sun", "nth": None}})
    assert rule_problems({"rule": {"freq": "weekly", "weekday": None}})
    assert rule_problems({"rule": {"freq": "none"}, "known_dates": []})
    assert rule_problems({"rule": {"freq": "none"}, "known_dates": ["2026-11-08"]}) == []


# ---------------------------------------------------------------- expansion

def test_known_dates_become_scheduled_and_the_rule_adds_tentative_ones():
    eds = expand_series(series(), TODAY)
    assert dates_of(eds, "known") == ["2026-11-08", "2026-12-13"]
    assert all(e["status"] == "scheduled" for e in eds if e["_generated"] == "known")
    assert dates_of(eds, "tentative") == ["2027-01-10"]  # Nov and Dec are known, Jan 10 is within 90 days
    ed = eds[0]
    assert ed["days"] == [{"date": "2026-11-08", "open": "09:00", "close": "14:00"}]
    assert ed["name"] == "Example Monthly Card Show" and ed["venue"]["city"] == "Media"
    assert ed["_cadence"].startswith("Second Sunday")
    tent = [e for e in eds if e["_generated"] == "tentative"][0]
    assert tent["status"] == "tentative" and tent["verification"] == "unverified"


def test_tentative_dates_stop_at_ninety_days():
    rule = {"freq": "monthly", "weekday": "tue", "nth": 3, "skip_months": [], "until": None}
    s = series(rule=rule, known_dates=[])
    # third Tuesday of January 2027 is the 19th: exactly 90 days after 2026-10-21
    assert "2027-01-19" in dates_of(expand_series(s, date(2026, 10, 21)))
    assert "2027-01-19" not in dates_of(expand_series(s, date(2026, 10, 20)))  # 91 days away
    assert dates_of(expand_series(s, date(2026, 10, 21)), "tentative")[0] == "2026-11-17"


def test_skip_months_and_cancelled_dates_and_until():
    s = series(known_dates=[], rule={"freq": "monthly", "weekday": "sun", "nth": 2, "skip_months": [12], "until": None})
    assert dates_of(expand_series(s, TODAY)) == ["2026-11-08", "2027-01-10"]  # December skipped
    s = series(known_dates=[], cancelled_dates=["2026-11-08"])
    assert dates_of(expand_series(s, TODAY)) == ["2026-12-13", "2027-01-10"]
    s = series(known_dates=[], rule={"freq": "monthly", "weekday": "sun", "nth": 2, "skip_months": [], "until": "2026-12-31"})
    assert dates_of(expand_series(s, TODAY)) == ["2026-11-08", "2026-12-13"]  # nothing past until
    # until does not remove explicit known dates
    s = series(known_dates=["2027-02-14"], rule={"freq": "monthly", "weekday": "sun", "nth": 2, "skip_months": [], "until": "2026-12-31"})
    assert "2027-02-14" in dates_of(expand_series(s, TODAY), "known")


def test_a_cancelled_known_date_becomes_a_cancelled_edition():
    s = series(known_dates=["2026-11-08", "2026-12-13"], cancelled_dates=["2026-12-13"])
    eds = expand_series(s, TODAY)
    by_date = {e["days"][0]["date"]: e for e in eds}
    assert by_date["2026-12-13"]["status"] == "cancelled" and by_date["2026-11-08"]["status"] == "scheduled"
    assert "2026-12-13" not in dates_of(eds, "tentative")


def test_last_weekday_rule_nth_minus_one():
    s = series(known_dates=[], rule={"freq": "monthly", "weekday": "sun", "nth": -1, "skip_months": [], "until": None})
    eds = expand_series(s, TODAY)
    # October's last Sunday (the 25th) is still ahead of us; January's (the 31st) is past 90 days
    assert dates_of(eds) == ["2026-10-25", "2026-11-29", "2026-12-27"]
    assert all(date.fromisoformat(d).weekday() == 6 for d in dates_of(eds))
    assert dates_of(expand_series(s, date(2026, 12, 1))) == ["2026-12-27", "2027-01-31", "2027-02-28"]


def test_series_not_confirmed_for_120_days_stops_making_tentative_dates():
    fresh = (TODAY - timedelta(days=STALE_AFTER_DAYS)).isoformat()
    stale = (TODAY - timedelta(days=STALE_AFTER_DAYS + 1)).isoformat()
    assert dates_of(expand_series(series(last_confirmed=fresh), TODAY), "tentative") == ["2027-01-10"]
    old = expand_series(series(last_confirmed=stale), TODAY)
    assert dates_of(old, "tentative") == []
    assert dates_of(old, "known") == ["2026-11-08", "2026-12-13"]  # what the organizer announced stays
    assert dates_of(expand_series(series(last_confirmed=None), TODAY), "tentative") == []


def test_freq_none_only_uses_known_dates():
    s = series(rule={"freq": "none", "weekday": None, "nth": None, "skip_months": [], "until": None})
    assert dates_of(expand_series(s, TODAY)) == ["2026-11-08", "2026-12-13"]


def test_weekly_rule_expands_every_week():
    s = series(known_dates=[], rule={"freq": "weekly", "weekday": "sat", "nth": None, "skip_months": [], "until": None})
    got = dates_of(expand_series(s, TODAY))
    assert got[0] == "2026-10-24" and len(got) == 13
    assert all(date.fromisoformat(d).weekday() == 5 for d in got)


def test_sources_are_carried_onto_the_generated_editions():
    eds = expand_series(series(), TODAY)
    assert eds[0]["sources"][0]["url"] == "https://example.org/schedule"
    assert eds[0]["sources"][0]["fields"] == ["days"]  # cadence, known_dates and hours all mean "days"


# ---------------------------------------------------------------- inside csa merge

def run(root, vocab, today=TODAY):
    return merge.run_merge(Paths(root), vocab, today)


def shows_of(root):
    return read_jsonl_file(root / "data" / "shows.jsonl")


def test_merge_turns_a_series_into_scheduled_and_tentative_editions(merge_root, vocab):
    write_jsonl_file(merge_root / "data/research/w.jsonl", [series()])
    run(merge_root, vocab)
    out = {s["days"][0]["date"]: s for s in shows_of(merge_root)}
    assert sorted(out) == ["2026-11-08", "2026-12-13", "2027-01-10"]
    assert out["2026-11-08"]["status"] == "scheduled" and out["2026-11-08"]["verification"] == "organizer_confirmed"
    jan = out["2027-01-10"]
    assert jan["status"] == "tentative" and jan["verification"] == "unverified"
    assert jan["summary"] == TENTATIVE_NOTE
    assert out["2026-11-08"]["summary"] is None
    assert jan["id"] == "example-monthly-card-show-media-pa-2027-01-10"
    assert jan["days"] == [{"date": "2027-01-10", "open": "09:00", "close": "14:00"}]
    sr = read_jsonl_file(merge_root / "data/series.jsonl")
    assert len(sr) == 1 and sr[0]["cadence"] == "Second Sunday of every month except July and August"
    assert len(sr[0]["editions"]) == 3


def test_the_window_moves_forward_and_ids_do_not_change(merge_root, vocab):
    write_jsonl_file(merge_root / "data/research/w.jsonl", [series()])
    run(merge_root, vocab)
    before = {s["days"][0]["date"]: s["id"] for s in shows_of(merge_root)}
    run(merge_root, vocab, date(2026, 11, 20))
    after = {s["days"][0]["date"]: s["id"] for s in shows_of(merge_root)}
    assert after["2027-01-10"] == before["2027-01-10"]
    assert "2027-02-14" in after  # now inside the 90 days
    assert {k: v for k, v in before.items()}.items() <= after.items()


def test_a_listing_with_a_real_date_replaces_the_tentative_guess(merge_root, vocab):
    from conftest import show
    write_jsonl_file(merge_root / "data/research/w.jsonl", [series(known_dates=["2026-11-08"])])
    listing = show(name="Example Monthly Card Show", day="2027-01-10", venue="VFW Post 123", city="Media", region="PA",
                   address="1 Main St", source="list_a")
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", [listing])
    run(merge_root, vocab)
    jan = [s for s in shows_of(merge_root) if s["days"][0]["date"] == "2027-01-10"]
    assert len(jan) == 1
    assert jan[0]["status"] == "scheduled" and jan[0]["summary"] is None
    assert {x["source"] for x in jan[0]["sources"]} == {"research", "list_a"}


def test_tentative_dates_vanish_when_the_series_goes_stale_or_a_date_is_cancelled(merge_root, vocab):
    write_jsonl_file(merge_root / "data/research/w.jsonl", [series(known_dates=[])])
    run(merge_root, vocab)
    assert [s["days"][0]["date"] for s in shows_of(merge_root)] == ["2026-11-08", "2026-12-13", "2027-01-10"]
    # the organizer cancels December: the guess for that date must not linger
    write_jsonl_file(merge_root / "data/research/w.jsonl", [series(known_dates=[], cancelled_dates=["2026-12-13"])])
    run(merge_root, vocab)
    assert [s["days"][0]["date"] for s in shows_of(merge_root)] == ["2026-11-08", "2027-01-10"]
    # months later nobody has confirmed the series: no more guesses
    run(merge_root, vocab, date(2027, 3, 1))
    assert shows_of(merge_root) == []


def test_announced_dates_are_kept_as_history_after_they_pass(merge_root, vocab):
    write_jsonl_file(merge_root / "data/research/w.jsonl", [series()])
    run(merge_root, vocab)
    write_jsonl_file(merge_root / "data/research/w.jsonl", [])
    run(merge_root, vocab, date(2027, 2, 1))
    dates = [s["days"][0]["date"] for s in shows_of(merge_root)]
    assert "2026-11-08" in dates and "2026-12-13" in dates and "2027-01-10" not in dates


def test_two_series_records_for_one_show_do_not_double_up(merge_root, vocab):
    a = series(research_id="w/a/0")
    b = series(research_id="w/b/0", name="Example Monthly Card Show and Expo", sources=[
        {"source": "research", "url": "https://example.net/other", "retrieved": "2026-10-20", "fields": ["known_dates"]}])
    write_jsonl_file(merge_root / "data/research/w.jsonl", [a, b])
    run(merge_root, vocab)
    assert [s["days"][0]["date"] for s in shows_of(merge_root)] == ["2026-11-08", "2026-12-13", "2027-01-10"]
    assert {x["url"] for x in shows_of(merge_root)[0]["sources"]} == {"https://example.org/schedule", "https://example.net/other"}
