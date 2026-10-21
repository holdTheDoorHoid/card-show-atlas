from __future__ import annotations

import csv
import io
import json
from datetime import date, timedelta

import httpx
import pytest

from csa import geocode
from csa.geocode import GeoCache, PostalTable, Services, fill_from_cache, rung_keys, run_geocode
from csa.http import FetchError
from csa.model import complete_show
from csa.paths import Paths
from conftest import Site, read_jsonl_file, write_jsonl_file

TODAY = date(2026, 10, 21)

EDISON = (40.5009, -74.3482)
NOMINATIM_HOUSE = [{"lat": "40.5187", "lon": "-74.3518", "place_rank": 30, "category": "building"}]
NOMINATIM_TOWN = [{"lat": "40.5187", "lon": "-74.4121", "place_rank": 16, "category": "boundary"}]


def mk(sid="s-2026-11-14", name="Hall", address="97 Sunfield Ave", city="Edison", region="NJ", postal="08837", country="US", **venue):
    return complete_show({"id": sid, "series_id": "s", "name": "S", "days": [{"date": "2026-11-14"}],
                          "venue": {"name": name, "address": address, "city": city, "region": region, "postal": postal,
                                    "country": country, **venue}})


class FakeServices:
    """Stand in for the two APIs and remember how often each was asked."""

    def __init__(self, census=None, nominatim=None):
        self.census_answers = census or {}
        self.nominatim_answers = nominatim or []
        self.census_calls: list[list] = []
        self.nominatim_calls: list[dict] = []

    def services(self) -> Services:
        def census_batch(items):
            self.census_calls.append([k for k, _ in items])
            return {k: self.census_answers[v["address"]] for k, v in items if v["address"] in self.census_answers}

        def nominatim(params):
            self.nominatim_calls.append(params)
            for matcher, result in self.nominatim_answers:
                if matcher(params):
                    if isinstance(result, Exception):
                        raise result
                    return result
            return []
        return Services(census_batch, nominatim)


def setup(root, shows, postal=None):
    paths = Paths(root)
    write_jsonl_file(paths.shows, shows)
    if postal:
        paths.postal_dir.mkdir(parents=True)
        (paths.postal_dir / "US.json").write_text(json.dumps(postal.get("US", {})))
        (paths.postal_dir / "CA.json").write_text(json.dumps(postal.get("CA", {})))
    return paths


def venue_of(paths, i=0):
    return read_jsonl_file(paths.shows)[i]["venue"]


def test_us_addresses_go_to_the_census_geocoder_in_one_batch(root):
    paths = setup(root, [mk("a-2026-11-14"), mk("b-2026-11-15", address="5 Other St"), mk("c-2026-11-16")])  # a and c share a venue
    fake = FakeServices(census={"97 Sunfield Ave": EDISON, "5 Other St": (40.52, -74.40)})
    rep = run_geocode(paths, fake.services(), TODAY)
    assert len(fake.census_calls) == 1 and len(fake.census_calls[0]) == 2  # two distinct addresses, asked once
    assert fake.nominatim_calls == []
    assert venue_of(paths) == {**venue_of(paths), "lat": EDISON[0], "lon": EDISON[1], "geo_precision": "address"}
    assert rep.resolved == {"address": 3} and rep.unresolved == 0 and rep.census_asked == 2


def test_everything_is_cached_so_a_second_run_asks_nobody(root):
    paths = setup(root, [mk()])
    fake = FakeServices(census={"97 Sunfield Ave": EDISON})
    run_geocode(paths, fake.services(), TODAY)
    cache = json.loads(paths.geocache.read_text())
    assert any(v.get("by") == "census" for v in cache.values())
    write_jsonl_file(paths.shows, [mk()])  # as if merge had rebuilt the file without coordinates
    again = FakeServices()
    run_geocode(paths, again.services(), TODAY)
    assert again.census_calls == [] and again.nominatim_calls == []
    assert venue_of(paths)["lat"] == EDISON[0]


def test_the_cache_is_stable_text_so_it_diffs_cleanly(root):
    paths = setup(root, [mk(), mk("b-2026-11-15", address="5 Other St", name="Other")])
    run_geocode(paths, FakeServices(census={"97 Sunfield Ave": EDISON, "5 Other St": (40.52, -74.4)}).services(), TODAY)
    first = paths.geocache.read_text()
    keys = list(json.loads(first))
    assert keys == sorted(keys)
    assert first.endswith("\n")


