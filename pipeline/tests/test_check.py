from __future__ import annotations

import copy
from datetime import date

import pytest

from csa import check
from csa.check import ERROR, WARNING, check_records, check_show, run_check
from csa.domains import DomainPolicy
from csa.model import complete_show
from csa.paths import Paths
from csa.vocab import Vocab
from conftest import REPO, write_jsonl_file

TODAY = date(2026, 10, 21)
POLICY = DomainPolicy(["beckett.com"], ["facebook.com"])


@pytest.fixture
def vocab(root):
    return Vocab.load(root / "data" / "vocab.json")


def good() -> dict:
    return complete_show({
        "id": "garden-state-card-show-edison-nj-2026-11-14", "series_id": "garden-state-card-show-edison-nj",
        "name": "Garden State Card Show", "event_type": "card_show", "status": "scheduled",
        "days": [{"date": "2026-11-14", "open": "09:00", "close": "15:00"}, {"date": "2026-11-15", "open": "10:00", "close": "14:00"}],
        "timezone": "America/New_York",
        "venue": {"name": "Example Expo Hall", "address": "97 Sunfield Ave", "city": "Edison", "region": "NJ", "postal": "08837",
                  "country": "US", "lat": 40.5187, "lon": -74.3518, "geo_precision": "address"},
        "sells": {"tcg": ["pokemon", "mtg"], "sports": ["baseball"], "other": ["comics"]}, "mix": "mixed",
        "admission": {"free": False, "adult": 5, "child": 0, "currency": "USD", "notes": "Under 12 free"},
        "size": {"tables": 120},
        "vendor": {"tables": [{"label": "8 ft table", "price": 150, "currency": "USD", "notes": None}],
                   "application_url": "https://example.com/vendors", "opens": "2026-08-01", "deadline": "2026-10-31",
                   "status": "open", "setup": "07:00", "contact": "vendors@example.com"},
        "organizer": {"name": "Example Promotions", "promoter_id": "example-promotions", "url": "https://example.com"},
        "links": {"official": "https://example.com/show"},
        "sources": [{"source": "example_calendar", "url": "https://calendar.example.org/show/123", "retrieved": "2026-10-21", "fields": ["name"]}],
        "verification": "listed", "first_seen": "2026-10-21", "last_checked": "2026-10-21",
    })


def findings(show, vocab, sources=("example_calendar",)):
    return check_show(show, vocab, set(sources), POLICY, TODAY)


def one(show, vocab, rule, severity=None):
    got = [f for f in findings(show, vocab) if f.rule == rule]
    assert got, f"no {rule} finding in {[f.line() for f in findings(show, vocab)]}"
    if severity:
        assert got[0].severity == severity
    return got[0]


def test_a_clean_show_has_no_findings(vocab):
    assert findings(good(), vocab) == []


def mutate(**paths):
    s = good()
    for path, value in paths.items():
        cur = s
        parts = path.split("__")
        for p in parts[:-1]:
            cur = cur[int(p)] if isinstance(cur, list) else cur[p]
        if isinstance(cur, list):
            cur[int(parts[-1])] = value
        else:
            cur[parts[-1]] = value
    return s


@pytest.mark.parametrize("path", ["name", "series_id", "event_type", "status", "verification", "first_seen", "last_checked"])
def test_required_top_level_fields(vocab, path):
    s = good()
    s[path] = None
    assert one(s, vocab, "required", ERROR).message.startswith(path)


@pytest.mark.parametrize("key", ["city", "region", "country"])
def test_required_venue_fields(vocab, key):
    s = good()
    s["venue"][key] = None
    assert any(f.severity == ERROR and f"venue.{key}" in f.message for f in findings(s, vocab))


def test_no_days_and_no_sources_are_errors(vocab):
    s = good()
    s["days"] = []
    s["sources"] = []
    msgs = [f.message for f in findings(s, vocab) if f.rule == "required"]
    assert any("days" in m for m in msgs) and any("sources" in m for m in msgs)


