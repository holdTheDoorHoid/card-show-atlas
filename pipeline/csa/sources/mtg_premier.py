"""Magic: The Gathering premier events in the US and Canada, from the MTG Wiki season pages.

Terms and robots checked 2026-10-21: mtg.wiki/robots.txt only turns away its special and action pages.
The wiki says its text is CC BY-NC-SA 4.0. We take facts only (event names, dates, the city, and the
attendance figure the page reports), no prose and no player names, we credit mtg.wiki on every record
and link the page. The wiki itself cites Wizards of the Coast announcements for these dates.

What is read from a season page ("2026-27 Premier Play Season" and the season before it):
  * Regional Championship boxes (RC USA 1 (Baltimore), RC Canada (Ottawa), ...): date and attendance.
    Attendance becomes size.reported_attendance for events that have been held.
  * Sentences like "The first Pro Tour of 2027 takes place on February 26-28, 2027, at MagicCon Denver, USA"
    and "The Magic Limited Championship will take place June 18-20, 2027, in Minneapolis, Minnesota".

Only the US and Canada are kept. A page that no longer has any Regional Championship box stops the run
with a message. An event in a city that the places list in _common.py does not know is reported in the
run's notes and skipped, never guessed.
"""

from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Iterable
from urllib.parse import quote, urljoin

from ..http import HttpStatusError
from ..regions import country_of_region, region_code
from ..textparse import parse_int
from ._common import LayoutChanged, city_and_region, clean, date_span, day_rows, strip_comments

BASE = "https://mtg.wiki/page/"
RC_BOX = re.compile(r"<center><b>\s*RC\s+(?P<label>[^<(]+?)\s*\((?P<city>[^)]+)\)\s*(?:<sup\b.*?</sup>)?\s*</b>.*?"
                    r"<b>Date:</b>\s*(?P<date>.*?)<br\s*/?>\s*<b>Attendance:</b>\s*(?P<attendance>[^<]*)", re.S)
HEADING = re.compile(r'<h([23])><span class="mw-headline" id="[^"]*">(.*?)</span></h\1>(.*?)(?=<h[23]><span class="mw-headline"|$)', re.S)
HELD = re.compile(r"(?:took|takes|will take) place\s+(?:on\s+)?(?P<date>[A-Z][a-z]+ \d{1,2}[^,.]*,\s*\d{4}),?\s+(?:at|in)\s+(?P<place>[^.]*)\.")
NA_RC = {"usa": "US", "canada": "CA"}  # the label after "RC": USA 1, USA 2, Canada


def season_titles(today: date) -> list[str]:
    """Page titles to try for the current season: the season starts in the summer, and the wiki renamed its pages in 2026."""
    start = today.year if today.month >= 7 else today.year - 1
    short = f"{start}–{(start + 1) % 100:02d}"
    return [f"{short} Premier Play Season", f"{short} Pro Tour Season"]


def _long_over(days: list[date], today: date | None) -> bool:
    return today is not None and days[-1] < today - timedelta(days=7)


def page_url(title: str) -> str:
    return BASE + quote(title.replace(" ", "_"), safe="_")


def neighbour_links(html: str) -> list[str]:
    """Addresses of the previous and next season pages, when they exist (a missing page is a red link)."""
    box = re.search(r'<table class="infobox subbox">(.*?)</table>', html, re.S)
    out = []
    for attrs in re.findall(r"<a ([^>]*?)>", box.group(1) if box else ""):
        href = re.search(r'href="(/page/[^"]+)"', attrs)
        if href and 'class="new"' not in attrs:
            out.append(urljoin(BASE, href.group(1)))
    return out


