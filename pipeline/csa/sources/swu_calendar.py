"""Star Wars Unlimited organized play, from the publisher's calendar page in the US and Canada.

Terms and robots checked 2026-10-21: starwarsunlimited.com has no robots.txt (the client treats a
missing file as allowed). The terms of use page is drawn by script and could not be read, so we stay
with the calendar page itself, which the publisher shows to everyone. Facts only: dates, host or store
name, city, state or province. No store contacts are on the page and none are kept.

The page has one accordion per kind of event, each holding one or more tables:
  Planetary Qualifiers    store level events (about 100 in North America per set)    -> store_event
  Sector Qualifiers       4 per set, held in convention halls                        -> tournament
  Regional Championships  one per season                                             -> tournament
  Galactic Championship   a link only, no table

A table is read by its header row, not by column position, because the publisher adds and renames
columns between sets. A header that cannot be found stops the run with a message.
"""

from __future__ import annotations

import hashlib
import re
from html import unescape
from typing import Iterable

from ..regions import country_of_region, region_code
from ._common import LayoutChanged, clean, date_span, day_rows, strip_comments

URL = "https://starwarsunlimited.com/organized-play-calendar"
SECTION = re.compile(r'<button[^>]*>\s*<span class="text-left">([^<]+)</span>')
TABLE = re.compile(r"<table\b.*?</table>", re.S)
ROW = re.compile(r"<tr\b[^>]*>(.*?)</tr>", re.S)
CELL = re.compile(r"<t([dh])\b[^>]*>(.*?)</t\1>", re.S)
HREF = re.compile(r'href="(https?://[^"]+)"')
STORE_ID = re.compile(r"[?&]store=(\d+)")
NA_COUNTRIES = {"usa": "US", "us": "US", "united states": "US", "canada": "CA"}
KINDS = {  # section title -> (event_type, name used in the record)
    "planetary qualifiers": ("store_event", "Star Wars Unlimited Planetary Qualifier"),
    "sector qualifiers": ("tournament", "Star Wars Unlimited Sector Qualifier"),
    "regional championships": ("tournament", "Star Wars Unlimited Regional Championship"),
}
HEADERS = {  # what a header cell may say -> the field it holds
    "date": "date", "store name": "host", "host/venue": "host", "host": "host", "venue": "host",
    "format": "format", "city": "city", "region": "region", "state/region": "region", "state": "region",
    "country": "country", "country/region": "country", "state/country": "statecountry",
}


def sections(html: str) -> list[tuple[str, str]]:
    """(lower case title, html) for each accordion on the page, in page order."""
    marks = [(m.start(), clean(m.group(1)).lower()) for m in SECTION.finditer(html)]
    out = []
    for i, (pos, title) in enumerate(marks):
        end = marks[i + 1][0] if i + 1 < len(marks) else len(html)
        out.append((title, html[pos:end]))
    return out


def table_rows(table_html: str) -> list[dict]:
    """Rows as dicts keyed by field, plus 'href' (the first link in the host cell)."""
    rows = ROW.findall(table_html)
    if not rows:
        return []
    header_cells = [clean(c).lower() for kind, c in CELL.findall(rows[0])]
    fields = [HEADERS.get(h) for h in header_cells]
    out = []
    for row in rows[1:]:
        cells = CELL.findall(row)
        if len(cells) != len(fields):
            continue
        rec: dict = {}
        for field, (_, html) in zip(fields, cells):
            if field is None:
                continue
            rec[field] = clean(html)
            if field == "host":
                link = HREF.search(html)
                rec["href"] = unescape(link.group(1)) if link else None  # a few links are written with &amp; twice
        out.append(rec)
    return out


def place(rec: dict) -> tuple[str, str, str] | None:
    """(city, region, country) for a row in the US or Canada, else None."""
    city = rec.get("city", "")
    if "statecountry" in rec:  # 'MD, USA' or 'Poland'
        bits = [b.strip() for b in rec["statecountry"].split(",")]
        country_text, region_text = bits[-1], (bits[0] if len(bits) > 1 else "")
    else:
        country_text, region_text = rec.get("country", ""), rec.get("region", "")
    country = NA_COUNTRIES.get(country_text.strip().lower())
    if not country:
        return None
    region = region_code(region_text) if region_text else None
    if region is None and city:
        tail = [b.strip() for b in city.split(",")]
        region = region_code(tail[-1]) if len(tail) > 1 else None
    if region is None or country_of_region(region) != country:
        return None
    bits = [b.strip() for b in city.split(",")]
    if len(bits) > 1 and region_code(bits[-1]) == region:
        city = ", ".join(bits[:-1])  # 'Lincoln, NE' in the city column
    return city, region, country


def harvest(ctx) -> Iterable[dict]:
    html = strip_comments(ctx.http.get(URL).text)
    found = sections(html)
    titles = [t for t, _ in found]
    wanted = [(t, body) for t, body in found if t in KINDS]
    if not wanted:
        raise LayoutChanged("swu_calendar", URL, "accordions named Planetary Qualifiers, Sector Qualifiers and Regional Championships",
                            f"sections {titles}")
    tables_read = 0
    for title, body in wanted:
        event_type, base_name = KINDS[title]
        for table in TABLE.findall(body):
            rows = table_rows(table)
            if not rows:
                raise LayoutChanged("swu_calendar", URL, f"a header row and rows in each {title} table", "an empty or unreadable table")
            for need in ("date", "host", "city"):
                if need not in rows[0]:
                    raise LayoutChanged("swu_calendar", URL, f"a {need!r} column in the {title} tables", f"columns {sorted(rows[0])}")
            tables_read += 1
            for rec in rows:
                where = place(rec)
                if where is None:
                    continue  # another country
                days = date_span(rec["date"])
                if not days:
                    ctx.log(f"{title}: could not read the date {rec['date']!r} for {rec['host']}, skipped")
                    continue
                if event_type == "store_event" and days[-1] < ctx.today:
                    continue  # old store level rounds are not worth keeping
                city, region, country = where
                if event_type == "store_event":
                    name = f"{base_name} at {rec['host']}"
                else:
                    name = f"{base_name} {city}"
                out = {
                    "name": name,
                    "event_type": event_type,
                    "days": day_rows(days),
                    "venue": {"name": rec["host"], "city": city, "region": region, "country": country},
                    "sells": {"tcg": ["swu"]},
                    "source_url": URL,
                }
                if rec.get("href"):
                    out["links"] = {"official": rec["href"]}
                if event_type == "store_event":
                    # the store's number on starwarsunlimited.com, else a short fingerprint of its name and town
                    m = STORE_ID.search(rec.get("href") or "")
                    out["store_key"] = "swu-planetary-" + (m.group(1) if m else
                                                            hashlib.sha1(f"{rec['host']}|{city}|{region}".encode()).hexdigest()[:10])
                yield out
    if tables_read == 0:
        raise LayoutChanged("swu_calendar", URL, "at least one table under the qualifier sections", "no tables")
