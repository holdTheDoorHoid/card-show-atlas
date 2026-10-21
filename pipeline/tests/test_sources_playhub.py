"""Offline tests for lorcana_playhub and riftbound_locator (they share csa/sources/_playhub.py).

tests/fixtures/lorcana_playhub/ and riftbound_locator/ hold real answers from the API on 2026-10-21: the
Lorcana events are a spread of 16 chosen from the real lists (weekly play, Set Championships, Canada, Mexico,
a Set Championship moved to another town), the Riftbound events are the whole list as it was. Store e-mail
addresses, image links (which carry signatures) and descriptions were taken out.
"""

from __future__ import annotations

import json

import httpx
import pytest

from csa.sources import _playhub as ph
from csa.sources import lorcana_playhub, riftbound_locator
from conftest import FIXTURES
from source_helpers import Router, TODAY, json_response, run

LORCANA = FIXTURES / "lorcana_playhub"
RIFTBOUND = FIXTURES / "riftbound_locator"
API = "/hydraproxy/api/v2"


def lorcana_site(pages=None, extra=None):
    """The fake Play Hub API: the Philadelphia circle gets the fixture pages, the other circles find nothing."""
    pages = pages or [json.loads((LORCANA / f"events_page{n}.json").read_text()) for n in (1, 2)]

    def answer(request: httpx.Request) -> httpx.Response:
        q = request.url.params
        if request.url.path == API + "/event-configuration-templates/":
            return json_response(json.loads((LORCANA / "templates.json").read_text()))
        if request.url.path == API + "/events/quick-filters/":
            return json_response(json.loads((LORCANA / "quick_filters.json").read_text()))
        if request.url.path == API + "/events/":
            assert q["game_slug"] == "disney-lorcana" and q["page_size"] == "250" and q["display_statuses"] == "upcoming"
            assert q["start_date_after"] == "2026-10-21T00:00:00Z"
            if q["latitude"] != "39.95":
                return json_response({"count": 0, "next_page_number": None, "results": []})
            return json_response(pages[int(q["page"]) - 1])
        return extra(request) if extra else httpx.Response(404)
    return Router(answer)


def test_lorcana_splits_tournaments_from_nearby_store_events(sroot):
    site = lorcana_site()
    res, rows = run(sroot, "lorcana_playhub", site)
    assert res.status == "ok" and res.skipped == 0
    tournaments = [r for r in rows if r["event_type"] == "tournament"]
    stores = [r for r in rows if r["event_type"] == "store_event"]
    assert len(tournaments) == 2 and len(stores) == 7
    # weekly play within 21 days is a store event; Canada counts, Mexico does not
    assert {r["venue"]["country"] for r in rows} == {"US", "CA"}
    assert all(r["days"][0]["date"] <= "2026-12-05" for r in stores)
    # Set Championships in January: only the two with room for 128 or more are tournaments. The 64 player ones held in
    # card shops, and every smaller one, are shop events, and January is beyond the 21 day window for those.
    assert sorted(t["size"]["players"] for t in tournaments) == [150, 262]
    assert all(t["days"][0]["date"].startswith("2027-01") for t in tournaments)
    assert not any(r["days"][0]["date"].startswith("2027-01") for r in stores)
    assert {r["venue"]["city"] for r in tournaments} >= {"Louisville"}  # the API writes it LOUISVILLE
    louisville = next(t for t in tournaments if t["venue"]["city"] == "Louisville")
    # one player had signed up for 150 places: too early to say anything about the crowd, so the places are used
    assert louisville["size"]["players"] == 150 and louisville["admission"]["notes"].endswith("150 places, 1 registered so far.")
    assert all(r["sells"]["tcg"] == ["lorcana"] and r["verification"] == "listed" for r in rows)
    assert all(r["links"]["official"].startswith("https://tcg.ravensburgerplay.com/events/") for r in rows)
    assert sorted(r["sources"][0]["source"] for r in rows) == ["lorcana_playhub"] * len(rows)


def test_lorcana_keeps_no_store_contacts(sroot):
    _, rows = run(sroot, "lorcana_playhub", lorcana_site())
    text = (sroot / "data/harvest/lorcana_playhub.jsonl").read_text()
    assert "@" not in text and "REDACTED" not in text and "email" not in text.lower() and "phone" not in text.lower()
    for r in rows:
        assert not (r.get("organizer") or {}).get("url", "") or "facebook" not in r["organizer"]["url"]


