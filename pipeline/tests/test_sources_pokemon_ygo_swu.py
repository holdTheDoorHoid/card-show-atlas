"""Offline tests for pokemon_championships, yugioh_events and swu_calendar.

The pages in tests/fixtures/<source>/ are real responses saved on 2026-10-21 with scripts, styles, inline
images, emails and phone numbers taken out. No test touches the network.
"""

from __future__ import annotations

import json
import re
from datetime import date

import pytest

from csa.sources import pokemon_championships as pc
from csa.sources import swu_calendar as swu
from csa.sources import yugioh_events as ygo
from conftest import FIXTURES
from source_helpers import TODAY, fixture_site, harvest_rows, replace_in, run, store_rows

# ---------------------------------------------------------------- Pokemon Championships


def test_pokemon_championships_reads_the_north_american_events(sroot):
    site = fixture_site("pokemon_championships")
    res, rows = run(sroot, "pokemon_championships", site)
    assert res.status == "ok" and res.skipped == 0
    assert [r["venue"]["city"] for r in rows] == ["Las Vegas", "Atlanta", "Seattle", "San Antonio", "Toronto", "Milwaukee", "San Diego"]
    lv = rows[0]
    assert lv["name"] == "Las Vegas Pokémon Regional Championships"
    assert lv["event_type"] == "tournament" and lv["sells"]["tcg"] == ["pokemon"]
    assert [d["date"] for d in lv["days"]] == ["2026-12-04", "2026-12-05", "2026-12-06"]
    assert lv["venue"]["name"] == "Las Vegas Convention Center"  # the hall detail in brackets is left off
    assert (lv["venue"]["region"], lv["venue"]["country"]) == ("NV", "US")
    assert lv["admission"]["adult"] == 20 and lv["admission"]["currency"] == "USD" and lv["admission"]["free"] is False
    assert "Pokémon GO $40" in lv["admission"]["notes"] and "Spectator pass $20" in lv["admission"]["notes"]
    assert lv["organizer"] == {"name": "Gaming Generations", "url": "https://gaminggenerations.com/"}
    assert lv["links"]["official"] == "https://www.trainerchampionships.com/event/las-vegas-2027/"
    assert lv["verification"] == "listed"
    assert lv["sources"][0]["source"] == "pokemon_championships"
    # robots.txt was read, and only North American pages were fetched (no Mexico, no Europe)
    fetched = " ".join(site.requests)
    assert "/robots.txt" in fetched and "puebla" not in fetched and "stuttgart" not in fetched
    assert sum("/event/" in u and u.endswith("/") for u in site.requests) == 7


def test_the_toronto_card_names_the_wrong_country_but_the_page_decides(sroot):
    cards = pc.parse_cards((FIXTURES / "pokemon_championships/events/index.html").read_text(encoding="utf-8"))
    assert any(c["url"].endswith("/toronto-2027/") and c["region"] == "north-america" for c in cards)
    html = (FIXTURES / "pokemon_championships/events/index.html").read_text(encoding="utf-8")
    card = html[html.index('data-title="toronto 2027"'):]
    card = card[:card.index("<!-- /Event Card -->")]
    assert "United States" in card and "Canada" not in card  # the list page says the wrong country for Toronto
    res, rows = run(sroot, "pokemon_championships", fixture_site("pokemon_championships"))
    toronto = next(r for r in rows if r["venue"]["city"] == "Toronto")
    assert (toronto["venue"]["region"], toronto["venue"]["country"]) == ("ON", "CA")
    assert toronto["admission"]["currency"] == "USD"  # the page states US dollars, so that is what is kept


def test_a_mexican_page_is_left_out_without_a_fuss():
    html = (FIXTURES / "pokemon_championships/event/toronto-2027/index.html").read_text(encoding="utf-8")
    notes = []
    rec, why = pc.parse_event_page(html.replace("Toronto, Canada", "Puebla, Mexico"), "u", notes.append)
    assert rec is None and why == "skip" and notes == []


def test_a_page_without_dates_yet_is_skipped_with_a_note():
    html = (FIXTURES / "pokemon_championships/event/toronto-2027/index.html").read_text(encoding="utf-8")
    html = html.replace("April 2–4, 2027", "Dates coming soon")
    notes = []
    rec, why = pc.parse_event_page(html, "https://x.example/event/toronto-2027/", notes.append)
    assert rec is None and why == "skip" and "no dates with a year" in notes[0]


def test_the_fee_list_is_read_by_label_and_amount():
    html = (FIXTURES / "pokemon_championships/event/atlanta-2027/index.html").read_text(encoding="utf-8")
    fees = pc.parse_fees(html)
    assert ("Spectator", 20, "USD") in fees and ("Pokémon TCG & VG Master", 80, "USD") in fees and len(fees) == 4