def test_census_misses_and_canada_use_nominatim(root):
    shows = [mk("us-2026-11-14", address="1 Missing St"),
             mk("ca-2026-11-14", name="Metro Centre", address="255 Front St W", city="Toronto", region="ON", postal="M5V 2W6", country="CA")]
    paths = setup(root, shows)
    toronto = [{"lat": "43.6443", "lon": "-79.3858", "place_rank": 30}]
    fake = FakeServices(nominatim=[(lambda p: p.get("street") == "1 Missing St", NOMINATIM_HOUSE),
                                   (lambda p: p.get("street") == "255 Front St W", toronto)])
    run_geocode(paths, fake.services(), TODAY)
    assert len(fake.census_calls) == 1 and len(fake.census_calls[0]) == 1   # only the US address went to the Census
    ca_params = next(p for p in fake.nominatim_calls if p.get("street") == "255 Front St W")
    assert ca_params["countrycodes"] == "ca" and ca_params["state"] == "Ontario" and ca_params["postalcode"] == "M5V 2W6"
    assert venue_of(paths, 0)["geo_precision"] == "address" and venue_of(paths, 1)["lat"] == 43.6443
    assert read_jsonl_file(paths.shows)[1]["timezone"] == "America/Toronto"


def test_the_ladder_goes_address_then_venue_then_postal_then_city(root):
    paths = setup(root, [mk("a-2026-11-14", address="1 Nope St", name="Findable Hall"),
                         mk("b-2026-11-15", address="2 Nope St", name="Unknown Hall", postal="08837"),
                         mk("c-2026-11-16", address=None, name=None, postal="99999", city="Edison")],
                  postal={"US": {"08837": [40.519, -74.352]}})
    fake = FakeServices(nominatim=[
        (lambda p: p.get("q", "").startswith("Findable Hall"), NOMINATIM_HOUSE),
        (lambda p: p.get("city") == "Edison" and "q" not in p and "street" not in p, NOMINATIM_TOWN)])
    run_geocode(paths, fake.services(), TODAY)
    precisions = [r["venue"]["geo_precision"] for r in read_jsonl_file(paths.shows)]
    assert precisions == ["venue", "postal", "city"]
    b = read_jsonl_file(paths.shows)[1]["venue"]
    assert (b["lat"], b["lon"]) == (40.519, -74.352)


def test_a_town_level_hit_is_not_accepted_as_an_address(root):
    paths = setup(root, [mk(name=None)])
    fake = FakeServices(nominatim=[(lambda p: "street" in p, NOMINATIM_TOWN), (lambda p: "street" not in p, NOMINATIM_TOWN)])
    run_geocode(paths, fake.services(), TODAY)
    assert venue_of(paths)["geo_precision"] == "city"


def test_results_outside_the_stated_state_are_refused(root):
    paths = setup(root, [mk(name=None)])
    los_angeles = [{"lat": "34.05", "lon": "-118.24", "place_rank": 30}]
    fake = FakeServices(census={"97 Sunfield Ave": (34.05, -118.24)}, nominatim=[(lambda p: True, los_angeles)])
    rep = run_geocode(paths, fake.services(), TODAY)
    assert venue_of(paths)["lat"] is None and rep.unresolved == 1


def test_misses_are_remembered_and_retried_after_sixty_days(root):
    paths = setup(root, [mk(postal=None, name=None)])
    fake = FakeServices()
    run_geocode(paths, fake.services(), TODAY)
    first = len(fake.nominatim_calls)
    assert first >= 2 and all(v.get("miss") for v in json.loads(paths.geocache.read_text()).values())
    run_geocode(paths, fake.services(), TODAY + timedelta(days=10))
    assert len(fake.nominatim_calls) == first                       # remembered
    run_geocode(paths, fake.services(), TODAY + timedelta(days=61))
    assert len(fake.nominatim_calls) > first                       # old misses are tried again


def test_a_failing_service_leaves_no_false_misses_and_stops_early(root):
    paths = setup(root, [mk(f"s{i}-2026-11-14", address=f"{i} Fail St", name=f"Hall {i}", postal=None) for i in range(10)])
    fake = FakeServices(nominatim=[(lambda p: True, FetchError("service down"))])
    run_geocode(paths, fake.services(), TODAY)
    assert len(fake.nominatim_calls) <= 6            # gave up after a few failures in a row
    assert not paths.geocache.read_text().strip("{}\n ")  # nothing was recorded as "not found"


