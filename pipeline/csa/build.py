"""csa build: write the files the website reads (DATA_MODEL section 6) into site/public/data/.

Errors from `csa check` stop the build before anything is written. Only the files listed below are
written, and a file is left alone when its content has not changed.

  shows.json         full records, 30 days back to 24 months ahead (a JSON array)
  store_events.json  the store events layer, as lighter records (a JSON array)
  series.json        series with an edition in that window, editions limited to the window (a JSON array)
  promoters.json     promoters of those series (a JSON array)
  vocab.json         a copy of data/vocab.json
  manifest.json      build date, counts, and the credit text for every source used
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

from . import __version__
from .check import CheckReport, run_check
from .paths import Paths
from .sourcesreg import by_id
from .util import add_months, parse_iso_date, read_json, read_jsonl, today as today_fn
from .vocab import Vocab

DAYS_BACK = 30
MONTHS_AHEAD = 24
CONTRACT = 1
STORE_EVENT_DROP = ("vendor", "size", "estimate", "summary", "first_seen", "mix", "organizer")
CREDITS = [
    {"name": "GeoNames postal code coordinates", "url": "https://www.geonames.org/", "license": "CC BY 4.0"},
    {"name": "Map data from OpenStreetMap contributors", "url": "https://www.openstreetmap.org/copyright", "license": "ODbL"},
    {"name": "US Census Bureau Geocoder", "url": "https://geocoding.geo.census.gov/", "license": "public domain"},
]


class BuildBlocked(Exception):
    def __init__(self, report: CheckReport):
        super().__init__("csa check found errors, so nothing was built")
        self.report = report


@dataclass
class BuildReport:
    written: list[str] = field(default_factory=list)
    unchanged: list[str] = field(default_factory=list)
    counts: dict = field(default_factory=dict)
    sizes: dict[str, int] = field(default_factory=dict)
    check: CheckReport | None = None

    def lines(self) -> list[str]:
        c = self.counts
        out = [f"Built {c['shows']} shows, {c['store_events']} store events, {c['series']} series and {c['promoters']} promoters "
               f"for {c['window']['from']} to {c['window']['to']}."]
        for name in sorted(self.sizes):
            out.append(f"  {name}: {self.sizes[name]:,} bytes" + (" (unchanged)" if name in self.unchanged else ""))
        if self.check and self.check.warnings:
            out.append(f"  {len(self.check.warnings)} check warnings (run csa check to read them)")
        return out


def window(today: date) -> tuple[date, date]:
    return today - timedelta(days=DAYS_BACK), add_months(today, MONTHS_AHEAD)


def in_window(rec: dict, start: date, end: date) -> bool:
    days = rec.get("days") or []
    if not days:
        return False
    first, last = parse_iso_date(days[0]["date"]), parse_iso_date(days[-1]["date"])
    return bool(first and last and last >= start and first <= end)


def _dump(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n"


def _write_if_changed(path: Path, text: str) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return False
    path.write_text(text, encoding="utf-8", newline="\n")
    return True


def store_event_row(e: dict) -> dict:
    return {k: v for k, v in e.items() if k not in STORE_EVENT_DROP}


def build_manifest(shows: list[dict], events: list[dict], series: list[dict], promoters: list[dict],
                   registry: dict, start: date, end: date, today: date) -> dict:
    def tally(rows, key):
        out: dict[str, int] = {}
        for r in rows:
            k = key(r)
            if k:
                out[k] = out.get(k, 0) + 1
        return dict(sorted(out.items()))

    used: dict[str, int] = {}
    for r in shows + events:
        for sid in {s["source"] for s in r.get("sources") or [] if s.get("source")}:
            used[sid] = used.get(sid, 0) + 1
    sources = []
    for sid in sorted(used, key=lambda i: (registry.get(i, {}).get("_order", 10**6), i)):
        e = registry.get(sid, {})
        sources.append({"id": sid, "name": e.get("name", sid), "url": e.get("url"), "kind": e.get("kind"),
                        "credit": e.get("credit"), "shows": used[sid]})
    return {
        "built": today.isoformat(), "fixture": False, "contract": CONTRACT, "pipeline": __version__,
        "window": {"from": start.isoformat(), "to": end.isoformat()},
        "counts": {
            "shows": len(shows), "store_events": len(events), "series": len(series), "promoters": len(promoters),
            "by_type": tally(shows, lambda r: r.get("event_type")),
            "by_country": tally(shows, lambda r: (r.get("venue") or {}).get("country")),
        },
        "sources": sources,
        "credits": CREDITS,
    }


def run_build(paths: Paths, vocab: Vocab, today: date | None = None) -> BuildReport:
    today = today or today_fn()
    chk = run_check(paths, vocab, today)
    if not chk.ok:
        raise BuildBlocked(chk)
    start, end = window(today)
    all_shows = read_jsonl(paths.shows)
    shows = sorted((s for s in all_shows if in_window(s, start, end)), key=lambda s: (s["days"][0]["date"], s["id"]))
    events = sorted((store_event_row(e) for e in read_jsonl(paths.store_events) if in_window(e, start, end)),
                    key=lambda e: (e["days"][0]["date"], e["id"]))
    ids = {s["id"] for s in shows}
    series = []
    for sr in read_jsonl(paths.series):
        eds = [e for e in sr.get("editions", []) if e in ids]
        if eds:
            series.append({**sr, "editions": eds})
    series_ids = {s["id"] for s in series}
    promoters = []
    for p in read_jsonl(paths.promoters):
        keep = [s for s in p.get("series", []) if s in series_ids]
        if keep:
            promoters.append({**p, "series": keep})

    rep = BuildReport(check=chk)
    manifest = build_manifest(shows, events, series, promoters, by_id(paths.sources_yaml), start, end, today)
    vocab_text = (paths.vocab.read_text(encoding="utf-8"))
    files = {
        "shows.json": _dump(shows), "store_events.json": _dump(events), "series.json": _dump(series),
        "promoters.json": _dump(promoters), "vocab.json": vocab_text,
        "manifest.json": json.dumps(manifest, ensure_ascii=False, indent=1) + "\n",
    }
    for name, text in files.items():
        changed = _write_if_changed(paths.site_data / name, text)
        (rep.written if changed else rep.unchanged).append(name)
        rep.sizes[name] = len(text.encode("utf-8"))
    rep.counts = {**manifest["counts"], "window": manifest["window"]}
    return rep