def test_pokemon_championships_sitemap_lists_english_pages_only():
    urls = pc.parse_sitemap((FIXTURES / "pokemon_championships/event-sitemap.xml").read_text())
    assert len(urls) == 38 and all("/es/" not in u and "/pt/" not in u for u in urls)
    assert "https://www.trainerchampionships.com/event/las-vegas-2027/" in urls


@pytest.mark.parametrize("what, edit, expect", [
    ("the sitemap has no event pages", lambda f: (f / "event-sitemap.xml").write_text("<urlset></urlset>"), "no longer looks as expected"),
    ("the list page has no event cards", lambda f: replace_in(f / "events/index.html", 'class="card-event"', 'class="tile"'), "event cards"),
])
def test_pokemon_championships_stops_loudly_when_the_site_changes(sroot, tmp_path, what, edit, expect):
    good, _ = run(sroot, "pokemon_championships", fixture_site("pokemon_championships"))
    before = (sroot / "data/harvest/pokemon_championships.jsonl").read_text()
    res, _ = run(sroot, "pokemon_championships", fixture_site("pokemon_championships", tmp_path, edit), refresh=True)
    assert res.status == "error" and expect in res.message, what
    assert "last good file was kept" in res.message
    assert (sroot / "data/harvest/pokemon_championships.jsonl").read_text() == before


def test_pokemon_championships_stops_when_no_event_page_has_its_heading(sroot, tmp_path):
    def edit(f):
        for page in (f / "event").glob("*/index.html"):
            page.write_text(page.read_text(encoding="utf-8").replace("<h1>", "<h4>").replace("</h1>", "</h4>"), encoding="utf-8")
    res, rows = run(sroot, "pokemon_championships", fixture_site("pokemon_championships", tmp_path, edit))
    assert res.status == "error" and "7 North American pages" in res.message and not rows


# ---------------------------------------------------------------- Yu-Gi-Oh! events

def test_yugioh_events_keeps_in_person_us_and_canada_only(sroot):
    site = fixture_site("yugioh_events")
    res, rows = run(sroot, "yugioh_events", site)
    assert res.status == "ok" and res.records == 2
    assert [r["name"] for r in rows] == ["Yu-Gi-Oh! Championship Series Houston", "Yu-Gi-Oh! Championship Series Orlando"]
    orlando = rows[1]
    assert [d["date"] for d in orlando["days"]] == ["2026-11-06", "2026-11-07", "2026-11-08"]
    assert orlando["venue"] == {"name": "Orange County Convention Center", "address": "9800 International Dr.", "city": "Orlando",
                                "region": "FL", "postal": "32819", "country": "US"}
    assert orlando["event_type"] == "tournament" and orlando["sells"]["tcg"] == ["yugioh"]
    assert orlando["links"]["official"] == "https://www.yugioh-card.com/en/events-item/2026-ycs-orlando/"
    assert orlando["verification"] == "organizer_confirmed"  # Konami's page about Konami's own event
    # no Remote Duel page, no Santiago, Lima, Santo Domingo or Veracruz page was fetched
    asked = " ".join(site.requests)
    assert "rdycs" not in asked and "santiago" not in asked and "lima" not in asked and "veracruz" not in asked


def test_yugioh_names_lose_the_state_and_the_year():
    assert ygo.event_name("Yu-Gi-Oh! Championship Series Orlando, Florida 2026") == "Yu-Gi-Oh! Championship Series Orlando"
    assert ygo.event_name("Yu-Gi-Oh! Championship Series Santo Domingo, Dominican Republic 2027") == "Yu-Gi-Oh! Championship Series Santo Domingo"
    assert ygo.event_name("Special Event 2026") == "Special Event"


def test_a_country_called_georgia_is_not_the_state():
    html = (FIXTURES / "yugioh_events/en/events/index.html").read_text(encoding="utf-8")
    assert ygo.CITY_STATE.match("Orlando, FL") and not ygo.CITY_STATE.match("Tbilisi, Georgia")
    assert len(ygo.parse_listing(html)) == 8


def test_yugioh_stops_when_the_upcoming_table_is_gone(sroot, tmp_path):
    edit = lambda f: replace_in(f / "en/events/index.html", 'id="upcoming"', 'id="soon"')
    res, rows = run(sroot, "yugioh_events", fixture_site("yugioh_events", tmp_path, edit))
    assert res.status == "error" and "Upcoming Events" in res.message and not rows


def test_yugioh_stops_when_an_event_page_has_no_location_block(sroot, tmp_path):
    run(sroot, "yugioh_events", fixture_site("yugioh_events"))
    before = (sroot / "data/harvest/yugioh_events.jsonl").read_text()
    edit = lambda f: replace_in(f / "en/events-item/2026-ycs-orlando/index.html", "DATES &amp; LOCATION", "WHEN AND WHERE")
    res, _ = run(sroot, "yugioh_events", fixture_site("yugioh_events", tmp_path, edit), refresh=True)
    assert res.status == "error" and "DATES & LOCATION" in res.message
    assert (sroot / "data/harvest/yugioh_events.jsonl").read_text() == before


