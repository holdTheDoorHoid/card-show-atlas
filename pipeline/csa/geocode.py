"""Coordinates and time zones.

csa geocode walks a ladder for each venue and stops at the first rung that answers:

  1. address  US Census Geocoder batch API (public domain), then Nominatim for Canada and Census misses
  2. venue    Nominatim search by venue name and town
  3. postal   the centre of the postal code, from the GeoNames files made by `csa postal`
  4. city     Nominatim search for the town

geo_precision records which rung answered (address, venue, postal, city). Every answer, and every
miss, is kept in data/geocache.json, which is committed so a daily run never repeats work.
Nominatim is asked at most once per second with the project's descriptive user agent.

csa merge calls fill_from_cache(), which never touches the network.
"""

from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Callable

import httpx

from . import regions
from .http import FetchError, HttpClient
from .paths import Paths
from .textparse import norm_postal
from .util import norm_text, read_json, read_jsonl, today as today_fn, write_json, write_jsonl

CENSUS_URL = "https://geocoding.geo.census.gov/geocoder/locations/addressbatch"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
MISS_RETRY_DAYS = 60
CENSUS_CHUNK = 1000
LADDER = ("address", "venue", "postal", "city")

_tz_finder = None


def timezone_for(lat: float, lon: float) -> str | None:
    global _tz_finder
    if _tz_finder is None:
        from timezonefinder import TimezoneFinder
        _tz_finder = TimezoneFinder()
    return _tz_finder.timezone_at(lat=lat, lng=lon)


# ---------------------------------------------------------------- cache

class GeoCache:
    def __init__(self, path: Path, today: date):
        self.path = Path(path)
        self.today = today
        self.data: dict[str, dict] = read_json(self.path, {}) or {}
        self.dirty = False

    def get(self, key: str) -> dict | None:
        """The entry, or None when absent or when an old miss is due for another try."""
        entry = self.data.get(key)
        if entry is None:
            return None
        if entry.get("miss"):
            try:
                age = (self.today - date.fromisoformat(entry["on"])).days
            except (KeyError, ValueError):
                age = MISS_RETRY_DAYS
            if age >= MISS_RETRY_DAYS:
                return None
        return entry

    def hit(self, key: str, lat: float, lon: float, by: str) -> None:
        self.data[key] = {"lat": round(lat, 6), "lon": round(lon, 6), "by": by, "on": self.today.isoformat()}
        self.dirty = True

    def miss(self, key: str) -> None:
        self.data[key] = {"miss": True, "on": self.today.isoformat()}
        self.dirty = True

    def save(self) -> None:
        if self.dirty or not self.path.exists():
            write_json(self.path, self.data, indent=0, sort_keys=True)
            self.dirty = False


# ---------------------------------------------------------------- postal table

class PostalTable:
    def __init__(self, us: dict | None = None, ca: dict | None = None):
        self.us = us or {}
        self.ca = ca or {}

    @classmethod
    def load(cls, directory: Path) -> "PostalTable":
        return cls(read_json(Path(directory) / "US.json", {}), read_json(Path(directory) / "CA.json", {}))

    def lookup(self, country: str | None, postal: str | None) -> tuple[float, float] | None:
        if not postal:
            return None
        p = norm_postal(postal) or ""
        if country == "CA":
            hit = self.ca.get(p.replace(" ", "")[:3].upper())
        elif country == "US" or country is None:
            m = re.match(r"\d{5}", p)
            hit = self.us.get(m.group(0)) if m else None
        else:
            hit = None
        return (hit[0], hit[1]) if hit else None


# ---------------------------------------------------------------- keys

def _street(v: dict) -> str:
    return norm_text(v.get("address"))


def rung_keys(v: dict) -> dict[str, str | None]:
    """The cache key for each rung that has enough information to be tried."""
    country = v.get("country") or regions.country_of_region(v.get("region")) or "US"
    city, region = norm_text(v.get("city")), (v.get("region") or "").lower()
    postal = (norm_postal(v.get("postal")) or "").lower()
    keys: dict[str, str | None] = {"address": None, "venue": None, "postal": None, "city": None}
    if _street(v) and (city or postal):
        keys["address"] = f"addr|{country}|{_street(v)}|{city}|{region}|{postal[:6]}"
    if norm_text(v.get("name")) and city:
        keys["venue"] = f"venue|{country}|{norm_text(v.get('name'))}|{city}|{region}"
    if postal:
        keys["postal"] = f"postal|{country}|{postal[:6]}"
    if city and region:
        keys["city"] = f"city|{country}|{city}|{region}"
    return keys


def _inside(v: dict, lat: float, lon: float) -> bool:
    region = v.get("region")
    ok = regions.in_region(lat, lon, region) if region else None
    if ok is None:
        country = v.get("country") or regions.country_of_region(region)
        ok = regions.in_country(lat, lon, country) if country else True
    return bool(ok) if ok is not None else True


