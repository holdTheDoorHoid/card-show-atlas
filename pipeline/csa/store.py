"""Store events from the scripted sources: kept in data/store/, which is not committed.

Weekly play at card shops comes by the thousand and changes every day, so it would add gigabytes to the
repository over a year. A scripted source that lists store events (the Play Hub, the Riftbound locator, the Star
Wars Unlimited store rounds) writes them to data/store/<source>.jsonl each time it runs, and `csa build` reads
them from there. They skip the merge: they are not matched against other sources, they get no registry entry and
no series, and they are never history. Each record has an id made from the source's own event id and the date,
for example lorcana-1103953-2026-10-24, so the same event keeps the same id from one run to the next with nothing
remembered between runs.

`csa harvest all --store` runs only the sources that list store events and writes only data/store/, and it does
not ask a website a second time on a day it already did (see `done_today`). The deploy workflow uses it, with
data/store kept in the Actions cache for the day.

data/store/_status.json records, per source, the day it was harvested and how many records it wrote.
"""

from __future__ import annotations

import hashlib
from datetime import date
from pathlib import Path

from . import model
from .geocode import GeoCache, PostalTable, fill_from_cache
from .paths import Paths
from .util import read_json, read_jsonl, slugify, write_json, write_jsonl

STATUS_FILE = "_status.json"


def store_path(paths: Paths, source_id: str) -> Path:
    return paths.store_dir / f"{source_id}.jsonl"


def files(paths: Paths) -> list[Path]:
    d = paths.store_dir
    return sorted(d.glob("*.jsonl")) if d.exists() else []


def read_all(paths: Paths) -> list[dict]:
    """Every store event written by the scripted sources, files in name order."""
    out: list[dict] = []
    for f in files(paths):
        out += read_jsonl(f)
    return out


def read_status(paths: Paths) -> dict:
    return read_json(paths.store_dir / STATUS_FILE, {}) or {}


def done_today(paths: Paths, source_id: str, today: date) -> int | None:
    """How many store events were written for this source today, or None when it has not run (well) today."""
    entry = read_status(paths).get(source_id)
    if entry and entry.get("date") == today.isoformat() and store_path(paths, source_id).exists():
        return int(entry.get("records") or 0)
    return None


def write(paths: Paths, source_id: str, rows: list[dict], today: date) -> None:
    write_jsonl(store_path(paths, source_id), rows)
    status = read_status(paths)
    status[source_id] = {"date": today.isoformat(), "records": len(rows)}
    write_json(paths.store_dir / STATUS_FILE, status)


class Finisher:
    """Turns the partial records a source yielded into complete store event records with ids.

    Coordinates come from the source when it has them, otherwise from the committed geocode cache. Nothing
    here asks the network, so a harvest never waits on a map service; `csa geocode` adds the missing ones."""

    def __init__(self, paths: Paths, today: date):
        self.today = today
        self.cache = GeoCache(paths.geocache, today)
        self.postal = PostalTable.load(paths.postal_dir)
        self.taken: set[str] = set()

    def key_for(self, source_id: str, raw_key: str | None, rec: dict) -> str:
        if raw_key:
            key = slugify(raw_key)
            if key:
                return key
        src = ((rec.get("sources") or [{}])[0]).get("url") or ""
        digest = hashlib.sha1(f"{src}|{rec.get('name')}".encode()).hexdigest()[:10]
        return f"{slugify(source_id)}-{digest}"

    def finish(self, rec: dict, source_id: str, raw_key: str | None) -> dict:
        key = self.key_for(source_id, raw_key, rec)
        first = rec["days"][0]["date"]
        ident, n = f"{key}-{first}", 1
        while ident in self.taken:  # two events with one key on one day
            n += 1
            ident = f"{key}-{first}-{n}"
        self.taken.add(ident)
        rec = model.complete_show({**rec, "id": ident, "series_id": key, "first_seen": self.today.isoformat()})
        if any(rec["sells"].values()):
            rec["mix"] = model.derive_mix(rec["sells"])
        rec["estimate"] = None
        fill_from_cache(rec, self.cache, self.postal)
        return rec
