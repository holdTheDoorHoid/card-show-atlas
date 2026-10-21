"""Pokemon Championship Series events in North America, from trainerchampionships.com.

Terms and robots checked 2026-10-21: robots.txt allows everything (an empty Disallow) and names the
sitemap. The pages carry no automation clause. We take facts only (name, dates, venue, fees, the
organizer's name and web address) and link the event's own page.

How it works:
  1. event-sitemap.xml lists every event page, in English, Spanish and Portuguese. We use the English
     ones (/event/<city>-<year>/).
  2. /events/ shows one card per event with its world region. We keep the cards for North America.
  3. Each North American event page gives the city and dates, the venue, the registration fees and the
     organizer. The country comes from the page's own sentence ("return to Toronto, Canada"), because
     the card for Toronto names the wrong country. Mexico is left out on purpose.

If the sitemap or the cards cannot be found, or none of the event pages can be read, the source stops
with a message and the last good file stays in place.
"""

from __future__ import annotations

import re
from typing import Iterable

from ..regions import country_of_region, region_code
from ..textparse import parse_money
from ._common import (LayoutChanged, city_and_region, clean, date_span, day_rows, money_text, strip_comments)

SITEMAP = "https://www.trainerchampionships.com/event-sitemap.xml"
LISTING = "https://www.trainerchampionships.com/events/"
EVENT_URL = re.compile(r"^https://www\.trainerchampionships\.com/event/[a-z0-9\-]+/$")
CARD = re.compile(r'<div class="card-event"\s+data-status="([^"]*)"\s+data-region="([^"]*)"[^>]*>(.*?)(?=<div class="card-event"|<!-- /Event Card -->)', re.S)


def parse_sitemap(xml: str) -> list[str]:
    """English event page addresses, in the order the sitemap lists them."""
    urls = []
    for loc in re.findall(r"<loc>\s*([^<]+?)\s*</loc>", xml or ""):
        if EVENT_URL.match(loc) and loc not in urls:
            urls.append(loc)
    return urls


def parse_cards(html: str) -> list[dict]:
    """One dict per event card on the list page: url, region (a world region id) and status."""
    cards = []
    for status, region, body in CARD.findall(html or ""):
        href = re.search(r'href="(https://www\.trainerchampionships\.com/event/[^"]+)"', body)
        if href:
            cards.append({"url": href.group(1), "region": region, "status": status})
    return cards


def parse_fees(html: str) -> list[tuple[str, float, str | None]]:
    """(label, amount, currency) for every line of the registration fee list."""
    box = re.search(r'<div class="fees">(.*?)</ul>', html, re.S)
    out = []
    for li in re.findall(r"<li\b[^>]*>(.*?)</li>", box.group(1) if box else "", re.S):
        span = re.search(r"<span>(.*?)</span>", li, re.S)
        label = clean(li.replace(span.group(0), "") if span else li)
        amount, cur = parse_money(clean(span.group(1)) if span else "")
        if label and amount is not None:
            out.append((label, amount, cur))
    return out


def parse_event_page(html: str, url: str, note) -> tuple[dict | None, str]:
    """(record, "ok") from one event page. (None, why) for a page that gives no North American event:
    "layout" when the pieces we read are missing, "skip" when the page is fine but not wanted (no dates yet,
    Mexico, an unknown province)."""
    body = strip_comments(html)
    h1 = re.search(r"<h1[^>]*>(.*?)</h1>", body, re.S)
    intro = re.search(r"return to\s*<strong>\s*([^<]+?)\s*</strong>", body)
    if not h1 or not intro:
        note(f"{url}: no heading or no 'return to' sentence, skipped")
        return None, "layout"
    parts = re.split(r"<br\s*/?>", h1.group(1))
    days = date_span(clean(parts[1]) if len(parts) > 1 else "")
    if not days:
        note(f"{url}: no dates with a year in the heading ({clean(h1.group(1))[:60]!r}), skipped")
        return None, "skip"
    place = [p.strip() for p in intro.group(1).split(",")]
    city = place[0]
    area = place[-1] if len(place) > 1 else ""
    region = region_code(area) if area else None
    if region is None and area.lower() == "canada":
        found = city_and_region(city)
        region = found[1] if found and country_of_region(found[1]) == "CA" else None
        if region is None:
            note(f"{url}: {city}, Canada: the province is not known, skipped (add the city to the list in sources/_common.py)")
            return None, "skip"
    if region is None:
        if area.lower() not in ("mexico", "méxico"):
            note(f"{url}: could not place {intro.group(1)!r} in a US state or Canadian province, skipped")
        return None, "skip"
    country = country_of_region(region)
    venue_name = re.sub(r"\s*\(.*?\)\s*", " ", clean(parts[2])).strip() if len(parts) > 2 else None
    title = re.search(r"The\s+(Pok[eé]mon\s+[A-Za-z ]*?Championships?)\s+return", clean(body))
    title = title.group(1).replace("Pokemon", "Pokémon") if title else "Pokémon Regional Championships"

    fees = parse_fees(body)
    spectator = next((f for f in fees if "spectator" in f[0].lower()), None)
    competitors = [f for f in fees if f is not spectator]
    cur = (spectator or (competitors[0] if competitors else (None, None, None)))[2] or "USD"
    admission: dict = {}
    notes = []
    if competitors:
        notes.append("Competitor fees: " + ", ".join(f"{label} {money_text(amount, cur)}" for label, amount, _ in competitors))
    if spectator:
        admission.update({"free": False, "adult": spectator[1], "currency": cur})
        notes.append(f"Spectator pass {money_text(spectator[1], cur)}")
    if notes:
        admission["notes"] = ". ".join(notes) + "."

    organizer = None
    card = re.search(r'contact-organizer-card__identity-name">\s*<h3>([^<]+)</h3>', body)
    link = re.search(r'contact-organizer-card__link"[^>]*href="(https?://[^"]+)"', body)
    if card:
        organizer = {"name": clean(card.group(1)), "url": link.group(1) if link else None}

    rec = {
        "name": f"{city} {title}",
        "event_type": "tournament",
        "days": day_rows(days),
        "venue": {"name": venue_name or None, "city": city, "region": region, "country": country},
        "sells": {"tcg": ["pokemon"]},
        "links": {"official": url},
        "source_url": url,
    }
    if admission:
        rec["admission"] = admission
    if organizer:
        rec["organizer"] = organizer
    return rec, "ok"


def harvest(ctx) -> Iterable[dict]:
    sitemap = parse_sitemap(ctx.http.get(SITEMAP).text)
    if not sitemap:
        raise LayoutChanged("pokemon_championships", SITEMAP, "a list of /event/<city>-<year>/ addresses", "none")
    cards = parse_cards(ctx.http.get(LISTING).text)
    if not cards:
        raise LayoutChanged("pokemon_championships", LISTING, "event cards with a data-region", "no cards")
    wanted = [c["url"] for c in cards if c["region"] == "north-america"]
    for url in wanted:
        if url not in sitemap:
            ctx.log(f"{url} is on the list page but not in the sitemap; read anyway")
    if not wanted:
        ctx.log("the list page shows no North American events right now")
        return
    problems = 0
    for url in wanted:
        rec, why = parse_event_page(ctx.http.get(url).text, url, ctx.log)
        if why == "layout":
            problems += 1
        if rec is not None:
            yield rec
    if problems == len(wanted):
        raise LayoutChanged("pokemon_championships", wanted[0], "a heading with the city and dates, and a 'return to <city>' sentence",
                            f"neither on any of the {len(wanted)} North American pages")