def resolve_from_cache(v: dict, cache: GeoCache, postal: PostalTable) -> tuple[tuple[float, float, str] | None, bool]:
    """Walk the ladder using only what is already known.

    Returns (answer or None, complete). complete is False when a rung has no cache entry yet, which
    means the network still has to be asked before the answer can be trusted.
    """
    keys = rung_keys(v)
    country = v.get("country") or regions.country_of_region(v.get("region"))
    for rung in LADDER:
        if rung == "postal":
            hit = postal.lookup(country, v.get("postal"))
            if hit and _inside(v, hit[0], hit[1]):
                return (hit[0], hit[1], "postal"), True
            continue
        key = keys[rung]
        if key is None:
            continue
        entry = cache.get(key)
        if entry is None:
            return None, False
        if not entry.get("miss") and _inside(v, entry["lat"], entry["lon"]):
            return (entry["lat"], entry["lon"], rung), True
    return None, True


def fill_from_cache(show: dict, cache: GeoCache, postal: PostalTable) -> bool:
    """Fill coordinates, precision and time zone from what is known. Returns True if anything changed."""
    v = show.get("venue") or {}
    changed = False
    if v.get("lat") is None or v.get("lon") is None:
        got, _ = resolve_from_cache(v, cache, postal)
        if got:
            v["lat"], v["lon"], v["geo_precision"] = round(got[0], 6), round(got[1], 6), got[2]
            changed = True
    elif _precision_rank(v.get("geo_precision")) > 0:
        # Coordinates exist already; a better rung may have been resolved since.
        got, _ = resolve_from_cache({**v, "lat": None}, cache, postal)
        if got and _precision_rank(got[2]) < _precision_rank(v.get("geo_precision")):
            v["lat"], v["lon"], v["geo_precision"] = round(got[0], 6), round(got[1], 6), got[2]
            changed = True
    if v.get("lat") is not None and v.get("lon") is not None and not show.get("timezone"):
        tz = timezone_for(v["lat"], v["lon"])
        if tz:
            show["timezone"] = tz
            changed = True
    return changed


def _precision_rank(p: str | None) -> int:
    return LADDER.index(p) if p in LADDER else 99


# ---------------------------------------------------------------- services

@dataclass
class Services:
    """The two geocoding APIs. Replace either in tests."""
    census_batch: Callable[[list[tuple[str, dict]]], dict[str, tuple[float, float]]]
    nominatim: Callable[[dict], list[dict]]


def make_services(transport: httpx.BaseTransport | None = None, **http_options) -> tuple[Services, list[HttpClient]]:
    # Both are documented public APIs governed by their own usage policies, not crawlers, so robots.txt
    # (which Nominatim uses to keep search engines away from /search) is not applied to them.
    census = HttpClient("geocode_census", None, respect_robots=False, min_interval=1.0, transport=transport, **http_options)
    nominatim = HttpClient("geocode_nominatim", None, respect_robots=False, min_interval=1.0, transport=transport, **http_options)

    def census_batch(items: list[tuple[str, dict]]) -> dict[str, tuple[float, float]]:
        out: dict[str, tuple[float, float]] = {}
        for i in range(0, len(items), CENSUS_CHUNK):
            chunk = items[i:i + CENSUS_CHUNK]
            buf = io.StringIO()
            w = csv.writer(buf)
            for key, v in chunk:
                w.writerow([key_id(key), v.get("address") or "", v.get("city") or "", v.get("region") or "",
                            (norm_postal(v.get("postal")) or "")[:5]])
            try:
                resp = census.post(CENSUS_URL, data={"benchmark": "Public_AR_Current"},
                                   files={"addressFile": ("addresses.csv", buf.getvalue(), "text/csv")})
            except FetchError:
                continue  # leave these unresolved this time; they are retried on the next run
            ids = {key_id(k): k for k, _ in chunk}
            for row in csv.reader(io.StringIO(resp.text)):
                if len(row) >= 6 and row[2] == "Match" and row[0] in ids:
                    try:
                        lon, lat = (float(x) for x in row[5].split(","))
                    except ValueError:
                        continue
                    out[ids[row[0]]] = (lat, lon)
        return out

    def nominatim_get(params: dict) -> list[dict]:
        resp = nominatim.get(NOMINATIM_URL, params={"format": "jsonv2", "limit": 1, **params})
        data = resp.json()
        return data if isinstance(data, list) else []

    return Services(census_batch, nominatim_get), [census, nominatim]


def key_id(key: str) -> str:
    import hashlib
    return hashlib.sha1(key.encode()).hexdigest()[:12]


# ---------------------------------------------------------------- the command