def test_the_nominatim_budget_can_be_limited(root):
    paths = setup(root, [mk(f"s{i}-2026-11-14", address=f"{i} Some St", name=f"Hall {i}", postal=None) for i in range(10)])
    fake = FakeServices()
    run_geocode(paths, fake.services(), TODAY, limit=3)
    assert len(fake.nominatim_calls) == 3


def test_source_supplied_coordinates_are_left_alone(root):
    show = mk(lat=40.0, lon=-74.0, geo_precision="address")
    paths = setup(root, [show])
    fake = FakeServices(census={"97 Sunfield Ave": EDISON})
    run_geocode(paths, fake.services(), TODAY)
    assert fake.census_calls == [] and venue_of(paths)["lat"] == 40.0
    assert read_jsonl_file(paths.shows)[0]["timezone"] == "America/New_York"


def test_coarse_coordinates_are_upgraded_when_a_better_answer_exists(root):
    paths = setup(root, [mk(lat=40.5, lon=-74.4, geo_precision="postal")])
    fake = FakeServices(census={"97 Sunfield Ave": EDISON})
    run_geocode(paths, fake.services(), TODAY)
    assert venue_of(paths)["geo_precision"] == "address" and venue_of(paths)["lat"] == EDISON[0]


def test_time_zones_come_from_coordinates(root):
    cases = {"NJ": (40.5, -74.3, "America/New_York"), "BC": (49.28, -123.12, "America/Vancouver"),
             "AZ": (33.45, -112.07, "America/Phoenix"), "HI": (21.3, -157.85, "Pacific/Honolulu"), "TX": (31.76, -106.49, "America/Denver")}
    shows = [mk(f"{r}-2026-11-14", region=r, country="CA" if r == "BC" else "US", lat=v[0], lon=v[1], geo_precision="address")
             for r, v in cases.items()]
    paths = setup(root, shows)
    rep = run_geocode(paths, FakeServices().services(), TODAY)
    got = {r["venue"]["region"]: r["timezone"] for r in read_jsonl_file(paths.shows)}
    assert got == {r: v[2] for r, v in cases.items()} and rep.timezones_filled == 5


def test_an_existing_time_zone_is_never_replaced(root):
    show = mk(lat=40.5, lon=-74.3, geo_precision="address")
    show["timezone"] = "America/Chicago"
    paths = setup(root, [show])
    run_geocode(paths, FakeServices().services(), TODAY)
    assert read_jsonl_file(paths.shows)[0]["timezone"] == "America/Chicago"


def test_store_events_are_geocoded_too(root):
    paths = setup(root, [])
    write_jsonl_file(paths.store_events, [mk("fnm-2026-10-23")])
    run_geocode(paths, FakeServices(census={"97 Sunfield Ave": EDISON}).services(), TODAY)
    assert read_jsonl_file(paths.store_events)[0]["venue"]["lat"] == EDISON[0]


def test_census_is_asked_in_chunks(root, monkeypatch):
    # chunking lives in make_services, so exercise it through a mock transport
    monkeypatch.setattr(geocode, "CENSUS_CHUNK", 2)
    seen = []

    def handler(request: httpx.Request):
        seen.append(request.content)
        return httpx.Response(200, text="")
    services, clients = geocode.make_services(httpx.MockTransport(handler), sleep=lambda s: None)
    items = [(f"addr|US|{i}", {"address": f"{i} Main St", "city": "Edison", "region": "NJ", "postal": "08837"}) for i in range(5)]
    services.census_batch(items)
    assert len(seen) == 3
    for c in clients:
        c.close()


# ---------------------------------------------------------------- the real HTTP shapes

CENSUS_REPLY = ('"{id1}","97 Sunfield Ave, Edison, NJ, 08837","Match","Exact","97 SUNFIELD AVE, EDISON, NJ, 08837","-74.348193159568,40.500954647068","60298155","R"\n'
                '"{id2}","1 Main St, Media, PA, 19063","No_Match"\n')


