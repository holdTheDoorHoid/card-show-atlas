"""csa stats: what is in the data, and what is missing from the shows that are still to come."""

from __future__ import annotations

from collections import Counter
from datetime import date

from .paths import Paths
from .util import parse_iso_date, read_jsonl, today as today_fn


def _has_hours(s: dict) -> bool:
    return any(d.get("open") and d.get("close") for d in s.get("days") or [])


def _has_vendor_info(s: dict) -> bool:
    v = s.get("vendor") or {}
    return bool(v.get("tables") or v.get("application_url") or v.get("deadline") or (v.get("status") not in (None, "unknown")))


def _has_size_signal(s: dict) -> bool:
    size = s.get("size") or {}
    return any(size.get(k) for k in ("tables", "booths", "players", "venue_sqft", "reported_attendance"))


def compute_stats(shows: list[dict], events: list[dict], today: date) -> dict:
    allr = shows + events

    def count(rows, key):
        c = Counter(key(r) for r in rows)
        c.pop(None, None)
        return dict(sorted(c.items(), key=lambda kv: (-kv[1], kv[0])))

    def last_day(s):
        return parse_iso_date(s["days"][-1]["date"]) if s.get("days") else None

    upcoming = [s for s in shows if (last_day(s) or date.min) >= today]
    sources = Counter()
    for r in allr:
        for sid in {x.get("source") for x in r.get("sources") or []}:
            if sid:
                sources[sid] += 1
    return {
        "shows": len(shows), "store_events": len(events), "upcoming": len(upcoming),
        "by_type": count(allr, lambda r: r.get("event_type")),
        "by_country": count(allr, lambda r: (r.get("venue") or {}).get("country")),
        "by_region": count(allr, lambda r: (r.get("venue") or {}).get("region")),
        "by_verification": count(allr, lambda r: r.get("verification")),
        "by_status": count(allr, lambda r: r.get("status")),
        "by_source": dict(sorted(sources.items(), key=lambda kv: (-kv[1], kv[0]))),
        "upcoming_missing": {
            "coordinates": sum(1 for s in upcoming if (s.get("venue") or {}).get("lat") is None),
            "hours": sum(1 for s in upcoming if not _has_hours(s)),
            "vendor_info": sum(1 for s in upcoming if not _has_vendor_info(s)),
            "size_signal": sum(1 for s in upcoming if not _has_size_signal(s)),
            "coarse_location": sum(1 for s in upcoming if (s.get("venue") or {}).get("geo_precision") in ("postal", "city")),
        },
    }


def render(stats: dict) -> list[str]:
    out = [f"{stats['shows']} shows ({stats['upcoming']} upcoming) and {stats['store_events']} store events."]

    def block(title, d, limit=None):
        out.append("")
        out.append(title)
        items = list(d.items())[:limit]
        width = max([len(str(k)) for k, _ in items] + [1])
        for k, v in items:
            out.append(f"  {str(k):<{width}}  {v}")
        if limit and len(d) > limit:
            out.append(f"  and {len(d) - limit} more")

    block("By type", stats["by_type"])
    block("By country", stats["by_country"])
    block("By state or province", stats["by_region"], 15)
    block("By verification", stats["by_verification"])
    block("By source", stats["by_source"])
    m = stats["upcoming_missing"]
    up = stats["upcoming"]
    out += ["", f"Upcoming shows ({up}) that lack:"]
    for key, label in (("coordinates", "coordinates"), ("hours", "opening hours"), ("vendor_info", "vendor information"),
                       ("size_signal", "any size signal (tables, players, area, attendance)"),
                       ("coarse_location", "an exact location (only a postal code or town centre)")):
        pct = f" ({100 * m[key] // up}%)" if up else ""
        out.append(f"  {label:<55}{m[key]}{pct}")
    return out


def run_stats(paths: Paths, today: date | None = None) -> dict:
    return compute_stats(read_jsonl(paths.shows), read_jsonl(paths.store_events), today or today_fn())
