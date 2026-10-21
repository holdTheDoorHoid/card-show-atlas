"""The shared client for the Ravensburger Play Hub (Disney Lorcana) and the Riftbound locator.

Both sites run on the same event platform and answer the same questions the same way:

    GET <api>/events/?game_slug=...&latitude=..&longitude=..&num_miles=..&display_statuses=upcoming
                     &start_date_after=...&page_size=250&page=N

Terms and robots checked 2026-10-21: the web sites' robots.txt allow everything except /players/, and the API
hosts have no robots.txt (a missing file means no limits). The API is not documented for outsiders, but it is
the one the sites' own pages call and it needs no key. No terms page could be found. So this client is
deliberately gentle:

  * the project's polite HTTP client (one request per second, a copy of every answer kept for 12 hours);
  * at most MAX_REQUESTS requests in one run, counted here; when the cap would be passed the run stops with
    an error and the last good file is kept, instead of writing half the events;
  * only what a show listing needs is kept. The store's e-mail address and phone number, the tournament
    internals and the image links are never read. A host whose name is itself an e-mail address or a phone
    number is a private person, so that event is left out, and an address typed into an event name is removed.

What becomes what, with the numbers in this file's constants:

  tournament   an event the platform marks as headlining, or one with room for BIG_CAPACITY players or more, or
               one named or templated as a Championship, Challenge, Qualifier or Regional that has room for at
               least TEMPLATE_MIN_CAPACITY players. Two guards keep shop events out of this layer, both found
               on the real data: a Set Championship held in a card shop is usually 8 to 64 players (455 of them
               are listed for January alone), and shops often give a weekly event, a prerelease or an open play
               night a very large capacity that is only a default (a name with weekly, prerelease, open play,
               league and the like, or the same event listed three or more times, RECURRING_MIN). Those stay
               store events.
  store_event  everything else, but only when it starts within STORE_WINDOW_DAYS days. These go to data/store/
               (not committed), with an id made from the Play Hub's own event id; see csa/store.py.

size.players is the number registered once at least EARLY_REGISTRATION_SHARE of the places are taken, or when the
event is within EARLY_DAYS days; before that, the number of places. A handful of early sign ups for a 200 player open
says nothing about its size. The admission note says which one it is.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from typing import Iterable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .. import regions
from ..http import BotChallenge, FetchError
from ..regions import country_of_region, region_code
from ..textparse import EMAIL_RX, PHONE_RX, host_of, norm_url
from ..util import norm_text
from ._common import LayoutChanged, money_text, title_city

BIG_CAPACITY = 128
TEMPLATE_MIN_CAPACITY = 100
RECURRING_MIN = 3
EARLY_REGISTRATION_SHARE = 0.25
EARLY_DAYS = 14
STORE_WINDOW_DAYS = 21
PAGE_SIZE = 250
MAX_REQUESTS = 200
# One wide circle covers the contiguous US and southern Canada (about 3,000 miles from Philadelphia reaches
# Seattle, Vancouver, Los Angeles and Calgary). Alaska and Hawaii need their own small circles. Events found
# by more than one circle are kept once, by event id.
CENTERS = [("Philadelphia", 39.95, -75.16, 3000), ("Honolulu", 21.31, -157.86, 400), ("Anchorage", 61.22, -149.90, 700)]
ROUTINE = re.compile(r"pre-?release|weekly|locals?\b|open play|casual|league|learn to play|game night|draft night", re.I)
MAJOR = re.compile(r"championship|challenge|regional|qualifier|finals?\b|invitational|national|world", re.I)
COUNTRIES = {"US": "US", "USA": "US", "UNITED STATES": "US", "CA": "CA", "CAN": "CA", "CANADA": "CA"}
POSTAL = re.compile(r"^(\d{5}(?:-\d{4})?|[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d)$")
UNIT = re.compile(r"^(?:unit|suite|ste|apt|apartment|bldg|building|floor|room|rm|#)\b", re.I)
UNIT_TAIL = re.compile(r"[\s,]+(?:(?:unit|suite|ste|apt|apartment|bldg|building|floor|room|rm)\.?\s*#?\s*[\w\-]+|#\s*[\w\-]+)$", re.I)
SOCIAL = ("facebook.", "fb.", "instagram.", "twitter.", "x.com", "tiktok.", "youtube.", "linktr.ee", "discord.")


class RequestCapReached(RuntimeError):
    pass


@dataclass(frozen=True)
class Game:
    source: str       # the source id, for messages
    label: str        # 'Lorcana'
    sells_id: str     # the vocabulary id
    api: str          # base address of the event API
    game_slug: str
    page: str         # event page address with {id}


class Client:
    """Counts every request against the cap."""

    def __init__(self, ctx, game: Game):
        self.ctx, self.game, self.requests = ctx, game, 0

    def get(self, path: str, params: dict):
        if self.requests >= MAX_REQUESTS:
            raise RequestCapReached(f"{self.game.source}: stopped after {MAX_REQUESTS} requests without reaching the last page. "
                                    "The last good file was kept. Raise MAX_REQUESTS in sources/_playhub.py only if the API has grown.")
        self.requests += 1
        return self.ctx.http.get(self.game.api + path, params=params).json()


def major_template_ids(client: Client, note) -> set[str]:
    """Ids of the platform's event templates that are championship, challenge or qualifier kinds.

    Best effort: a failure here only means events are judged by name and capacity alone."""
    ids: set[str] = set()
    try:
        for t in client.get("/event-configuration-templates/", {"game_slug": client.game.game_slug}):
            if isinstance(t, dict) and t.get("id") and MAJOR.search(str(t.get("name") or "")):
                ids.add(str(t["id"]))
        for f in client.get("/events/quick-filters/", {"game_slug": client.game.game_slug}):
            cfg = (f or {}).get("filter_config") or {}
            if MAJOR.search(str((f or {}).get("name") or "")):
                ids.update(str(i) for i in (cfg.get("eventConfigurationTemplateIds") or []) if i)
    except BotChallenge:
        raise  # a bot check ends the whole run, never just this step
    except (FetchError, ValueError, TypeError, AttributeError, RequestCapReached) as exc:
        note(f"{client.game.source}: the template lists could not be read ({exc}); events are judged by name and size alone")
    return ids


def parse_address(full: str | None) -> dict:
    """Street, city, region and postal code from 'street, city, ST 12345, USA' or 'street, city, ST, 12345, US'."""
    tokens = [t.strip() for t in (full or "").split(",") if t.strip()]
    if tokens and tokens[-1].upper() in COUNTRIES:
        tokens.pop()
    for i in range(len(tokens) - 1, 0, -1):
        m = re.match(r"^([A-Za-z]{2})\b\s*(.*)$", tokens[i])
        code = region_code(m.group(1).upper()) if m else None
        if not code:
            continue
        postal = m.group(2).strip() or (tokens[i + 1] if i + 1 < len(tokens) else "")
        # Suite and unit numbers are dropped: the street is enough to find the building, and a shop's unit
        # number reads like a flat number to the privacy check.
        street = ", ".join(t for t in tokens[: i - 1] if not UNIT.match(t))
        street = re.sub(r"^(\d+),\s+", r"\1 ", street)  # '13, W Merrick Rd' is one street line
        street = UNIT_TAIL.sub("", street)
        return {"address": street or None, "city": tokens[i - 1], "region": code,
                "postal": postal if POSTAL.match(postal) else None}
    return {}


def _tz(name: str | None):
    try:
        return ZoneInfo(name) if name else None
    except (ZoneInfoNotFoundError, ValueError):
        return None


def _when(value: str | None) -> datetime | None:
    try:
        d = datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None
    except ValueError:
        return None
    return d if d and d.tzinfo else (d.replace(tzinfo=timezone.utc) if d else None)


_DAY_WORDS = re.compile(r"\b(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?s?\b|\b(?:morning|afternoon|evening|night|weekly)\b", re.I)


def recurrence_key(ev: dict) -> tuple:
    """(store, name without weekday or time of day words): the same weekly event is the same key every week."""
    store = ev.get("store") or {}
    name = " ".join(_DAY_WORDS.sub(" ", norm_text(ev.get("name"))).split())
    return (store.get("id") or store.get("name"), name)


def count_players(registered: int, capacity: int, days_away: int) -> tuple[int | None, bool]:
    """(players, counted registrations). See the module note for when registrations are trusted."""
    if registered and (not capacity or registered >= capacity * EARLY_REGISTRATION_SHARE or days_away <= EARLY_DAYS):
        return registered, True
    return capacity or None, False


def convert(ev: dict, game: Game, today, major_templates: set[str], recurring: frozenset | set = frozenset()) -> dict | None:
    """One platform event as a partial show record, or None when it is not wanted.

    `recurring` holds the recurrence keys that appear RECURRING_MIN times or more in the whole list."""
    if ev.get("event_is_online") or ev.get("is_test_event") or ev.get("is_template"):
        return None
    store = ev.get("store") or {}
    if EMAIL_RX.search(str(store.get("name") or "")) or PHONE_RX.search(str(store.get("name") or "")):
        return None  # a host whose name is an e-mail address or a phone number is a person, often at home; not published
    country = COUNTRIES.get(str(store.get("country") or "").upper())
    start_utc = _when(ev.get("start_datetime"))
    tz = _tz(ev.get("timezone"))
    if country is None or start_utc is None or tz is None or not ev.get("id"):
        return None
    start = start_utc.astimezone(tz)
    if start.date() < today:
        return None

    capacity = int(ev.get("capacity") or 0)
    registered = int(ev.get("registered_user_count") or 0)
    name = " ".join(EMAIL_RX.sub(" ", str(ev.get("name") or "")).split())  # an address typed into an event name is not kept
    major = bool(MAJOR.search(name)) or str(ev.get("event_configuration_template") or "") in major_templates
    days_away = (start.date() - today).days
    big = capacity >= BIG_CAPACITY or (major and capacity >= TEMPLATE_MIN_CAPACITY)
    routine = bool(ROUTINE.search(name)) or recurrence_key(ev) in recurring
    tournament = bool(ev.get("is_headlining_event")) or (big and not routine)
    if not tournament and days_away > STORE_WINDOW_DAYS:
        return None

    where = parse_address(ev.get("full_address")) or parse_address(store.get("full_address"))
    region = where.get("region") or region_code(store.get("state"))
    city = where.get("city") or store.get("city")
    if not region or not city or country_of_region(region) != country:
        return None
    venue = {"city": title_city(str(city).strip()), "region": region, "country": country, "address": where.get("address"),
             "postal": where.get("postal")}
    same_place = norm_text(store.get("city")) == norm_text(city)
    if same_place:  # an event moved to another town is not at the store's address
        venue["name"] = store.get("name")
    lat, lon = ev.get("latitude"), ev.get("longitude")
    if isinstance(lat, (int, float)) and isinstance(lon, (int, float)) and regions.in_region(lat, lon, region) is not False \
            and regions.in_country(lat, lon, country) is not False and (lat, lon) != (0, 0):
        venue["lat"], venue["lon"] = lat, lon

    days = [start.date() + timedelta(days=i) for i in range(max(int(ev.get("number_of_days") or 1), 1))]
    rows = [{"date": d.isoformat(), "open": None, "close": None} for d in days]
    rows[0]["open"] = start.strftime("%H:%M")
    end = _when(ev.get("end_datetime"))
    if end and not ev.get("is_end_datetime_estimated"):
        end_local = end.astimezone(tz)
        if end_local.date() == days[-1] and end_local - start >= timedelta(minutes=30):  # a few seconds after the start is a placeholder
            rows[-1]["close"] = end_local.strftime("%H:%M")

    players, counted_registered = count_players(registered, capacity, days_away)
    notes = []
    cost = ev.get("cost_in_cents")
    cur = (ev.get("currency") or ("CAD" if country == "CA" else "USD")).upper()
    if isinstance(cost, int):
        notes.append("No player entry fee" if cost == 0 else f"Player entry fee {money_text(cost / 100, cur)}")
    if counted_registered:
        notes.append(f"{registered} {'player' if registered == 1 else 'players'} registered" + (f" of {capacity} places" if capacity else ""))
    elif registered:
        notes.append(f"{capacity} places, {registered} registered so far")
    elif capacity:
        notes.append(f"{capacity} places, none registered yet")
    status = "cancelled" if "CANCEL" in str(ev.get("event_status") or "").upper() or \
        "CANCEL" in str((ev.get("settings") or {}).get("event_lifecycle_status") or "").upper() else "scheduled"
    rec: dict = {
        "name": name,
        "event_type": "tournament" if tournament else "store_event",
        "status": status,
        "days": rows,
        "timezone": ev.get("timezone"),
        "venue": venue,
        "sells": {"tcg": [game.sells_id]},
        "links": {"official": game.page.format(id=ev["id"])},
        "source_url": game.page.format(id=ev["id"]),
        "store_key": f"{game.sells_id}-{ev['id']}",  # a store event's id is made from this and the date
    }
    if players:
        rec["size"] = {"players": players}
    if notes:
        rec["admission"] = {"notes": ". ".join(notes) + "."}
    if tournament:
        site = norm_url(store.get("website")) if store.get("website") else None
        if site and any(w in host_of(site) + "/" for w in SOCIAL):
            site = None  # a social media page is not kept: it may be a person's profile rather than the shop's site
        if store.get("name"):
            rec["organizer"] = {"name": store["name"], "url": site}
    return rec


def harvest_game(ctx, game: Game) -> Iterable[dict]:
    client = Client(ctx, game)
    major = major_template_ids(client, ctx.log)
    after = datetime.combine(ctx.today, time.min, tzinfo=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    events: dict = {}  # by event id, so an event found by two circles is kept once
    for label, lat, lon, miles in CENTERS:
        page = 1
        while page:
            data = client.get("/events/", {
                "game_slug": game.game_slug, "latitude": lat, "longitude": lon, "num_miles": miles,
                "display_statuses": "upcoming", "start_date_after": after, "page_size": PAGE_SIZE, "page": page})
            if not isinstance(data, dict) or not isinstance(data.get("results"), list):
                raise LayoutChanged(game.source, game.api + "/events/", "an object with a results list and count", type(data).__name__)
            results = data["results"]
            if page == 1 and results and not all(k in results[0] for k in ("id", "start_datetime", "store", "capacity")):
                raise LayoutChanged(game.source, game.api + "/events/", "events with id, start_datetime, store and capacity",
                                    f"fields {sorted(results[0])[:12]}")
            for ev in results:
                events.setdefault(ev.get("id"), ev)
            nxt = data.get("next_page_number")
            page = nxt if results and isinstance(nxt, int) and nxt > page else 0
    if not events:
        raise LayoutChanged(game.source, game.api + "/events/", "upcoming events for the US and Canada", "none at all")
    # a second pass, now that every event is known: which weekly events repeat
    seen_keys = Counter(recurrence_key(ev) for ev in events.values())
    recurring = {k for k, n in seen_keys.items() if n >= RECURRING_MIN}
    counts = {"tournament": 0, "store_event": 0}
    for ev in events.values():
        rec = convert(ev, game, ctx.today, major, recurring)
        if rec is not None:
            counts[rec["event_type"]] += 1
            yield rec
    ctx.log(f"{game.source}: read {len(events)} upcoming events in {client.requests} requests; kept {counts['tournament']} tournaments "
            f"and {counts['store_event']} store events (starting within {STORE_WINDOW_DAYS} days)")