def test_census_batch_request_and_reply_formats():
    k1, k2 = "addr|US|97 sunfield ave|edison|nj|08837", "addr|US|1 main st|media|pa|19063"
    requests = []

    def handler(request: httpx.Request):
        requests.append(request)
        return httpx.Response(200, text=CENSUS_REPLY.format(id1=geocode.key_id(k1), id2=geocode.key_id(k2)))
    services, clients = geocode.make_services(httpx.MockTransport(handler), sleep=lambda s: None)
    got = services.census_batch([(k1, {"address": "97 Sunfield Ave", "city": "Edison", "region": "NJ", "postal": "08837"}),
                                 (k2, {"address": "1 Main St", "city": "Media", "region": "PA", "postal": "19063"})])
    assert got == {k1: (40.500954647068, -74.348193159568)}      # the reply is longitude first; we return (lat, lon)
    req = requests[0]
    assert req.method == "POST" and str(req.url) == "https://geocoding.geo.census.gov/geocoder/locations/addressbatch"
    body = req.content.decode()
    assert 'name="benchmark"' in body and "Public_AR_Current" in body and 'name="addressFile"' in body
    assert f'{geocode.key_id(k1)},97 Sunfield Ave,Edison,NJ,08837' in body
    assert req.headers["user-agent"].startswith("CardShowAtlas/0.1 (+https://github.com/holdTheDoorHoid/card-show-atlas)")
    for c in clients:
        c.close()


def test_nominatim_is_asked_once_a_second_with_our_user_agent_and_without_robots():
    site = Site({"/search": httpx.Response(200, json=NOMINATIM_HOUSE)}, robots="User-agent: *\nDisallow: /search\n")
    t = {"now": 1000.0, "sleeps": []}

    def sleep(s):
        t["sleeps"].append(s)
        t["now"] += s
    services, clients = geocode.make_services(site.transport(), sleep=sleep, clock=lambda: t["now"])
    for i in range(3):
        assert services.nominatim({"street": f"{i} Main St", "city": "Edison", "state": "New Jersey"})[0]["lat"] == "40.5187"
    assert "/robots.txt" not in site.log                    # an API with a usage policy, not a crawl
    assert len(site.log) == 3 and all("format=jsonv2" in p and "limit=1" in p for p in site.log)
    assert sum(t["sleeps"]) >= 2.0                          # two waits of a second between three requests
    assert all(h["user-agent"].startswith("CardShowAtlas/0.1 (+https://github.com/holdTheDoorHoid/card-show-atlas)") for h in site.headers_seen)
    for c in clients:
        c.close()


def test_rung_keys_and_postal_lookups():
    v = {"name": "Hall", "address": "97 Sunfield Ave", "city": "Edison", "region": "NJ", "postal": "08837", "country": "US"}
    keys = rung_keys(v)
    assert keys["address"] == "addr|US|97 sunfield ave|edison|nj|08837" and keys["venue"] == "venue|US|hall|edison|nj"
    assert keys["postal"] == "postal|US|08837" and keys["city"] == "city|US|edison|nj"
    assert rung_keys({"city": "Edison", "region": "NJ"})["address"] is None
    pt = PostalTable({"08837": [40.519, -74.352]}, {"M5V": [43.641, -79.393]})
    assert pt.lookup("US", "08837-1234") == (40.519, -74.352)
    assert pt.lookup("CA", "m5v 2w6") == (43.641, -79.393)
    assert pt.lookup("US", None) is None and pt.lookup("CA", "H0H 0H0") is None


def test_merge_side_fill_never_uses_the_network_and_waits_for_the_geocoder(root):
    cache = GeoCache(root / "data" / "geocache.json", TODAY)
    postal = PostalTable({"08837": [40.519, -74.352]})
    s = mk()
    assert fill_from_cache(s, cache, postal) is False and s["venue"]["lat"] is None      # address not tried yet: do not guess a postal centre
    cache.miss(rung_keys(s["venue"])["address"])
    cache.miss(rung_keys(s["venue"])["venue"])
    assert fill_from_cache(s, cache, postal) is True
    assert (s["venue"]["lat"], s["venue"]["geo_precision"], s["timezone"]) == (40.519, "postal", "America/New_York")
    s2 = mk()
    cache.hit(rung_keys(s2["venue"])["address"], *EDISON, "census")
    fill_from_cache(s2, cache, postal)
    assert s2["venue"]["geo_precision"] == "address"
