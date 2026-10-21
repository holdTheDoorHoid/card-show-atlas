"""Helpers for source modules: pull structured events out of a web page.

Many sites publish schema.org Event data in JSON-LD, which is far more stable than page
layout. jsonld_events() finds it and event_to_show() turns one event into a partial show.
Only facts are taken (name, dates, venue, prices, links). Descriptions are never copied.
"""

from __future__ import annotations

import json
import re
from html import unescape
from html.parser import HTMLParser
from typing import Any, Iterator
from urllib.parse import urljoin

from .regions import region_code
from .textparse import norm_url, parse_money, parse_time_text
from .util import parse_iso_date

_LD = re.compile(r"<script[^>]+type=[\"']application/ld\+json[\"'][^>]*>(.*?)</script>", re.I | re.S)


def extract_json_ld(html: str) -> list[Any]:
    out = []
    for block in _LD.findall(html or ""):
        try:
            out.append(json.loads(unescape(block).strip()))
        except json.JSONDecodeError:
            continue
    return out


def _walk(node: Any) -> Iterator[dict]:
    if isinstance(node, list):
        for n in node:
            yield from _walk(n)
    elif isinstance(node, dict):
        yield node
        for key in ("@graph", "itemListElement", "item", "subEvent"):
            if key in node:
                yield from _walk(node[key])


def jsonld_events(html: str) -> list[dict]:
    """Every schema.org Event (or subtype such as BusinessEvent, SportsEvent) found in the page."""
    events = []
    for block in extract_json_ld(html):
        for node in _walk(block):
            types = node.get("@type")
            types = types if isinstance(types, list) else [types]
            if any(isinstance(t, str) and t.endswith("Event") for t in types):
                events.append(node)
    return events


def _text(v: Any) -> str | None:
    if isinstance(v, dict):
        v = v.get("name")
    return " ".join(str(v).split()) if v else None


def event_to_show(ev: dict, base_url: str | None = None) -> dict | None:
    """A schema.org Event as a partial show record, or None when it has no usable start date."""
    start_raw, end_raw = str(ev.get("startDate") or ""), str(ev.get("endDate") or "")
    start = parse_iso_date(start_raw[:10])
    if start is None:
        return None
    end = parse_iso_date(end_raw[:10]) or start
    if end < start or (end - start).days > 14:
        end = start
    open_t = parse_time_text(start_raw[11:16]) if len(start_raw) > 10 else None
    close_t = parse_time_text(end_raw[11:16]) if len(end_raw) > 10 else None
    n = (end - start).days + 1
    days = []
    for i in range(n):
        d = start.fromordinal(start.toordinal() + i).isoformat()
        days.append({"date": d, "open": open_t if i == 0 else None, "close": close_t if i == n - 1 else None})
    loc = ev.get("location") or {}
    if isinstance(loc, list):
        loc = loc[0] if loc else {}
    addr = loc.get("address") or {}
    if isinstance(addr, str):
        addr = {"streetAddress": addr}
    country = addr.get("addressCountry")
    if isinstance(country, dict):
        country = country.get("name")
    venue = {"name": _text(loc.get("name")), "address": _text(addr.get("streetAddress")),
             "city": _text(addr.get("addressLocality")),
             "region": region_code(addr.get("addressRegion")) or _text(addr.get("addressRegion")),
             "postal": _text(addr.get("postalCode")), "country": _text(country)}
    geo = loc.get("geo") or {}
    if geo.get("latitude") is not None and geo.get("longitude") is not None:
        venue["lat"], venue["lon"] = geo["latitude"], geo["longitude"]
        venue["geo_precision"] = "address" if venue["address"] else "venue"
    rec: dict[str, Any] = {"name": _text(ev.get("name")), "days": days, "venue": venue}
    status = str(ev.get("eventStatus") or "")
    if "Cancelled" in status:
        rec["status"] = "cancelled"
    elif "Postponed" in status or "Rescheduled" in status:
        rec["status"] = "postponed"
    offers = ev.get("offers")
    offers = offers[0] if isinstance(offers, list) and offers else offers
    if isinstance(offers, dict) and offers.get("price") is not None:
        amount, cur = parse_money(offers.get("price"))
        rec["admission"] = {"free": amount == 0 if amount is not None else None, "adult": amount,
                            "currency": offers.get("priceCurrency") or cur}
    elif ev.get("isAccessibleForFree") is True:
        rec["admission"] = {"free": True, "adult": 0}
    org = ev.get("organizer")
    org = org[0] if isinstance(org, list) and org else org
    if isinstance(org, dict) and org.get("name"):
        rec["organizer"] = {"name": _text(org.get("name")), "url": norm_url(org.get("url")) if org.get("url") else None}
    url = ev.get("url")
    if isinstance(url, str) and url:
        full = urljoin(base_url or "", url)
        rec["source_url"] = norm_url(full)
    return rec


class _Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links: list[tuple[str, str]] = []
        self._href: str | None = None
        self._text: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self._href = dict(attrs).get("href")
            self._text = []

    def handle_data(self, data):
        if self._href is not None:
            self._text.append(data)

    def handle_endtag(self, tag):
        if tag == "a" and self._href is not None:
            self.links.append((self._href, " ".join("".join(self._text).split())))
            self._href = None


def find_links(html: str, base_url: str) -> list[tuple[str, str]]:
    """(absolute address, link text) for every link on the page."""
    p = _Links()
    p.feed(html or "")
    return [(urljoin(base_url, h), t) for h, t in p.links if h and not h.startswith(("#", "mailto:", "javascript:"))]