# ---------------------------------------------------------------- dates

def test_bad_dates_are_errors(vocab):
    s = good()
    s["days"][0]["date"] = "2026-13-40"
    assert "not a date" in one(s, vocab, "dates", ERROR).message


def test_years_that_are_off_are_errors(vocab):
    for day in ("1995-11-14", "2031-11-14"):
        s = good()
        s["days"] = [{"date": day, "open": None, "close": None}]
        assert "unlikely year" in one(s, vocab, "dates", ERROR).message


def test_far_future_dates_are_a_warning_not_an_error(vocab):
    s = good()
    s["days"] = [{"date": "2029-01-01", "open": None, "close": None}]
    assert "24 months" in one(s, vocab, "dates", WARNING).message


def test_days_out_of_order_or_repeated(vocab):
    s = good()
    s["days"][1]["date"] = "2026-11-14"
    assert "order" in one(s, vocab, "dates", ERROR).message


def test_a_run_of_dates_that_is_too_long(vocab):
    s = good()
    s["days"][1]["date"] = "2026-12-20"
    assert one(s, vocab, "dates", ERROR).message.startswith("the days run for 37 days")
    s["days"][1]["date"] = "2026-11-30"
    assert one(s, vocab, "dates", WARNING)


def test_times_must_be_24_hour_and_close_after_open(vocab):
    s = good()
    s["days"][0]["open"] = "9am"
    assert "24 hour" in one(s, vocab, "dates", ERROR).message
    s = good()
    s["days"][0]["close"] = "08:00"
    assert "not after it opens" in one(s, vocab, "dates", WARNING).message


def test_a_show_that_ended_long_before_we_saw_it_gets_a_year_warning(vocab):
    s = good()
    s["days"] = [{"date": "2026-01-10", "open": None, "close": None}]
    s["first_seen"] = "2026-10-15"
    s["size"]["tables"] = None
    s["vendor"].update(deadline=None, opens=None)
    assert "Is the year right" in one(s, vocab, "dates", WARNING).message
    s["size"]["tables"] = 80  # a recorded past show with a size is fine
    assert not [f for f in findings(s, vocab) if f.rule == "dates"]


# ---------------------------------------------------------------- timezone and coordinates

def test_time_zone_must_be_a_real_iana_name(vocab):
    s = good()
    s["timezone"] = "Eastern Standard"
    assert one(s, vocab, "timezone", ERROR)
    s["timezone"] = None
    assert one(s, vocab, "timezone", WARNING)


def test_coordinates_outside_the_stated_region_are_an_error(vocab):
    s = good()
    s["venue"]["lat"], s["venue"]["lon"] = 34.05, -118.24  # Los Angeles, not New Jersey
    assert "outside NJ" in one(s, vocab, "coordinates", ERROR).message


def test_coordinates_in_the_wrong_hemisphere_or_country(vocab):
    s = good()
    s["venue"].update(region="ON", country="CA", lat=40.5, lon=-74.35)
    assert one(s, vocab, "coordinates", ERROR)
    s = good()
    s["venue"].update(lat=-40.5, lon=74.35)
    assert one(s, vocab, "coordinates", ERROR)


def test_lat_without_lon_and_missing_precision(vocab):
    s = good()
    s["venue"]["lon"] = None
    assert "only one" in one(s, vocab, "coordinates", ERROR).message
    s = good()
    s["venue"]["geo_precision"] = "exact"
    assert "geo_precision" in one(s, vocab, "coordinates", ERROR).message


def test_missing_coordinates_warn_only_for_upcoming_shows(vocab):
    s = good()
    s["venue"].update(lat=None, lon=None, geo_precision=None)
    assert "not appear on the map" in one(s, vocab, "coordinates", WARNING).message
    s["days"] = [{"date": "2026-01-10", "open": None, "close": None}]
    assert not [f for f in findings(s, vocab) if f.rule == "coordinates"]


