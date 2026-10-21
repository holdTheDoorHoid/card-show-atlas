from __future__ import annotations

from datetime import date

import pytest

from csa import normalize, textparse as tp
from csa.vocab import Vocab

TODAY = date(2026, 10, 21)


@pytest.fixture
def vocab(root):
    return Vocab.load(root / "data" / "vocab.json")


@pytest.mark.parametrize("text, expect", [
    ("Nov 14-15, 2026", ["2026-11-14", "2026-11-15"]),
    ("Saturday Nov 14 and Sunday Nov 15", ["2026-11-14", "2026-11-15"]),
    ("11/14/2026, 11/15", ["2026-11-14", "2026-11-15"]),
    ("14 November 2026 and 2026-12-05", ["2026-11-14", "2026-12-05"]),
    ("Jan 3, 2027", ["2027-01-03"]),
    ("March 7th", ["2027-03-07"]),                 # no year: the next one counting from today
    ("Oct 25", ["2026-10-25"]),
    ("Sept. 5, 2026", ["2026-09-05"]),
    ("31/12/2026", ["2026-12-31"]),                 # first number cannot be a month
    ("no dates here", []),
    ("Feb 30, 2026", []),                           # not a real day
])
def test_find_dates(text, expect):
    assert [d.isoformat() for d in tp.find_dates(text, TODAY)] == expect


def test_a_date_without_a_year_needs_a_reference_or_is_skipped():
    assert tp.find_dates("Nov 14") == []
    assert tp.find_dates("Nov 14", default_year=2026) == [date(2026, 11, 14)]


@pytest.mark.parametrize("text, expect", [
    ("9am", "09:00"), ("9 AM", "09:00"), ("9:30 p.m.", "21:30"), ("3pm", "15:00"), ("15:00", "15:00"),
    ("09:00:00", "09:00"), ("noon", "12:00"), ("0900", "09:00"), ("12am", "00:00"), ("12pm", "12:00"), ("25:00", None), ("soon", None),
])
def test_parse_time_text(text, expect):
    assert tp.parse_time_text(text) == expect


@pytest.mark.parametrize("text, expect", [
    ("9am to 3pm", ("09:00", "15:00")), ("10-4", ("10:00", "16:00")), ("9:00 - 15:00", ("09:00", "15:00")),
    ("Sat 10am-4pm", ("10:00", "16:00")), ("", (None, None)),
])
def test_parse_time_range(text, expect):
    assert tp.parse_time_range(text) == expect


@pytest.mark.parametrize("value, expect", [
    ("$1,200", (1200, None)), ("C$75", (75, "CAD")), ("Free", (0, None)), ("150 USD", (150, "USD")),
    ("12.50", (12.5, None)), (5, (5, None)), (None, (None, None)), ("n/a", (None, None)),
])
def test_parse_money(value, expect):
    assert tp.parse_money(value) == expect


@pytest.mark.parametrize("text, cleaned", [
    ("Call 215-555-1234 or email me@x.com", "email me@x.com"),
    ("vendors@x.com or call us at (610) 555-1212", "vendors@x.com"),
    ("tel:+1 215 555 1234", ""),
    ("Table 150 200 3000", "Table 150 200 3000"),
    ("2026-11-14 and 08837-1234", "2026-11-14 and 08837-1234"),
])
def test_scrub_phones(text, cleaned):
    assert tp.scrub_phones(text)[0] == cleaned


def test_norm_url():
    assert tp.norm_url("www.Example.com/shows?utm_source=x&a=1") == "https://www.example.com/shows?a=1"
    assert tp.norm_url("http://example.com") == "http://example.com"
    for bad in ("not a url", "facebook", "ftp://x.com", "javascript:alert(1)", "", None, 5):
        assert tp.norm_url(bad) is None


def test_same_site_and_host():
    assert tp.same_site("https://www.example.com/a", "https://example.com/b")
    assert tp.same_site("https://shows.example.com", "https://example.com")
    assert not tp.same_site("https://example.com", "https://example.org")
    assert not tp.same_site(None, "https://example.com")


@pytest.mark.parametrize("text, expect", [
    ("Example Expo Hall, 97 Sunfield Ave, Edison, NJ 08837",
     {"name": "Example Expo Hall", "address": "97 Sunfield Ave", "city": "Edison", "region": "NJ", "postal": "08837", "country": "US"}),
    ("VFW Post 123, 1 Main St, Media, Pennsylvania 19063",
     {"name": "VFW Post 123", "address": "1 Main St", "city": "Media", "region": "PA", "postal": "19063", "country": "US"}),
    ("Metro Toronto Convention Centre, 255 Front St W, Toronto, ON M5V 2W6",
     {"name": "Metro Toronto Convention Centre", "address": "255 Front St W", "city": "Toronto", "region": "ON", "postal": "M5V 2W6", "country": "CA"}),
    ("Edison, NJ", {"city": "Edison", "region": "NJ", "country": "US"}),
])
def test_parse_address_text(text, expect):
    assert tp.parse_address_text(text) == expect