def parse_regionals(html: str, source_url: str, note, today: date | None = None) -> Iterable[dict]:
    for m in RC_BOX.finditer(html):
        label = clean(m.group("label"))
        country = NA_RC.get(label.split()[0].lower()) if label else None
        if country is None:
            continue
        city_text = clean(m.group("city"))
        found = city_and_region(city_text, None)
        if found is None or country_of_region(found[1]) != country:
            note(f"RC {label} ({city_text}): the city is not in the places list, skipped")
            continue
        city, region = found
        days = date_span(clean(m.group("date")))
        if not days:
            note(f"RC {label} ({city_text}): could not read the date {clean(m.group('date'))!r}, skipped")
            continue
        rec = {
            "name": f"Magic Regional Championship {city}",
            "event_type": "tournament",
            "days": day_rows(days),
            "venue": {"city": city, "region": region, "country": country},
            "sells": {"tcg": ["mtg"]},
            "source_url": source_url,
        }
        attendance = parse_int(clean(m.group("attendance")))
        if attendance:
            rec["size"] = {"reported_attendance": {"value": attendance, "year": days[0].year, "source_url": source_url}}
        elif _long_over(days, today):
            continue  # a finished event with no figure says nothing about size, so it is not worth a record
        yield rec


def parse_sentences(html: str, source_url: str, note, today: date | None = None) -> Iterable[dict]:
    """Pro Tours, World Championships and the Limited Championship, from the section for each on a season page.

    Each section's first paragraph says when and where, for example 'The first Pro Tour of 2027 takes place on
    February 26-28, 2027, at MagicCon Denver, USA.' A closed event ('not open to the public') is left out."""
    for _, heading_html, body in HEADING.findall(strip_comments(html)):
        heading = clean(heading_html)
        if not re.match(r"(?:Pro Tour|Second Pro Tour|Third Pro Tour|Magic World Championship|Magic Limited Championship|"
                        r"Limited Championship|World Championship)", heading) and "Pro Tour" not in heading:
            continue
        paragraphs = [clean(re.sub(r"<sup\b.*?</sup>", "", p, flags=re.S)) for p in re.findall(r"<p>(.*?)</p>", body, re.S)]
        text = " ".join(paragraphs[:2])
        m = HELD.search(text)
        if not m:
            continue
        if "not open to the public" in text.lower():
            continue
        days = date_span(m.group("date"))
        if not days:
            note(f"{heading}: could not read the date {m.group('date')!r}, skipped")
            continue
        if _long_over(days, today):
            continue  # these sections give no attendance, so a finished event is of no use
        parts = [p.strip() for p in m.group("place").split(",")]
        con = parts[0] if parts[0].startswith("MagicCon ") else None
        if con:
            found = city_and_region(con.replace("MagicCon", "").strip()) if parts[-1].lower() in ("usa", "united states", "canada") else None
            if found is None:
                if parts[-1].lower() in ("usa", "united states", "canada"):
                    note(f"{con}: the city is not in the places list, skipped")
                continue
        else:
            region = region_code(parts[1]) if len(parts) > 1 else None
            found = (parts[0], region) if region else None
            if found is None:
                continue
        city, region = found
        if "Pro Tour" in heading:
            what = heading if heading.startswith("Pro Tour ") else "Magic Pro Tour"
        elif "World Championship" in heading:
            what = "Magic World Championship"
        else:
            what = "Magic Limited Championship"
        yield {
            "name": f"{con}: {what}" if con else what,
            "event_type": "tournament",
            "days": day_rows(days),
            "venue": {"city": city, "region": region, "country": country_of_region(region)},
            "sells": {"tcg": ["mtg"]},
            "source_url": source_url,
        }


def harvest(ctx) -> Iterable[dict]:
    page = None
    for title in season_titles(ctx.today):
        url = page_url(title)
        try:
            page = (url, ctx.http.get(url).text)
            break
        except HttpStatusError as exc:
            if exc.status != 404:
                raise
    if page is None:
        raise LayoutChanged("mtg_premier", page_url(season_titles(ctx.today)[0]), "a season page for the current season", "an error page (404)")
    todo = [page]
    seen = {page[0]}
    for link in neighbour_links(page[1])[:2]:  # one season either side; the earlier season holds past attendance
        if link not in seen:
            seen.add(link)
            try:
                todo.append((link, ctx.http.get(link).text))
            except HttpStatusError as exc:
                ctx.log(f"{link}: answered {exc.status}, skipped")
    regionals = 0
    for url, html in todo:
        for rec in parse_regionals(html, url, ctx.log, ctx.today):
            regionals += 1
            yield rec
        yield from parse_sentences(html, url, ctx.log, ctx.today)
    if regionals == 0:
        raise LayoutChanged("mtg_premier", page[0], "Regional Championship boxes (RC USA 1 (city), with Date and Attendance)",
                            "none for the US or Canada")
