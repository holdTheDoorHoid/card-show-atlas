"""Yu-Gi-Oh! Championship Series and other premier events in the US and Canada, from Konami's events page.

Terms and robots checked 2026-10-21: www.yugioh-card.com/robots.txt redirects to a host that answers
404, so no limits are published (the client treats that as allowed). We take facts only (name, dates,
venue) and link Konami's page for the event. The page is Konami's own announcement of its own event.

How it works:
  1. /en/events/ has an "Upcoming Events" table: name, location, dates, link. We keep rows whose
     location is a US state or Canadian province. Remote Duel rows ("hosted on Discord") and rows in other
     countries are left out.
  2. Each kept row's page has a "DATES & LOCATION" block with the venue name and street address.

If the table is missing, or a kept row's page has no such block, the run stops with a message (the venue is
what makes the event a place on the map, so a page without it is a changed page, not a quiet case).
"""

from __future__ import annotations

import re
from datetime import date
from typing import Iterable
from urllib.parse import urljoin

from ..regions import country_of_region, region_code
from ..textparse import norm_postal
from ._common import LayoutChanged, clean, day_rows, text_lines

LISTING = "https://www.yugioh-card.com/en/events/"
ROW = re.compile(r'<a href="([^"]+)">\s*<p>(.*?)</p>\s*<p class="small">(.*?)</p>\s*<p class="small">(.*?)</p>', re.S)
US_DATE = re.compile(r"(\d{2})/(\d{2})/(\d{4})")
CITY_STATE = re.compile(r"^(?P<city>.+?),\s*(?P<region>[A-Z]{2})$")  # "Orlando, FL"; a country name such as Georgia does not match


def parse_listing(html: str) -> list[dict]:
    """The rows of the Upcoming Events table: name, location text, dates and page address."""
    start = html.find('id="upcoming"')
    if start < 0:
        return []
    block = html[start:]
    end = block.find("Organized Play Links")  # the section after the table
    rows = []
    for href, name, where, dates in ROW.findall(block[:end] if end > 0 else block):
        rows.append({"href": href, "name": clean(name), "where": clean(where), "dates": clean(dates)})
    return rows


def dates_in(text: str) -> list[date]:
    out = []
    for mm, dd, yy in US_DATE.findall(text):
        try:
            out.append(date(int(yy), int(mm), int(dd)))
        except ValueError:
            continue
    return out


def event_name(raw: str) -> str:
    """'Yu-Gi-Oh! Championship Series Orlando, Florida 2026' becomes 'Yu-Gi-Oh! Championship Series Orlando'.

    The state and the year are dropped so the name stays the same from one year to the next."""
    m = re.match(r"^(.*?Championship Series)\s+(.+?),\s*[A-Za-z .]+?\s+\d{4}$", raw)
    if m:
        return f"{m.group(1)} {m.group(2)}"
    return re.sub(r"\s+\d{4}$", "", raw).strip()


def parse_event_page(html: str) -> dict | None:
    """Venue name, street, city, region and postal code from the 'DATES & LOCATION' block, or None."""
    m = re.search(r"DATES\s*&amp;\s*LOCATION</strong></p>(.*?)(?:<iframe|<hr|</td>)", html, re.S)
    if not m:
        return None
    paragraphs = re.findall(r"<p[^>]*>(.*?)</p>", m.group(1), re.S)
    for p in paragraphs:
        lines = text_lines(p)
        # The address paragraph ends with 'City, ST 12345' and a country line.
        for i, line in enumerate(lines):
            mm = re.match(r"^(?P<city>.+?),\s*(?P<region>[A-Z]{2})\s+(?P<postal>[A-Z0-9 \-]{5,10})$", line)
            if mm and region_code(mm.group("region")):
                before = lines[:i]
                return {"name": before[0] if before else None, "address": before[1] if len(before) > 1 else None,
                        "city": mm.group("city"), "region": mm.group("region"), "postal": norm_postal(mm.group("postal"))}
    return None


def harvest(ctx) -> Iterable[dict]:
    rows = parse_listing(ctx.http.get(LISTING).text)
    if not rows:
        raise LayoutChanged("yugioh_events", LISTING, "an 'Upcoming Events' list of links with a name, location and dates", "no rows")
    kept = 0
    for row in rows:
        if "remote duel" in row["name"].lower() or "discord" in row["where"].lower():
            continue
        m = CITY_STATE.match(row["where"])
        region = region_code(m.group("region")) if m else None
        days = dates_in(row["dates"])
        if not region or not days:
            continue  # another country, a series without a place, or no real dates
        kept += 1
        start, end = min(days), max(days)
        if (end - start).days > 14:
            ctx.log(f"{row['name']}: dates {row['dates']!r} run more than two weeks, skipped")
            continue
        url = urljoin(LISTING, row["href"])
        page = ctx.http.get(url).text
        place = parse_event_page(page)
        if place is None:
            raise LayoutChanged("yugioh_events", url, "a 'DATES & LOCATION' block with the venue and a 'City, ST 12345' line")
        if place["region"] != region:
            ctx.log(f"{row['name']}: the list says {row['where']} but the page says {place['city']}, {place['region']}; used the page")
        yield {
            "name": event_name(row["name"]),
            "event_type": "tournament",
            "days": day_rows([date.fromordinal(d) for d in range(start.toordinal(), end.toordinal() + 1)]),
            "venue": {"name": place["name"], "address": place["address"], "city": place["city"], "region": place["region"],
                      "postal": place["postal"], "country": country_of_region(place["region"])},
            "sells": {"tcg": ["yugioh"]},
            "links": {"official": url},
            "source_url": url,
        }
    if kept == 0:
        ctx.log("no in-person events in the US or Canada are listed right now")