def test_postal_normalizing():
    assert tp.norm_postal("8837") == "08837"
    assert tp.norm_postal("m5v2w6") == "M5V 2W6"
    assert tp.norm_postal("19063-1234") == "19063-1234"


# ---------------------------------------------------------------- repair_edition

def test_repair_leaves_the_input_alone_and_reports_what_it_did(vocab):
    raw = {"name": "  Garden  State ", "event_type": "Card Show", "status": "Canceled",
           "venue": {"city": "Edison", "region": "New Jersey", "postal": "8837"}, "estimate": {"x": 1}}
    snapshot = repr(raw)
    out, notes = normalize.repair_edition(raw, vocab, TODAY)
    assert repr(raw) == snapshot
    assert out["name"] == "Garden State" and out["event_type"] == "card_show" and out["status"] == "cancelled"
    assert out["venue"]["region"] == "NJ" and out["venue"]["postal"] == "08837" and out["venue"]["country"] == "US"
    assert "estimate" not in out and any("New Jersey" in n for n in notes)


def test_repair_never_invents_fields(vocab):
    out, _ = normalize.repair_edition({"name": "Only A Name"}, vocab, TODAY)
    assert out == {"name": "Only A Name"}


def test_repair_is_idempotent(vocab):
    raw = {"name": "X", "days": ["11/14/2026"], "venue": {"city": "Edison", "region": "NJ"}, "sells": ["Pokemon TCG"],
           "admission": {"adult": "$5"}, "vendor": {"tables": [{"price": "$75"}], "deadline": "Oct 31, 2026"}}
    once, _ = normalize.repair_edition(raw, vocab, TODAY)
    twice, notes = normalize.repair_edition(once, vocab, TODAY)
    assert once == twice
    assert not [n for n in notes if "became" in n]


def test_money_gets_a_currency_from_the_country_and_says_so(vocab):
    out, notes = normalize.repair_edition({"venue": {"city": "Toronto", "region": "ON"}, "admission": {"adult": 10},
                                           "vendor": {"tables": [{"label": "6 ft", "price": 90}]}}, vocab, TODAY)
    assert out["admission"]["currency"] == "CAD" and out["vendor"]["tables"][0]["currency"] == "CAD"
    assert any("assumed CAD" in n for n in notes)


def test_explicit_currency_is_never_overridden(vocab):
    out, _ = normalize.repair_edition({"venue": {"city": "Buffalo", "region": "NY"}, "admission": {"adult": 10, "currency": "CAD"}}, vocab, TODAY)
    assert out["admission"]["currency"] == "CAD"


def test_text_fields_lose_phone_numbers_and_long_text(vocab):
    out, notes = normalize.repair_edition({"summary": "y" * 301, "vendor": {"notes": "Text 215-555-1234 for a table", "contact": "215-555-1234"},
                                           "admission": {"notes": "Kids free"}}, vocab, TODAY)
    assert out["summary"] is None
    assert out["vendor"]["notes"] == "for a table" and out["vendor"]["contact"] is None
    assert out["admission"]["notes"] == "Kids free"
    assert sum("phone" in n for n in notes) == 2


def test_swapped_and_lonely_coordinates(vocab):
    out, _ = normalize.repair_edition({"venue": {"city": "A", "region": "NJ", "lat": -74.3, "lon": 40.5}}, vocab, TODAY)
    assert (out["venue"]["lat"], out["venue"]["lon"]) == (40.5, -74.3)
    out, _ = normalize.repair_edition({"venue": {"city": "A", "region": "NJ", "lat": 40.5}}, vocab, TODAY)
    assert out["venue"]["lat"] is None and out["venue"]["lon"] is None


def test_days_from_ranges_and_loose_strings(vocab):
    out, _ = normalize.repair_edition({"days": [{"start": "2026-11-14", "end": "2026-11-16", "open": "9am", "close": "5pm"}]}, vocab, TODAY)
    assert [d["date"] for d in out["days"]] == ["2026-11-14", "2026-11-15", "2026-11-16"]
    assert out["days"][1]["open"] == "09:00"
    out, notes = normalize.repair_edition({"days": ["Nov 14 and 15, 2026", "garbage"]}, vocab, TODAY)
    assert [d["date"] for d in out["days"]] == ["2026-11-14", "2026-11-15"]
    assert any("garbage" in n for n in notes)


def test_unknown_vocabulary_is_dropped_with_a_note(vocab):
    out, notes = normalize.repair_edition({"sells": {"tcg": ["Pokemon", "Beanie Babies"]}, "vendor": {"status": "maybe"}}, vocab, TODAY)
    assert out["sells"]["tcg"] == ["pokemon"] and out["vendor"]["status"] is None
    assert any("Beanie Babies" in n for n in notes)