@dataclass
class GeocodeReport:
    shows: int = 0
    already_placed: int = 0
    resolved: dict[str, int] = field(default_factory=dict)
    unresolved: int = 0
    census_asked: int = 0
    nominatim_asked: int = 0
    timezones_filled: int = 0
    rejected_outside_region: int = 0

    def lines(self) -> list[str]:
        got = ", ".join(f"{k} {v}" for k, v in sorted(self.resolved.items())) or "none"
        return [f"Shows: {self.shows}. Newly placed: {got}. Still without coordinates: {self.unresolved}.",
                f"  asked the Census geocoder about {self.census_asked} addresses and Nominatim {self.nominatim_asked} times",
                f"  time zones filled: {self.timezones_filled}"]


def _nominatim_params(v: dict, rung: str) -> dict:
    country = v.get("country") or regions.country_of_region(v.get("region")) or "US"
    base: dict[str, Any] = {"countrycodes": country.lower()}
    state = regions.US_STATES.get(v.get("region")) or regions.CA_PROVINCES.get(v.get("region"))
    if rung == "address":
        base.update(street=v.get("address"), city=v.get("city"), state=state, postalcode=v.get("postal"))
    elif rung == "venue":
        base["q"] = ", ".join(x for x in (v.get("name"), v.get("city"), state, "Canada" if country == "CA" else "USA") if x)
    else:
        base.update(city=v.get("city"), state=state)
    return {k: val for k, val in base.items() if val}


def _accept_nominatim(rung: str, results: list[dict], v: dict) -> tuple[float, float] | None:
    if not results:
        return None
    r = results[0]
    try:
        lat, lon = float(r["lat"]), float(r["lon"])
    except (KeyError, ValueError, TypeError):
        return None
    if rung in ("address", "venue") and int(r.get("place_rank") or 0) < 26:
        return None  # it only found the town, which is the city rung's job
    if not _inside(v, lat, lon):
        return None
    return lat, lon


def run_geocode(paths: Paths, services: Services, today: date | None = None, limit: int | None = None) -> GeocodeReport:
    today = today or today_fn()
    cache = GeoCache(paths.geocache, today)
    postal = PostalTable.load(paths.postal_dir)
    rep = GeocodeReport()
    shows = read_jsonl(paths.shows)
    events = read_jsonl(paths.store_events)
    records = shows + events
    rep.shows = len(records)

    todo = [r for r in records if (r.get("venue") or {}).get("lat") is None or
            _precision_rank((r.get("venue") or {}).get("geo_precision")) > 0]
    rep.already_placed = len(records) - len([r for r in records if (r.get("venue") or {}).get("lat") is None])

    # Rung 1a: Census batch for US addresses not yet in the cache.
    census_items: dict[str, dict] = {}
    for r in todo:
        v = r["venue"]
        key = rung_keys(v)["address"]
        country = v.get("country") or regions.country_of_region(v.get("region"))
        if key and country == "US" and cache.get(key) is None and v.get("address") and key not in census_items:
            census_items[key] = v
    if census_items:
        rep.census_asked = len(census_items)
        got = services.census_batch(list(census_items.items()))
        for key, v in census_items.items():
            if key in got and _inside(v, *got[key]):
                cache.hit(key, got[key][0], got[key][1], "census")
            else:
                cache.data.pop(key, None)  # decided below: Nominatim gets a turn before we record a miss

    # Rungs 1b, 2 and 4 through Nominatim, one request at a time.
    budget = limit if limit is not None else 10**9
    failures = 0
    for r in todo:
        if failures >= 5:
            break  # the service looks down; the next run picks up where this one stopped
        v = r["venue"]
        keys = rung_keys(v)
        for rung in ("address", "venue", "postal", "city"):
            if rung == "postal":
                country = v.get("country") or regions.country_of_region(v.get("region"))
                hit = postal.lookup(country, v.get("postal"))
                if hit and _inside(v, *hit):
                    break
                continue
            key = keys[rung]
            if key is None:
                continue
            entry = cache.get(key)
            if entry is not None:
                if not entry.get("miss"):
                    break
                continue
            if budget <= 0:
                break
            budget -= 1
            rep.nominatim_asked += 1
            try:
                got_n = _accept_nominatim(rung, services.nominatim(_nominatim_params(v, rung)), v)
            except (FetchError, ValueError):
                failures += 1
                break  # network trouble: leave it unrecorded so the next run tries again
            failures = 0
            if got_n:
                cache.hit(key, got_n[0], got_n[1], "nominatim")
                break
            cache.miss(key)
    cache.save()

    for r in records:
        before = (r.get("venue") or {}).get("lat")
        before_tz = r.get("timezone")
        if fill_from_cache(r, cache, postal):
            if before is None and r["venue"].get("lat") is not None:
                p = r["venue"]["geo_precision"]
                rep.resolved[p] = rep.resolved.get(p, 0) + 1
            if before_tz is None and r.get("timezone"):
                rep.timezones_filled += 1
        if r["venue"].get("lat") is None:
            rep.unresolved += 1
    write_jsonl(paths.shows, shows)
    if events or paths.store_events.exists():
        write_jsonl(paths.store_events, events)
    return rep