# ---------------------------------------------------------------- Star Wars Unlimited calendar

def test_swu_calendar_splits_tournaments_from_store_events(sroot):
    site = fixture_site("swu_calendar")
    res, _ = run(sroot, "swu_calendar", site)
    assert res.status == "ok"
    rows = harvest_rows(sroot, "swu_calendar") + store_rows(sroot, "swu_calendar")
    tournaments = [r for r in rows if r["event_type"] == "tournament"]
    stores = [r for r in rows if r["event_type"] == "store_event"]
    assert [t["name"] for t in tournaments] == [
        "Star Wars Unlimited Sector Qualifier Indianapolis", "Star Wars Unlimited Sector Qualifier Fort Worth",
        "Star Wars Unlimited Sector Qualifier Baltimore", "Star Wars Unlimited Sector Qualifier Minneapolis"]
    baltimore = tournaments[2]
    assert baltimore["venue"] == {"name": "Baltimore Convention Center", "city": "Baltimore", "region": "MD", "country": "US"}
    assert [d["date"] for d in baltimore["days"]] == ["2026-11-07", "2026-11-08"]
    assert baltimore["links"]["official"] == "https://swuqualifiers.com/"
    assert len(stores) >= 80 and all(s["days"][-1]["date"] >= "2026-10-21" for s in stores)  # old rounds are dropped
    assert all(s["venue"]["country"] in ("US", "CA") for s in rows)
    assert all(s["sells"]["tcg"] == ["swu"] for s in rows)
    assert not any("Mexico" in json.dumps(s) or s["venue"]["country"] == "MX" for s in rows)


def test_swu_planetary_qualifier_places_are_cleaned(sroot):
    run(sroot, "swu_calendar", fixture_site("swu_calendar"))
    stores = store_rows(sroot, "swu_calendar")
    # the city column sometimes carries the state ('Lincoln, NE'); the region column spells names out ('PEI', 'Texas')
    assert not any("," in s["venue"]["city"] for s in stores)
    assert {"QC", "AB", "ON"} <= {s["venue"]["region"] for s in stores}
    assert all(re.fullmatch(r"[A-Z]{2}", s["venue"]["region"]) for s in stores)
    first = stores[0]
    assert first["name"].startswith("Star Wars Unlimited Planetary Qualifier at ")
    assert first["links"]["official"].startswith("https://starwarsunlimited.com/search?store=")


def test_swu_place_reader():
    assert swu.place({"city": "Lincoln, NE", "region": "Nebraska", "country": "USA"}) == ("Lincoln", "NE", "US")
    assert swu.place({"city": "Charlottetown", "region": "PEI", "country": "Canada"}) == ("Charlottetown", "PE", "CA")
    assert swu.place({"city": "Baltimore", "statecountry": "MD, USA"}) == ("Baltimore", "MD", "US")
    assert swu.place({"city": "Utrecht", "statecountry": "Netherlands"}) is None
    assert swu.place({"city": "Leon", "region": "Guanajuato", "country": "Mexico"}) is None


def test_swu_stops_loudly_when_a_column_is_renamed(sroot, tmp_path):
    run(sroot, "swu_calendar", fixture_site("swu_calendar"))
    before = (sroot / "data/harvest/swu_calendar.jsonl").read_text()

    def edit(f):
        page = f / "organized-play-calendar.html"
        page.write_text(page.read_text(encoding="utf-8").replace("<strong>Date</strong>", "<strong>When</strong>"), encoding="utf-8")
    res, _ = run(sroot, "swu_calendar", fixture_site("swu_calendar", tmp_path, edit), refresh=True)
    assert res.status == "error" and "'date' column" in res.message
    assert (sroot / "data/harvest/swu_calendar.jsonl").read_text() == before


def test_swu_stops_when_the_accordions_are_gone(sroot, tmp_path):
    edit = lambda f: replace_in(f / "organized-play-calendar.html", 'class="text-left"', 'class="heading"')
    res, rows = run(sroot, "swu_calendar", fixture_site("swu_calendar", tmp_path, edit))
    assert res.status == "error" and "Planetary Qualifiers" in res.message and not rows


def test_swu_past_store_rounds_come_back_when_today_is_earlier(sroot):
    run(sroot, "swu_calendar", fixture_site("swu_calendar"), today=date(2026, 8, 1))
    early = store_rows(sroot, "swu_calendar")
    run(sroot, "swu_calendar", fixture_site("swu_calendar"), today=TODAY, refresh=True)
    late = store_rows(sroot, "swu_calendar")
    assert len(early) > len(late)