def test_lorcana_times_are_local_and_players_say_where_they_come_from(sroot):
    _, rows = run(sroot, "lorcana_playhub", lorcana_site())
    by_name = {r["name"]: r for r in rows}
    # 17:00 UTC on Oct 21 is 13:00 in New York (summer time) and 10:00 in Vancouver; the end time is only an estimate, so it is not kept
    assert by_name["Wednesday afternoon weekly play"]["days"] == [{"date": "2026-10-21", "open": "13:00", "close": None}]
    assert by_name["Wednesday afternoon weekly play"]["timezone"] == "America/New_York"
    assert by_name["Daily Free Play at OCG"]["days"][0]["open"] == "10:00" and by_name["Daily Free Play at OCG"]["venue"]["region"] == "BC"
    # 18:00 UTC in January is 11:00 in Denver (winter time)
    assert next(r for r in rows if r["links"]["official"].endswith("/1208045"))["days"][0] == {"date": "2027-01-16", "open": "11:00", "close": None}
    weekly = by_name["Wednesday afternoon weekly play"]
    assert weekly["venue"]["lat"] and weekly["venue"]["geo_precision"] == "address"
    assert weekly["admission"]["notes"] == "Player entry fee $10. 12 places, none registered yet." and weekly["size"]["players"] == 12
    assert by_name["Daily Free Play at OCG"]["admission"]["notes"] == "No player entry fee. 48 places, none registered yet."
    assert all(r["admission"]["notes"].endswith(".") for r in rows)


def test_an_event_moved_to_another_town_is_placed_at_the_new_address_and_not_under_the_stores_name():
    ev = next(e for e in json.loads((LORCANA / "events_page2.json").read_text())["results"] if e["id"] == 1208045)
    at_store = ph.convert(ev, lorcana_playhub.GAME, TODAY, set())
    moved = ph.convert({**ev, "full_address": "1520 S Fort Hood St, Killeen, TX 76542, USA", "latitude": 31.1, "longitude": -97.75},
                       lorcana_playhub.GAME, TODAY, set())
    assert at_store["venue"]["name"] == "Noble Inc" and at_store["venue"]["city"] == "Albuquerque"
    assert moved["venue"]["city"] == "Killeen" and moved["venue"]["region"] == "TX" and "name" not in moved["venue"]
    assert moved["organizer"]["name"] == "Noble Inc"  # the shop still runs it


def test_lorcana_request_cap_stops_the_run_and_keeps_the_old_file(sroot, monkeypatch):
    run(sroot, "lorcana_playhub", lorcana_site())
    before = (sroot / "data/harvest/lorcana_playhub.jsonl").read_text()
    monkeypatch.setattr(ph, "MAX_REQUESTS", 3)
    res, _ = run(sroot, "lorcana_playhub", lorcana_site(), refresh=True)
    assert res.status == "error" and "stopped after 3 requests" in res.message
    assert (sroot / "data/harvest/lorcana_playhub.jsonl").read_text() == before


def test_lorcana_asks_politely(sroot):
    waits = []
    site = lorcana_site()
    clock = {"t": 0.0}

    def sleep(s):
        waits.append(s)
        clock["t"] += s
    run(sroot, "lorcana_playhub", site, http_options={"sleep": sleep, "clock": lambda: clock["t"]})
    api_requests = [r for r in site.requests if r.url.host.startswith("api.")]
    assert 4 <= len(api_requests) <= 12
    # at least a second (the registry says 1.2) passed between requests to the same host
    assert min(w for w in waits if w > 0) >= 1.0
    assert len(site.requests) <= 200


def test_each_event_is_kept_once_even_when_two_circles_find_it(sroot):
    pages = [json.loads((LORCANA / f"events_page{n}.json").read_text()) for n in (1, 2)]

    def answer(request: httpx.Request) -> httpx.Response:
        q = request.url.params
        if request.url.path.endswith("/events/"):
            return json_response(pages[int(q["page"]) - 1])  # every circle gets the same two pages
        return json_response([])
    res, rows = run(sroot, "lorcana_playhub", Router(answer))
    assert res.status == "ok" and len(rows) == 9
    assert len({r["links"]["official"] for r in rows}) == 9