def test_region_code_must_belong_to_the_country(vocab):
    s = good()
    s["venue"]["country"] = "CA"
    assert "does not belong" in one(s, vocab, "required", ERROR).message
    s = good()
    s["venue"]["region"] = "XX"
    assert "not a state or province code" in one(s, vocab, "required", ERROR).message


# ---------------------------------------------------------------- money

def test_money_needs_a_currency(vocab):
    s = good()
    s["admission"]["currency"] = None
    assert "no currency" in one(s, vocab, "money", ERROR).message
    s = good()
    s["vendor"]["tables"][0]["currency"] = None
    assert "tables[0] has a price but no currency" in one(s, vocab, "money", ERROR).message
    s = good()
    s["vendor"]["tables"][0]["currency"] = "EUR"
    assert "USD or CAD" in one(s, vocab, "money", ERROR).message


def test_free_entry_needs_no_currency(vocab):
    s = good()
    s["admission"].update(free=True, adult=0, child=0, currency=None)
    assert not [f for f in findings(s, vocab) if f.rule == "money"]


def test_odd_prices(vocab):
    s = good()
    s["admission"]["adult"] = -1
    assert "negative" in one(s, vocab, "money", ERROR).message
    s = good()
    s["vendor"]["tables"][0]["price"] = 99999
    assert "unusually high" in one(s, vocab, "money", WARNING).message
    s = good()
    s["admission"]["free"] = True
    assert "free but has an adult price" in one(s, vocab, "money", ERROR).message
    s = good()
    s["admission"]["adult"] = "five"
    assert "not a number" in one(s, vocab, "money", ERROR).message


def test_currency_that_does_not_fit_the_country_is_a_warning(vocab):
    s = good()
    s["admission"]["currency"] = "CAD"
    assert "Check it" in one(s, vocab, "money", WARNING).message


# ---------------------------------------------------------------- vendor deadline

def test_deadline_after_the_show(vocab):
    s = good()
    s["vendor"]["deadline"] = "2026-11-20"
    assert "after the show starts" in one(s, vocab, "vendor", ERROR).message
    s = good()
    s["vendor"]["deadline"] = "2026-11-14"  # the day of the show is not after it
    assert not [f for f in findings(s, vocab) if f.rule == "vendor"]


def test_applications_opening_after_the_deadline_and_bad_setup(vocab):
    s = good()
    s["vendor"]["opens"] = "2026-11-01"
    assert "after the deadline" in one(s, vocab, "vendor", ERROR).message
    s = good()
    s["vendor"]["setup"] = "7am"
    assert "setup" in one(s, vocab, "vendor", ERROR).message


# ---------------------------------------------------------------- privacy

@pytest.mark.parametrize("path, value", [("vendor__contact", "Call Bob 215-555-1234"), ("vendor__notes", "text (610) 555 1212".replace(" 555 1212", " 555-1212")),
                                         ("summary", "Reach us at 215.555.1234")])
def test_personal_phone_patterns_warn(vocab, path, value):
    s = mutate(**{path: value})
    f = one(s, vocab, "privacy", WARNING)
    assert "phone number" in f.message


def test_email_contacts_are_fine(vocab):
    assert not [f for f in findings(good(), vocab) if f.rule == "privacy"]


def test_home_addresses_warn(vocab):
    s = good()
    s["venue"]["address"] = "12 Oak St Apt 4B"
    assert "residential" in one(s, vocab, "privacy", WARNING).message
    s = good()
    s["venue"]["name"] = "Residence of J. Smith"
    assert "private home" in one(s, vocab, "privacy", WARNING).message


# ---------------------------------------------------------------- urls

@pytest.mark.parametrize("path, url", [("links__official", "example.com/show"), ("links__facebook", "ftp://example.com"),
                                       ("organizer__url", "https://localhost"), ("vendor__application_url", "https://exa mple.com")])
def test_malformed_urls_are_errors(vocab, path, url):
    s = mutate(**{path: url})
    assert "well formed" in one(s, vocab, "urls", ERROR).message


