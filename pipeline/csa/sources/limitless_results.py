"""Past North American premier events and their player counts, from Limitless TCG's results pages.

Terms and robots checked 2026-10-21: both hosts' robots.txt allow everything (an empty Disallow), and the
site notice and terms carry no clause against automated reading. We take facts only (event name, date,
city, number of players) at about five pages a run, and credit Limitless on every record. We never read
or keep player names or the winner column.

These records are history for the crowd model, not listings. Each is a finished event with size.players,
named the same way as the matching upcoming event so that the merge puts them in one series and the
estimate for next year's edition can start from this year's count:

    Pokemon (limitlesstcg.com)             "Regional Baltimore, MD"  ->  "Baltimore Pokémon Regional Championships"
    One Piece (onepiece.limitlesstcg.com)  "Regional Peoria, IL"     ->  "One Piece Regional Peoria"

Only in person premier events in the US and Canada are kept: Regionals, Special Events and the North
America International Championships for Pokemon; Regionals and Championship Finals for One Piece. World
Championships (invite only), Treasure Cups, online events and anything else are left out. The counts are
the main event entrants, not everyone who walked the hall, so they are a floor.

A page whose results table cannot be found stops the run with a message.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Iterable

from ..regions import country_of_region
from ..textparse import parse_int
from ._common import LayoutChanged, city_and_region, clean, title_city

HISTORY_YEARS = 3
MAX_PAGES = 3
ROW = re.compile(r"<tr data-date=.*?</tr>", re.S)
ATTR = re.compile(r'(data-[a-z]+)="([^"]*)"')
COUNTRIES = {"US", "CA"}


@dataclass(frozen=True)
class Site:
    name: str
    base: str
    game: str
    sells: str
    kinds: list


# row-name prefix -> how the event is named
POKEMON_KINDS = [
    (re.compile(r"^Regional\s+(?P<place>.+)$", re.I), "Regional Championships"),
    (re.compile(r"^Special Event\s+(?P<place>.+)$", re.I), "Special Championships"),
    (re.compile(r"^NAIC\s+\d{4},\s*(?P<place>.+)$", re.I), "North America International Championships"),
]
ONE_PIECE_KINDS = [
    (re.compile(r"^Regional\s+(?P<place>.+)$", re.I), "Regional"),
    (re.compile(r"^Championship Finals\s+(?P<place>.+)$", re.I), "Championship Finals"),
]
SITES = [
    Site("Limitless TCG (Pokémon)", "https://limitlesstcg.com/tournaments", "Pokémon", "pokemon", POKEMON_KINDS),
    Site("Limitless TCG (One Piece)", "https://onepiece.limitlesstcg.com/tournaments", "One Piece", "one_piece", ONE_PIECE_KINDS),
]


def parse_rows(html: str) -> list[dict]:
    """One dict per result row: date, country, name, players and the page address of the tournament."""
    rows = []
    for row in ROW.findall(html or ""):
        attrs = dict(ATTR.findall(row.split(">", 1)[0] + ">"))
        if "data-date" not in attrs or "data-name" not in attrs:
            continue
        link = re.search(r'<a href="(/tournaments/\d+)"', row)
        rows.append({"date": attrs["data-date"], "country": attrs.get("data-country", ""), "name": clean(attrs["data-name"]),
                     "players": parse_int(attrs.get("data-players")), "path": link.group(1) if link else None})
    return rows


def event_from_row(row: dict, site: Site, base_url: str, today: date, cutoff: date, note) -> dict | None:
    if row["country"] not in COUNTRIES or not row["players"]:
        return None
    try:
        day = date.fromisoformat(row["date"])
    except ValueError:
        return None
    if not (cutoff <= day < today):
        return None
    for rx, kind in site.kinds:
        m = rx.match(row["name"])
        if not m:
            continue
        found = city_and_region(m.group("place"))
        if found is None:
            note(f"{row['name']}: the city is not in the places list (sources/_common.py), skipped")
            return None
        city, region = found
        if country_of_region(region) != row["country"]:
            note(f"{row['name']}: {region} is not in {row['country']}, skipped")
            return None
        city = title_city(city)
        name = f"{city} Pokémon {kind}" if site.sells == "pokemon" else f"One Piece {kind} {city}"
        url = base_url.split("/tournaments")[0] + row["path"] if row.get("path") else base_url
        return {
            "name": name,
            "event_type": "tournament",
            "days": [{"date": day.isoformat(), "open": None, "close": None}],
            "venue": {"city": city, "region": region, "country": row["country"]},
            "sells": {"tcg": [site.sells]},
            "size": {"players": row["players"]},
            "source_url": url,
        }
    return None


def harvest(ctx) -> Iterable[dict]:
    cutoff = ctx.today - timedelta(days=365 * HISTORY_YEARS)
    for site in SITES:
        kept = 0
        for page in range(1, MAX_PAGES + 1):
            html = ctx.http.get(site.base, params={"region": "na", "show": 100, "page": page}).text
            rows = parse_rows(html)
            if not rows:
                if page == 1:
                    raise LayoutChanged("limitless_results", site.base, "a results table with rows that carry data-date, data-name and data-players",
                                        "no rows")
                break
            for row in rows:
                rec = event_from_row(row, site, site.base, ctx.today, cutoff, ctx.log)
                if rec is not None:
                    kept += 1
                    yield rec
            oldest = min((r["date"] for r in rows), default="")
            if oldest and oldest < cutoff.isoformat():
                break  # the table is newest first, so everything further back is older than we want
        if kept == 0:
            raise LayoutChanged("limitless_results", site.base, "rows with a date, a country, a name and a player count that include "
                                f"North American premier events from the last {HISTORY_YEARS} years", "rows, but none usable")
        ctx.log(f"{site.game}: {kept} past North American premier events in the last {HISTORY_YEARS} years")