def test_lorcana_stops_when_the_answer_changes_shape(sroot):
    def answer(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/events/"):
            return json_response({"events": []})
        return json_response([])
    res, rows = run(sroot, "lorcana_playhub", Router(answer))
    assert res.status == "error" and "results list" in res.message and not rows


def test_lorcana_stops_when_the_event_fields_are_renamed(sroot):
    page = json.loads((LORCANA / "events_page1.json").read_text())
    for e in page["results"]:
        e["start_time"] = e.pop("start_datetime")

    def answer(request: httpx.Request) -> httpx.Response:
        return json_response(page) if request.url.path.endswith("/events/") else json_response([])
    res, _ = run(sroot, "lorcana_playhub", Router(answer))
    assert res.status == "error" and "start_datetime" in res.message


def test_lorcana_works_without_the_template_lists(sroot):
    def extra(request):
        return httpx.Response(500, text="down")
    site = lorcana_site(extra=extra)
    inner = site.answer

    def answer(request):
        if request.url.path.endswith("quick-filters/") or request.url.path.endswith("templates/"):
            return httpx.Response(404, text="gone")
        return inner(request)
    res, rows = run(sroot, "lorcana_playhub", Router(answer))
    assert res.status == "ok" and rows
    assert any("template lists could not be read" in n for n in res.notes)


# ---------------------------------------------------------------- Riftbound

def riftbound_site():
    page = json.loads((RIFTBOUND / "events_page1.json").read_text())

    def answer(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "api.cloudflare.riftbound.uvsgames.com"
        q = request.url.params
        if request.url.path == API + "/events/":
            assert q["game_slug"] == "riftbound"
            return json_response(page if q["latitude"] == "39.95" else {"count": 0, "next_page_number": None, "results": []})
        if request.url.path == API + "/event-configuration-templates/":
            return json_response(json.loads((RIFTBOUND / "templates.json").read_text()))
        return json_response([])
    return Router(answer)


def test_riftbound_reads_the_locator_with_the_same_rules(sroot):
    res, rows = run(sroot, "riftbound_locator", riftbound_site())
    assert res.status == "ok"
    tournaments = [r for r in rows if r["event_type"] == "tournament"]
    stores = [r for r in rows if r["event_type"] == "store_event"]
    assert [t["size"]["players"] for t in sorted(tournaments, key=lambda t: t["days"][0]["date"])] == [129, 543]
    big = max(tournaments, key=lambda t: t["size"]["players"])
    assert big["name"].startswith("CoolStuffCon Orlando 2026") and big["days"][0]["date"] == "2026-10-31"
    assert big["admission"]["notes"] == "Player entry fee $75. 543 players registered of 550 places."
    assert big["links"]["official"] == "https://locator.riftbound.uvsgames.com/events/915913"
    assert big["sells"]["tcg"] == ["riftbound"] and big["organizer"]["name"] == "Cool Stuff Games - Maitland"
    assert len(stores) == 11
    # 16 events listed as upcoming have no start time, and a store's test event is among them
    assert not any("TESTEVENT" in r["name"] for r in rows)
    assert res.records == 2 and res.store_records == 11


def test_riftbound_credit_names_the_locator():
    from csa.sourcesreg import by_id
    from conftest import REPO
    reg = by_id(REPO / "data" / "sources.yaml")
    assert "Ravensburger Play Hub" in reg["lorcana_playhub"]["credit"]
    assert "Riftbound" in reg["riftbound_locator"]["credit"]


# ---------------------------------------------------------------- the pieces

@pytest.mark.parametrize("text, expect", [
    ("13, W Merrick Rd, Freeport, NY, 11520, US", {"address": "13 W Merrick Rd", "city": "Freeport", "region": "NY", "postal": "11520"}),
    ("1520 S Fort Hood St, Killeen, TX 76542, USA", {"address": "1520 S Fort Hood St", "city": "Killeen", "region": "TX", "postal": "76542"}),
    ("8102 Blanding Blvd, unit 12, Jacksonville, FL, 32244, US", {"address": "8102 Blanding Blvd", "city": "Jacksonville", "region": "FL", "postal": "32244"}),
    ("680 Greenbrae Dr suite 223, Sparks, NV 89431, USA", {"address": "680 Greenbrae Dr", "city": "Sparks", "region": "NV", "postal": "89431"}),
    ("1354 Barton St E, Hamilton, ON L8H 2W3, Canada", {"address": "1354 Barton St E", "city": "Hamilton", "region": "ON", "postal": "L8H 2W3"}),
    ("19075 Interstate 45 S Suite# 121E, Shenandoah, TX 77385, USA", {"address": "19075 Interstate 45 S", "city": "Shenandoah", "region": "TX", "postal": "77385"}),
    ("405 North Road #1, Coquitlam, BC V3K 3V9, Canada", {"address": "405 North Road", "city": "Coquitlam", "region": "BC", "postal": "V3K 3V9"}),
    ("207 Bella Vista, 2 PISO, GUADALUPE, N.L., 67130, MX", {}),
    ("", {}),
])
def test_address_reader(text, expect):
    assert ph.parse_address(text) == expect


def test_tournament_rules_and_the_store_window():
    base = {"id": 1, "name": "Spring Showdown", "start_datetime": "2026-12-20T18:00:00+00:00", "timezone": "America/Chicago", "capacity": 20,
            "registered_user_count": 3, "cost_in_cents": 500, "currency": "USD", "full_address": "1 Main St, Austin, TX 78701, USA",
            "event_status": "SCHEDULED", "number_of_days": 1,
            "store": {"name": "Shop", "city": "Austin", "state": "TX", "country": "US", "website": "https://shop.example"}}
    g = lorcana_playhub.GAME
    kind = lambda **kw: (lambda r: r and r["event_type"])(ph.convert({**base, **kw}, g, TODAY, set()))
    assert kind() is None                                        # a weekly event 60 days away is not kept
    assert kind(start_datetime="2026-11-10T18:00:00+00:00") == "store_event"
    assert ph.STORE_WINDOW_DAYS == 21
    assert kind(start_datetime="2026-11-11T18:00:00+00:00") == "store_event"   # the 21st day from the 21st of October
    assert kind(start_datetime="2026-11-12T18:00:00+00:00") is None            # the 22nd day is outside the window
    assert kind(capacity=128) == "tournament"                    # room for 128
    assert kind(capacity=127) is None
    assert kind(is_headlining_event=True, capacity=10) == "tournament"
    assert kind(name="Spring Challenge", capacity=100) == "tournament"
    assert kind(name="Spring Challenge", capacity=99) is None    # a championship in a shop for a few dozen players
    assert kind(event_configuration_template="t1", capacity=110) is None
    assert ph.convert({**base, "event_configuration_template": "t1", "capacity": 110}, g, TODAY, {"t1"})["event_type"] == "tournament"
    assert kind(event_is_online=True, start_datetime="2026-11-10T18:00:00+00:00") is None
    assert kind(start_datetime="2026-10-20T18:00:00+00:00") is None  # already started before today
    assert kind(start_datetime=None) is None
    assert kind(store={**base["store"], "country": "MX"}, start_datetime="2026-11-10T18:00:00+00:00") is None
    cancelled = ph.convert({**base, "start_datetime": "2026-11-10T18:00:00+00:00", "event_status": "CANCELLED"}, g, TODAY, set())
    assert cancelled["status"] == "cancelled"
    # social media pages are not kept as a shop's web address
    t = ph.convert({**base, "capacity": 200, "store": {**base["store"], "website": "https://www.facebook.com/profile.php?id=1"}}, g, TODAY, set())
    assert t["organizer"] == {"name": "Shop", "url": None}


def test_coordinates_outside_the_state_are_dropped():
    ev = {"id": 2, "name": "Weekly", "start_datetime": "2026-10-25T18:00:00+00:00", "timezone": "America/Chicago", "capacity": 10,
          "full_address": "1 Main St, Austin, TX 78701, USA", "latitude": 47.6, "longitude": -122.3,
          "store": {"name": "Shop", "city": "Austin", "state": "TX", "country": "US"}}
    rec = ph.convert(ev, lorcana_playhub.GAME, TODAY, set())
    assert "lat" not in rec["venue"]  # the point is in Washington, not Texas, so the geocoder will place it instead
    rec = ph.convert({**ev, "latitude": 30.27, "longitude": -97.74}, riftbound_locator.GAME, TODAY, set())
    assert rec["venue"]["lat"] == 30.27


def test_the_central_circle_covers_the_continental_us_and_canada():
    from csa.util import haversine_km
    label, lat, lon, miles = ph.CENTERS[0]
    for name, (a, b) in {"Seattle": (47.61, -122.33), "Los Angeles": (34.05, -118.24), "Miami": (25.76, -80.19),
                         "Calgary": (51.05, -114.07), "Vancouver": (49.28, -123.12), "Halifax": (44.65, -63.58),
                         "San Diego": (32.72, -117.16)}.items():
        assert haversine_km(lat, lon, a, b) / 1.609344 <= miles, name


def test_a_weekly_event_with_a_default_sized_capacity_stays_a_store_event():
    ev = {"id": 3, "name": "Sunday Lorcana Showdown", "start_datetime": "2026-10-25T18:00:00+00:00", "timezone": "America/New_York",
          "capacity": 150, "registered_user_count": 0, "full_address": "1 Main St, Louisville, KY 40202, USA",
          "store": {"id": 9, "name": "Shop", "city": "Louisville", "state": "KY", "country": "US"}}
    g = lorcana_playhub.GAME
    assert ph.convert(ev, g, TODAY, set())["event_type"] == "tournament"  # on its own it looks big
    weekly = [{**ev, "id": 10 + i, "name": f"{d} Lorcana Showdown"} for i, d in enumerate(("Sunday", "Monday", "Tuesday"))]
    keys = {k for k, n in __import__("collections").Counter(ph.recurrence_key(e) for e in weekly).items() if n >= ph.RECURRING_MIN}
    assert keys and ph.convert(weekly[0], g, TODAY, set(), keys)["event_type"] == "store_event"
    for name in ("Into the Inkdark Prerelease (Sealed)", "Lorcana League Night", "Open Play"):
        assert ph.convert({**ev, "name": name}, g, TODAY, set())["event_type"] == "store_event", name
    # the platform's own headlining flag overrides the guard
    assert ph.convert({**weekly[0], "is_headlining_event": True}, g, TODAY, set(), keys)["event_type"] == "tournament"


@pytest.mark.parametrize("registered, capacity, days_away, expect", [
    (0, 64, 40, (64, False)), (3, 200, 60, (200, False)), (60, 200, 60, (60, True)), (50, 200, 60, (50, True)),
    (3, 200, 14, (3, True)), (3, 200, 15, (200, False)), (5, 0, 60, (5, True)), (0, 0, 5, (None, False))])
def test_players_are_registrations_only_once_they_say_something(registered, capacity, days_away, expect):
    assert ph.count_players(registered, capacity, days_away) == expect


def test_an_end_time_seconds_after_the_start_is_a_placeholder_and_is_not_kept():
    ev = {"id": 5, "name": "Lorcana Night", "start_datetime": "2026-11-01T17:00:00+00:00", "end_datetime": "2026-11-01T17:00:00+00:00",
          "is_end_datetime_estimated": False, "timezone": "America/Chicago", "capacity": 10, "full_address": "1 Main St, Marshfield, WI 54449, USA",
          "store": {"name": "Shop", "city": "Marshfield", "state": "WI", "country": "US"}}
    g = lorcana_playhub.GAME
    assert ph.convert(ev, g, TODAY, set())["days"] == [{"date": "2026-11-01", "open": "11:00", "close": None}]
    seconds_later = ph.convert({**ev, "end_datetime": "2026-11-01T17:00:53+00:00"}, g, TODAY, set())  # seen on the real API
    assert seconds_later["days"][0]["close"] is None
    later = ph.convert({**ev, "end_datetime": "2026-11-01T21:30:00+00:00"}, g, TODAY, set())
    assert later["days"] == [{"date": "2026-11-01", "open": "11:00", "close": "15:30"}]


def test_a_host_named_by_an_email_address_is_a_person_and_is_left_out():
    """Seen on the real API: a 'store' whose name was an e-mail address, at what looks like a home address."""
    mailbox = "someone" + "@" + "mail.example"  # built here so no mailbox is written into a test file
    ev = {"id": 7, "name": "Weekly Core Constructed", "start_datetime": "2026-10-24T23:00:00+00:00", "timezone": "America/Chicago",
          "capacity": 8, "full_address": "19 Berkshire Drive, Crystal Lake, IL 60014, USA",
          "store": {"id": 1, "name": mailbox, "city": "Crystal Lake", "state": "IL", "country": "US"}}
    g = lorcana_playhub.GAME
    assert ph.convert(ev, g, TODAY, set()) is None
    assert ph.convert({**ev, "store": {**ev["store"], "name": "Call 815 555 0100"}}, g, TODAY, set()) is None
    shop = {**ev, "store": {**ev["store"], "name": "Crystal Lake Games"}, "name": f"Weekly play, sign up at {mailbox}"}
    assert ph.convert(shop, g, TODAY, set())["name"] == "Weekly play, sign up at"
