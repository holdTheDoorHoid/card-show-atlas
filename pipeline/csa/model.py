"""The shape of a show edition (DATA_MODEL section 2) and small helpers around it."""

from __future__ import annotations

import copy
from datetime import date
from typing import Any

from .util import parse_iso_date

SHOW_KEY_ORDER = [
    "id", "series_id", "name", "event_type", "status", "days", "timezone", "venue", "sells", "mix",
    "admission", "size", "vendor", "organizer", "links", "sources", "verification", "first_seen",
    "last_checked", "summary", "estimate",
]

VENUE_KEYS = ["name", "address", "city", "region", "postal", "country", "lat", "lon", "geo_precision"]
ADMISSION_KEYS = ["free", "adult", "child", "currency", "notes"]
SIZE_KEYS = ["tables", "booths", "venue_sqft", "players", "reported_attendance", "first_year", "edition"]
VENDOR_KEYS = ["tables", "application_url", "opens", "deadline", "status", "electricity", "setup", "contact", "notes"]
ORGANIZER_KEYS = ["name", "promoter_id", "url"]
LINK_KEYS = ["official", "tickets", "facebook", "instagram"]
GEO_PRECISIONS = ("address", "venue", "postal", "city")
CURRENCIES = ("USD", "CAD")
VERIFICATION_RANK = {"organizer_confirmed": 3, "listed": 2, "community": 1, "unverified": 0}


def blank_show() -> dict:
    return {
        "id": None, "series_id": None, "name": None, "event_type": "card_show", "status": "scheduled",
        "days": [], "timezone": None,
        "venue": {k: None for k in VENUE_KEYS},
        "sells": {"tcg": [], "sports": [], "other": []},
        "mix": "unknown",
        "admission": {k: None for k in ADMISSION_KEYS},
        "size": {k: None for k in SIZE_KEYS},
        "vendor": {**{k: None for k in VENDOR_KEYS}, "tables": [], "status": "unknown"},
        "organizer": {k: None for k in ORGANIZER_KEYS},
        "links": {k: None for k in LINK_KEYS},
        "sources": [], "verification": "unverified", "first_seen": None, "last_checked": None,
        "summary": None, "estimate": None,
    }


_SECTION_KEYS = {
    "venue": VENUE_KEYS, "admission": ADMISSION_KEYS, "size": SIZE_KEYS, "vendor": VENDOR_KEYS,
    "organizer": ORGANIZER_KEYS, "links": LINK_KEYS,
}


def complete_show(rec: dict) -> dict:
    """Return a full record in canonical key order. Unknown keys are dropped."""
    out = blank_show()
    for key in SHOW_KEY_ORDER:
        val = rec.get(key)
        if val is None:
            continue
        if key in _SECTION_KEYS and isinstance(val, dict):
            for k in _SECTION_KEYS[key]:
                if k in val:
                    out[key][k] = copy.deepcopy(val[k])
        elif key == "sells" and isinstance(val, dict):
            for g in ("tcg", "sports", "other"):
                out["sells"][g] = list(val.get(g) or [])
        else:
            out[key] = copy.deepcopy(val)
    if out["vendor"]["tables"] is None:
        out["vendor"]["tables"] = []
    return out


def derive_mix(sells: dict | None) -> str:
    sells = sells or {}
    has_tcg = bool(sells.get("tcg"))
    has_sports = bool(sells.get("sports"))
    if has_tcg and has_sports:
        return "mixed"
    if has_tcg:
        return "tcg"
    if has_sports:
        return "sports"
    return "unknown"


def start_date(rec: dict) -> date | None:
    days = rec.get("days") or []
    if days and isinstance(days[0], dict):
        return parse_iso_date(days[0].get("date"))
    return None


def end_date(rec: dict) -> date | None:
    days = rec.get("days") or []
    if days and isinstance(days[-1], dict):
        return parse_iso_date(days[-1].get("date"))
    return None


def all_urls(rec: dict) -> list[tuple[str, str]]:
    """Every (field path, url) pair in a show record."""
    out: list[tuple[str, str]] = []

    def add(path: str, value: Any):
        if isinstance(value, str) and value:
            out.append((path, value))

    for k, v in (rec.get("links") or {}).items():
        add(f"links.{k}", v)
    add("vendor.application_url", (rec.get("vendor") or {}).get("application_url"))
    add("organizer.url", (rec.get("organizer") or {}).get("url"))
    ra = (rec.get("size") or {}).get("reported_attendance")
    if isinstance(ra, dict):
        add("size.reported_attendance.source_url", ra.get("source_url"))
    for i, s in enumerate(rec.get("sources") or []):
        if isinstance(s, dict):
            add(f"sources[{i}].url", s.get("url"))
    return out