def test_source_urls_are_checked_and_never_use_sites_warn(vocab):
    s = good()
    s["sources"][0]["url"] = "notaurl"
    assert one(s, vocab, "urls", ERROR)
    s = good()
    s["links"]["tickets"] = "https://www.beckett.com/x"
    assert "never use list" in one(s, vocab, "urls", WARNING).message


# ---------------------------------------------------------------- vocabulary

def test_unknown_vocabulary_is_an_error(vocab):
    s = good()
    s["sells"]["tcg"].append("beanie_babies")
    assert "beanie_babies" in one(s, vocab, "vocab", ERROR).message
    s = good()
    s["sells"]["sports"] = ["pokemon"]  # a real id, but in the wrong group
    assert one(s, vocab, "vocab", ERROR)
    for key, bad in (("event_type", "garage_sale"), ("status", "maybe"), ("verification", "trusted"), ("mix", "all")):
        s = good()
        s[key] = bad
        assert any(f.rule == "vocab" and bad in f.message for f in findings(s, vocab))
    s = good()
    s["vendor"]["status"] = "sort_of"
    assert one(s, vocab, "vocab", ERROR)


def test_unknown_source_ids_warn(vocab):
    s = good()
    s["sources"][0]["source"] = "mystery"
    assert "no credit text" in one(s, vocab, "sources", WARNING).message


def test_long_summary_warns(vocab):
    s = good()
    s["summary"] = "word " * 80
    assert "copied" in one(s, vocab, "text", WARNING).message


def test_estimate_shape(vocab):
    s = good()
    s["estimate"] = {"attendance": {"low": 400, "mid": 700, "high": 1100}, "basis": "tables", "confidence": "estimated",
                     "size_class": "medium", "traffic_per_table": 5.8, "explain": "x"}
    assert not [f for f in findings(s, vocab) if f.rule == "estimate"]
    s["estimate"]["attendance"] = {"low": 900, "mid": 700, "high": 1100}
    assert one(s, vocab, "estimate", ERROR)
    s["estimate"]["attendance"] = {"low": 400, "mid": 700, "high": 1100}
    s["estimate"]["size_class"] = "huge"
    assert one(s, vocab, "estimate", ERROR)


# ---------------------------------------------------------------- whole file

def test_duplicate_ids_and_dangling_references(vocab):
    a, b = good(), good()
    rep = check_records([a, b], vocab, {"example_calendar"}, POLICY, TODAY, series=[], promoters=[])
    msgs = [f.message for f in rep.errors]
    assert any("appears 2 times" in m for m in msgs) and any("has no record in series.jsonl" in m for m in msgs)
    rep = check_records([a], vocab, {"example_calendar"}, POLICY, TODAY,
                        series=[{"id": a["series_id"], "editions": [a["id"], "ghost-2026-01-01"]}],
                        promoters=[{"id": "p", "series": ["nope"]}])
    msgs = [f.message for f in rep.errors]
    assert any("ghost" in m for m in msgs) and any("nope" in m for m in msgs)


def test_report_lists_errors_before_warnings_and_says_what_to_do(vocab):
    s = good()
    s["timezone"] = None
    s["venue"]["lat"], s["venue"]["lon"] = 34.05, -118.24
    rep = check_records([s], vocab, {"example_calendar"}, POLICY, TODAY)
    lines = rep.lines()
    assert lines[0].startswith("ERROR") and "WARNING" in lines[1]
    assert "1 errors, 1 warnings" in lines[-2] and "Errors block the build" in lines[-1]
    assert not rep.ok


def test_run_check_reads_the_data_files(root, vocab):
    write_jsonl_file(root / "data/shows.jsonl", [good()])
    write_jsonl_file(root / "data/series.jsonl", [{"id": "garden-state-card-show-edison-nj", "editions": ["garden-state-card-show-edison-nj-2026-11-14"]}])
    (root / "data" / "sources.yaml").write_text("- {id: example_calendar, name: X, kind: aggregator, method: script}\n")
    rep = run_check(Paths(root), vocab, TODAY)
    assert rep.ok and rep.records == 1
