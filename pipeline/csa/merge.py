"""csa merge: many sources in, one canonical list of shows out (DATA_MODEL sections 1, 5 and 8).

Order of work:
  1. read every contribution (harvest files, research files, approved submissions);
  2. expand recurring series into editions;
  3. group contributions that describe the same edition, and list near misses for a person to look at;
  4. pick each field from the best source (corrections, organizer, promoter feed, listing sites,
     research, community, in that order);
  5. give every edition a stable id through data/registry.jsonl;
  6. apply approved fixes, then data/corrections.yaml last;
  7. write shows, store events, series and promoters.
"""

from __future__ import annotations

import bisect
import copy
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import yaml
from rapidfuzz import fuzz

from . import model
from .geocode import GeoCache, PostalTable, fill_from_cache
from .normalize import repair_edition
from .paths import Paths
from .recurring import TENTATIVE_NOTE, expand_series
from .sourcesreg import by_id
from .textparse import EMAIL_RX
from .util import (deep_get, deep_set, haversine_km, is_empty, norm_text, parse_iso_date, read_json,
                   read_jsonl, slugify, today as today_fn, write_jsonl)
from .vocab import Vocab

NEAR_KM = 1.5
NAME_MATCH = 80
NAME_NEAR = 50
NAME_STRONG = 90
SAME_CITY_KM = 15
DATE_SLACK_DAYS = 3

TIER_CORRECTIONS, TIER_ORGANIZER, TIER_PROMOTER, TIER_LISTING, TIER_RESEARCH, TIER_COMMUNITY = 1, 2, 3, 4, 5, 6

GENERIC_WORDS = {"the", "a", "an", "and", "of", "in", "at", "card", "cards", "show", "shows", "sports", "sport",
                 "trading", "tcg", "collectibles", "collectible", "collector", "collectors", "expo", "monthly",
                 "annual", "memorabilia", "comic", "comics", "toy", "toys", "swap", "meet", "trade", "day",
                 "spring", "summer", "fall", "winter", "edition", "event", "con", "convention"}
VENUE_WORDS = {"centre": "center", "ctr": "center", "the": "", "hs": "high school"}
STREET_WORDS = {"street": "st", "avenue": "ave", "road": "rd", "boulevard": "blvd", "drive": "dr", "lane": "ln",
                "highway": "hwy", "route": "rt", "north": "n", "south": "s", "east": "e", "west": "w",
                "court": "ct", "place": "pl", "parkway": "pkwy", "suite": "ste"}
ATOMIC_PATHS = ("admission", "vendor.tables", "size.reported_attendance")


# ---------------------------------------------------------------- data classes

@dataclass
class Contribution:
    rec: dict
    tier: int
    source: str
    priority: float
    order: int
    origin: str
    generated: str | None = None
    cadence: str | None = None
    start: date = None  # type: ignore[assignment]
    end: date = None  # type: ignore[assignment]
    country: str | None = None
    region: str | None = None
    # cached comparison values
    name_key: str = ""
    venue_key: str = ""
    street_key: str = ""
    city_key: str = ""

    @property
    def rank(self) -> tuple:
        return (self.tier, self.priority, self.source, self.order)

    @property
    def venue(self) -> dict:
        return self.rec.get("venue") or {}

    def coords(self) -> tuple[float, float] | None:
        v = self.venue
        if v.get("lat") is not None and v.get("lon") is not None:
            return v["lat"], v["lon"]
        return None


@dataclass
class MergeReport:
    contributions: dict[str, int] = field(default_factory=dict)
    unplaced: int = 0
    clusters: int = 0
    shows: int = 0
    store_events: int = 0
    series: int = 0
    promoters: int = 0
    carried_forward: int = 0
    suppressed: int = 0
    near_misses: int = 0
    patches_applied: int = 0
    corrections_applied: int = 0
    warnings: list[str] = field(default_factory=list)

    def lines(self) -> list[str]:
        src = ", ".join(f"{k} {v}" for k, v in sorted(self.contributions.items())) or "none"
        out = [f"Read contributions: {src}.",
               f"Wrote {self.shows} shows, {self.store_events} store events, {self.series} series, {self.promoters} promoters "
               f"({self.carried_forward} carried forward from the last run).",
               f"  {self.near_misses} possible duplicates listed for review, {self.unplaced} records without usable dates, "
               f"{self.suppressed} removed by request, {self.patches_applied} approved fixes and "
               f"{self.corrections_applied} corrections applied."]
        out += [f"  warning: {w}" for w in self.warnings[:30]]
        if len(self.warnings) > 30:
            out.append(f"  and {len(self.warnings) - 30} more warnings")
        return out


# ---------------------------------------------------------------- comparison helpers

def _norm_venue_name(name: str | None) -> str:
    toks = [VENUE_WORDS.get(t, t) for t in norm_text(name).split()]
    return " ".join(t for t in toks if t)


def _norm_street(address: str | None) -> str:
    return " ".join(STREET_WORDS.get(t, t) for t in norm_text(address).split())


def _stripped_name(name: str | None) -> str:
    toks = [t for t in norm_text(name).split() if t not in GENERIC_WORDS]
    return " ".join(toks)


def name_similarity(a: Contribution, b: Contribution) -> float:
    sa, sb = _stripped_name(a.rec.get("name")), _stripped_name(b.rec.get("name"))
    if sa and sb:
        return fuzz.token_set_ratio(sa, sb)
    return fuzz.ratio(norm_text(a.rec.get("name")), norm_text(b.rec.get("name")))


def distance_km(a: Contribution, b: Contribution) -> float | None:
    ca, cb = a.coords(), b.coords()
    if ca and cb:
        return haversine_km(ca[0], ca[1], cb[0], cb[1])
    return None


def same_venue(a: Contribution, b: Contribution) -> bool:
    d = distance_km(a, b)
    if d is not None and d <= NEAR_KM:
        return True
    if a.region and b.region and a.region != b.region:
        return False
    if a.venue_key and a.venue_key == b.venue_key and (not a.city_key or not b.city_key or a.city_key == b.city_key):
        return True
    if a.street_key and a.street_key == b.street_key and a.city_key == b.city_key:
        return True
    return False


def prepare(c: Contribution) -> Contribution:
    v = c.venue
    c.start = parse_iso_date(c.rec["days"][0]["date"])
    c.end = parse_iso_date(c.rec["days"][-1]["date"]) or c.start
    c.region = v.get("region")
    c.country = v.get("country") or ("CA" if c.region in ("AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT")
                                      else "US" if c.region else None)
    c.venue_key = _norm_venue_name(v.get("name"))
    c.street_key = _norm_street(v.get("address"))
    c.city_key = norm_text(v.get("city"))
    return c


# ---------------------------------------------------------------- loading

def _tier_for(verification: str | None, base: int) -> int:
    return TIER_ORGANIZER if verification == "organizer_confirmed" and base in (TIER_RESEARCH, TIER_COMMUNITY) else base


def load_contributions(paths: Paths, vocab: Vocab, today: date,
                       report: MergeReport) -> tuple[list[Contribution], list[dict], list[dict]]:
    registry = by_id(paths.sources_yaml)
    contribs: list[Contribution] = []
    unplaced: list[dict] = []
    order = 0

    def add(rec: dict, tier: int, source: str, origin: str, generated: str | None = None, cadence: str | None = None):
        nonlocal order
        rec, _ = repair_edition(rec, vocab, today)
        days = rec.get("days") or []
        if not days or not (rec.get("venue") or {}).get("city") and not (rec.get("venue") or {}).get("lat"):
            report.unplaced += 1
            unplaced.append({"origin": origin, "name": rec.get("name"), "reason": "no usable date" if not days else "no venue city"})
            return
        entry = registry.get(source, {})
        order += 1
        contribs.append(prepare(Contribution(rec, tier, source, float(entry.get("priority", 100)), order, origin,
                                             generated, cadence)))
        report.contributions[source] = report.contributions.get(source, 0) + 1

    # scripted sources
    for p in sorted(paths.harvest.glob("*.jsonl")) if paths.harvest.exists() else []:
        for rec in read_jsonl(p):
            src = (rec.get("sources") or [{}])[0].get("source") or p.stem
            kind = registry.get(src, {}).get("kind")
            add(rec, TIER_PROMOTER if kind == "promoter" else TIER_LISTING, src, p.name)

    # research agents
    for p in sorted(paths.research.glob("*.jsonl")) if paths.research.exists() else []:
        for rec in read_jsonl(p):
            if rec.get("kind") == "series":
                for ed in expand_series(rec, today):
                    gen, cad = ed.pop("_generated", None), ed.pop("_cadence", None)
                    ed.pop("_series_name", None)
                    add(ed, _tier_for(ed.get("verification"), TIER_RESEARCH), "research", f"{p.name}:{rec.get('research_id')}", gen, cad)
            else:
                add(rec, _tier_for(rec.get("verification"), TIER_RESEARCH), "research", f"{p.name}:{rec.get('research_id')}")

    # approved submissions
    patches: list[dict] = []
    if paths.approved.exists():
        for p in sorted(paths.approved.glob("*.json")):
            item = read_json(p) or {}
            kind = item.get("kind")
            if kind in ("add-show", "organizer"):
                for rec in item.get("records") or []:
                    rec = dict(rec)
                    rec.setdefault("verification", "community")
                    add(rec, _tier_for(rec["verification"], TIER_COMMUNITY), "github_issues", p.name)
            elif kind in ("fix-show", "removal"):
                target = (item.get("target") or {}).get("id")
                if not target:
                    report.warnings.append(f"{p.name}: approved but has no target id, ignored")
                    continue
                patches.append({"id": target, "patch": item.get("patch") or {}, "suppress": bool(item.get("suppress")),
                                "origin": p.name})
            else:
                report.warnings.append(f"{p.name}: unknown kind {kind!r}, ignored")
    return contribs, patches, unplaced


# ---------------------------------------------------------------- clustering

class _UF:
    def __init__(self, n):
        self.p = list(range(n))

    def find(self, x):
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[max(ra, rb)] = min(ra, rb)


def cluster(contribs: list[Contribution]) -> tuple[list[list[int]], list[dict]]:
    """Group contributions into editions. Returns (groups of indexes, near misses)."""
    uf = _UF(len(contribs))
    buckets: dict[tuple, list[int]] = defaultdict(list)
    for i, c in enumerate(contribs):
        buckets[(c.country, c.region)].append(i)
    near: dict[tuple[int, int], str] = {}
    for idxs in buckets.values():
        idxs.sort(key=lambda i: contribs[i].start)
        starts = [contribs[i].start.toordinal() for i in idxs]
        for pos, i in enumerate(idxs):
            a = contribs[i]
            hi = bisect.bisect_right(starts, starts[pos] + DATE_SLACK_DAYS)
            for j in idxs[pos + 1:hi]:
                b = contribs[j]
                sv = same_venue(a, b)
                if a.start == b.start:
                    if sv:
                        sim = name_similarity(a, b)
                        if sim >= NAME_MATCH:
                            uf.union(i, j)
                        elif sim >= NAME_NEAR:
                            near[(i, j)] = "same venue and date, names differ"
                    else:
                        d = distance_km(a, b)
                        if (a.city_key and a.city_key == b.city_key) or (d is not None and d <= SAME_CITY_KM):
                            if name_similarity(a, b) >= NAME_STRONG:
                                near[(i, j)] = "same name and date, venues differ"
                elif sv and a.end >= b.start and name_similarity(a, b) >= NAME_MATCH:
                    near[(i, j)] = "overlapping dates, different start day"
    groups: dict[int, list[int]] = defaultdict(list)
    for i in range(len(contribs)):
        groups[uf.find(i)].append(i)
    out = [sorted(g) for _, g in sorted(groups.items())]
    root_of = {i: uf.find(i) for i in range(len(contribs))}
    pairs = []
    seen = set()
    for (i, j), why in near.items():
        if root_of[i] == root_of[j]:
            continue
        key = tuple(sorted((root_of[i], root_of[j])))
        if key in seen:
            continue
        seen.add(key)
        pairs.append({"reason": why, "a": i, "b": j})
    return out, pairs


# ---------------------------------------------------------------- field resolution

def _first(members: list[Contribution], path: str, skip_generated: bool = False):
    for m in members:
        if skip_generated and m.generated == "tentative":
            continue
        val = deep_get(m.rec, path)
        if not is_empty(val):
            return val
    return None


def _has_admission(a: Any) -> bool:
    return isinstance(a, dict) and any(a.get(k) is not None for k in ("free", "adult", "child"))


def resolve_venue(members: list[Contribution]) -> dict:
    cands = [m for m in members if any(m.venue.get(k) for k in ("name", "address", "city"))]
    if not cands:
        return {}
    win = cands[0]
    v = {k: win.venue.get(k) for k in model.VENUE_KEYS}
    for m in cands[1:]:
        compatible = (not v.get("city") or not m.venue.get("city")
                      or norm_text(v["city"]) == norm_text(m.venue["city"]))
        if not compatible:
            continue
        for k in ("name", "address", "city", "region", "postal", "country"):
            if is_empty(v.get(k)) and not is_empty(m.venue.get(k)):
                v[k] = m.venue[k]
    if v.get("lat") is None:
        for m in cands[1:]:
            if m.coords() and same_venue(win, m):
                v["lat"], v["lon"] = m.venue["lat"], m.venue["lon"]
                v["geo_precision"] = m.venue.get("geo_precision")
                break
    return v


def resolve_days(members: list[Contribution]) -> list[dict]:
    win = next((m for m in members if m.rec.get("days")), None)
    if win is None:
        return []
    days = copy.deepcopy(win.rec["days"])
    for d in days:
        for field_name in ("open", "close"):
            if d.get(field_name):
                continue
            for m in members:
                if m is win:
                    continue
                other = next((x for x in m.rec.get("days") or [] if x.get("date") == d["date"]), None)
                if other and other.get(field_name):
                    d[field_name] = other[field_name]
                    break
    return days


def resolve_cluster(members: list[Contribution], today: date) -> dict:
    members = sorted(members, key=lambda m: m.rank)
    out: dict[str, Any] = {}
    real = [m for m in members if m.generated != "tentative"]
    all_tentative = not real

    out["name"] = _first(members, "name")
    et = _first(members, "event_type")
    if et:
        out["event_type"] = et
    status = _first(members, "status", skip_generated=True)
    out["status"] = status or ("tentative" if all_tentative else "scheduled")
    out["days"] = resolve_days(members)
    tz = _first(members, "timezone")
    if tz:
        out["timezone"] = tz
    out["venue"] = resolve_venue(members)
    sells = {}
    for g in ("tcg", "sports", "other"):
        sells[g] = list(_first(members, f"sells.{g}") or [])
    out["sells"] = sells
    if not any(sells.values()):
        mix = _first(members, "mix")
        if mix:
            out["mix"] = mix

    adm_src = next((m.rec["admission"] for m in members if _has_admission(m.rec.get("admission"))), None)
    if adm_src:
        out["admission"] = dict(adm_src)
        if not out["admission"].get("notes"):
            out["admission"]["notes"] = _first(members, "admission.notes")
    size = {}
    for k in ("tables", "booths", "venue_sqft", "players", "first_year", "edition"):
        size[k] = _first(members, f"size.{k}")
    size["reported_attendance"] = _first(members, "size.reported_attendance")
    out["size"] = size

    vendor = {}
    for k in ("application_url", "opens", "deadline", "electricity", "setup", "contact", "notes"):
        vendor[k] = _first(members, f"vendor.{k}")
    vendor["tables"] = copy.deepcopy(_first(members, "vendor.tables") or [])
    vstat = next((m.rec["vendor"]["status"] for m in members
                  if (m.rec.get("vendor") or {}).get("status") not in (None, "unknown")), None)
    vendor["status"] = vstat or "unknown"
    out["vendor"] = vendor

    org_src = next((m.rec["organizer"] for m in members if (m.rec.get("organizer") or {}).get("name")), None)
    if org_src:
        out["organizer"] = {k: org_src.get(k) for k in model.ORGANIZER_KEYS}
        if not out["organizer"].get("url"):
            out["organizer"]["url"] = _first(members, "organizer.url")
    else:
        out["organizer"] = {"name": None, "promoter_id": None, "url": _first(members, "organizer.url")}
    out["links"] = {k: _first(members, f"links.{k}") for k in model.LINK_KEYS}

    # sources: every contributing source, once per (source, url), with the union of their fields
    merged_sources: dict[tuple, dict] = {}
    for m in members:
        for s in m.rec.get("sources") or []:
            key = (s.get("source"), s.get("url"))
            cur = merged_sources.setdefault(key, {"source": s.get("source"), "url": s.get("url"),
                                                   "retrieved": s.get("retrieved"), "fields": []})
            for f in s.get("fields") or []:
                if f not in cur["fields"]:
                    cur["fields"].append(f)
            if s.get("retrieved") and (not cur["retrieved"] or s["retrieved"] > cur["retrieved"]):
                cur["retrieved"] = s["retrieved"]
    out["sources"] = list(merged_sources.values())

    out["verification"] = max((m.rec.get("verification") or "unverified" for m in members),
                              key=lambda v: model.VERIFICATION_RANK.get(v, 0))
    firsts = [d for d in (m.rec.get("first_seen") for m in members) if d]
    out["first_seen"] = min(firsts) if firsts else today.isoformat()
    seen = [m.rec.get("last_checked") for m in members if m.rec.get("last_checked")]
    seen += [s["retrieved"] for s in out["sources"] if s.get("retrieved")]
    out["last_checked"] = max(seen) if seen else today.isoformat()

    summary = _first(members, "summary", skip_generated=True)
    if all_tentative:
        own = _first(members, "summary")
        summary = f"{own} {TENTATIVE_NOTE}" if own else TENTATIVE_NOTE
    out["summary"] = summary
    return out


# ---------------------------------------------------------------- registry and ids

@dataclass
class Registry:
    entries: list[dict]
    by_id: dict[str, dict] = field(default_factory=dict)
    by_key: dict[str, list[dict]] = field(default_factory=lambda: defaultdict(list))
    by_place: dict[tuple, list[dict]] = field(default_factory=lambda: defaultdict(list))
    series_taken: set = field(default_factory=set)

    @classmethod
    def load(cls, path: Path) -> "Registry":
        reg = cls(read_jsonl(path))
        for e in reg.entries:
            reg.index(e)
        return reg

    def index(self, e: dict) -> None:
        self.by_id[e["id"]] = e
        for k in e.get("keys", []):
            if e not in self.by_key[k]:
                self.by_key[k].append(e)
        place = (e.get("city"), e.get("region"))
        if e not in self.by_place[place]:
            self.by_place[place].append(e)
        if e.get("series_id"):
            self.series_taken.add(e["series_id"])

    def resolve(self, e: dict) -> dict:
        """Follow alias_of to the entry that survived."""
        seen = 0
        while e.get("alias_of") and e["alias_of"] in self.by_id and seen < 10:
            e = self.by_id[e["alias_of"]]
            seen += 1
        return e


def match_keys(members: list[Contribution]) -> list[str]:
    keys = []
    for m in members:
        base = f"{m.start.isoformat()}|{m.country or '?'}"
        city = m.city_key
        if m.venue_key:
            keys.append(f"{base}|v:{m.venue_key}|c:{city}")
        if m.street_key:
            keys.append(f"{base}|a:{m.street_key}|c:{city}")
        if m.coords():
            lat, lon = m.coords()  # type: ignore[misc]
            keys.append(f"{base}|g:{lat:.3f},{lon:.3f}")
    return sorted(set(keys))


def assign_identity(reg: Registry, members: list[Contribution], merged: dict, today: date,
                    used_ids: set[str]) -> tuple[str, str, dict]:
    """Return (id, series_id, registry entry) for a cluster, creating a new entry when nothing matches."""
    keys = match_keys(members)
    name_probe = Contribution({"name": merged["name"]}, 0, "", 0, 0, "")
    candidates: dict[str, dict] = {}
    for k in keys:
        for e in reg.by_key.get(k, []):
            e = reg.resolve(e)
            if e["id"] in used_ids:
                continue
            probe = Contribution({"name": e.get("name")}, 0, "", 0, 0, "")
            if e.get("norm_name") == norm_text(merged["name"]) or name_similarity(name_probe, probe) >= NAME_NEAR:
                candidates[e["id"]] = e
    start = merged["days"][0]["date"]
    v = merged["venue"]
    if candidates:
        entry = sorted(candidates.values(), key=lambda e: (e.get("first_seen") or "9999", e["id"]))[0]
        for other in candidates.values():
            if other is not entry:
                other["alias_of"] = entry["id"]
                entry["keys"] = sorted(set(entry.get("keys", [])) | set(other.get("keys", [])))
        entry["keys"] = sorted(set(entry.get("keys", [])) | set(keys))
        entry["name"] = merged["name"]
        entry["norm_name"] = norm_text(merged["name"])
        entry["norm_venue"] = _norm_venue_name(v.get("name"))
        entry["city"], entry["region"] = norm_text(v.get("city")), v.get("region")
        reg.index(entry)
        return entry["id"], entry["series_id"], entry

    series_id = _find_series(reg, merged)
    base_id = f"{series_id}-{start}"
    new_id, n = base_id, 1
    while new_id in reg.by_id or new_id in used_ids:
        n += 1
        new_id = f"{base_id}-{n}"
    entry = {"id": new_id, "series_id": series_id, "first_seen": merged["first_seen"] or today.isoformat(),
             "name": merged["name"], "norm_name": norm_text(merged["name"]),
             "norm_venue": _norm_venue_name(v.get("name")), "city": norm_text(v.get("city")),
             "region": v.get("region"), "keys": keys}
    reg.entries.append(entry)
    reg.index(entry)
    return new_id, series_id, entry


def _find_series(reg: Registry, merged: dict) -> str:
    """Reuse the series of a similar show at the same place, else make a new readable series id."""
    v = merged["venue"]
    city, region = norm_text(v.get("city")), v.get("region")
    nv = _norm_venue_name(v.get("name"))
    probe = Contribution({"name": merged["name"]}, 0, "", 0, 0, "")
    for e in reg.by_place.get((city, region), []):
        if not e.get("series_id") or e.get("alias_of"):
            continue
        if nv and e.get("norm_venue") and e["norm_venue"] != nv:
            continue
        if name_similarity(probe, Contribution({"name": e.get("name")}, 0, "", 0, 0, "")) >= NAME_STRONG - 5:
            return e["series_id"]
    slug = slugify(f"{merged['name']} {v.get('city')} {v.get('region')}")
    if slug in reg.series_taken:
        alt = slugify(f"{merged['name']} {v.get('name')} {v.get('city')} {v.get('region')}")
        slug = alt if alt not in reg.series_taken else slug
        base, n = slug, 1
        while slug in reg.series_taken:
            n += 1
            slug = f"{base}-{n}"
    return slug


# ---------------------------------------------------------------- corrections

def load_corrections(path: Path) -> dict[str, dict]:
    if not Path(path).exists():
        return {}
    data = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
    if not isinstance(data, dict):
        raise ValueError(f"{path} must map show ids to corrections")
    return {str(k): (v or {}) for k, v in data.items()}


def apply_set(rec: dict, patch: dict, warnings: list[str], who: str) -> int:
    n = 0
    for path, value in patch.items():
        top = path.split(".")[0]
        if top not in model.SHOW_KEY_ORDER or top in ("id", "estimate"):
            warnings.append(f"{who}: cannot set {path!r}")
            continue
        if isinstance(value, date):
            value = value.isoformat()
        deep_set(rec, path, value)
        n += 1
    return n


# ---------------------------------------------------------------- series and promoters

def infer_cadence(dates: list[date]) -> str | None:
    ds = sorted(set(dates))
    if len(ds) < 3:
        return None
    wd = Counter(d.weekday() for d in ds)
    top_wd, top_n = wd.most_common(1)[0]
    if top_n / len(ds) < 0.6:
        return None
    mine = [d for d in ds if d.weekday() == top_wd]
    gaps = [(b - a).days for a, b in zip(mine, mine[1:])]
    if gaps and sum(1 for g in gaps if g == 7) / len(gaps) >= 0.6:
        return f"Every {_WEEKDAY_NAMES[top_wd]}"
    months = {(d.year, d.month) for d in mine}
    if len(months) < 3:
        return None
    nths = Counter()
    for d in mine:
        nths[(d.day - 1) // 7 + 1] += 1
        if d.day + 7 > _days_in_month(d):
            nths[-1] += 1
    nth, count = nths.most_common(1)[0]
    if count / len(mine) < 0.6:
        return None
    label = "Last" if nth == -1 else _ORDINALS[nth]
    return f"{label} {_WEEKDAY_NAMES[top_wd]} of most months"


_WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
_ORDINALS = {1: "First", 2: "Second", 3: "Third", 4: "Fourth"}


def _days_in_month(d: date) -> int:
    import calendar
    return calendar.monthrange(d.year, d.month)[1]


def build_series(shows: list[dict], cadence_hints: dict[str, str]) -> list[dict]:
    by_series: dict[str, list[dict]] = defaultdict(list)
    for s in shows:
        by_series[s["series_id"]].append(s)
    out = []
    for sid, eds in sorted(by_series.items()):
        eds.sort(key=lambda s: s["days"][0]["date"])
        latest = eds[-1]
        v_counts = Counter((e["venue"].get("name"), e["venue"].get("city"), e["venue"].get("region")) for e in eds)
        usual = v_counts.most_common(1)[0][0]
        usual_ed = next(e for e in reversed(eds) if (e["venue"].get("name"), e["venue"].get("city"), e["venue"].get("region")) == usual)
        venue = {k: usual_ed["venue"].get(k) for k in ("name", "city", "region", "country", "lat", "lon")}
        promoters = Counter(e["organizer"].get("promoter_id") for e in eds if e["organizer"].get("promoter_id"))
        dates = [parse_iso_date(e["days"][0]["date"]) for e in eds if e["status"] != "cancelled"]
        history = []
        for e in eds:
            ra = e["size"].get("reported_attendance")
            if ra or e["size"].get("tables"):
                history.append({"date": e["days"][0]["date"], "attendance": ra["value"] if ra else None,
                                "tables": e["size"].get("tables")})
        out.append({
            "id": sid, "name": latest["name"],
            "promoter_id": promoters.most_common(1)[0][0] if promoters else None,
            "venue": venue,
            "cadence": cadence_hints.get(sid) or infer_cadence([d for d in dates if d]),
            "editions": [e["id"] for e in eds],
            "links": {k: next((e["links"].get(k) for e in reversed(eds) if e["links"].get(k)), None) for k in model.LINK_KEYS},
            "history": history,
        })
    return out


def build_promoters(shows: list[dict]) -> list[dict]:
    by_p: dict[str, list[dict]] = defaultdict(list)
    for s in shows:
        pid = s["organizer"].get("promoter_id")
        if pid:
            by_p[pid].append(s)
    out = []
    for pid, eds in sorted(by_p.items()):
        names = Counter(e["organizer"]["name"] for e in eds if e["organizer"].get("name"))
        urls = Counter(e["organizer"]["url"] for e in eds if e["organizer"].get("url"))
        regs = Counter(e["venue"].get("region") for e in eds if e["venue"].get("region"))
        contacts = Counter(c for c in (e["vendor"].get("contact") for e in eds)
                           if c and (EMAIL_RX.fullmatch(c) or c.startswith("http")))
        series = sorted({e["series_id"] for e in eds})
        url = urls.most_common(1)[0][0] if urls else None
        out.append({
            "id": pid, "name": names.most_common(1)[0][0] if names else pid, "url": url,
            "region": regs.most_common(1)[0][0] if regs else None, "series": series,
            "links": {"website": url, "facebook": next((e["links"].get("facebook") for e in eds if e["links"].get("facebook")), None),
                      "instagram": next((e["links"].get("instagram") for e in eds if e["links"].get("instagram")), None)},
            "public_contact": contacts.most_common(1)[0][0] if contacts else None,
        })
    return out


# ---------------------------------------------------------------- the whole merge

def run_merge(paths: Paths, vocab: Vocab, today: date | None = None) -> MergeReport:
    today = today or today_fn()
    report = MergeReport()
    contribs, patches, unplaced_rows = load_contributions(paths, vocab, today, report)

    cache = GeoCache(paths.geocache, today)
    postal = PostalTable.load(paths.postal_dir)
    for c in contribs:
        if c.coords() is None:
            from .geocode import resolve_from_cache
            got, _ = resolve_from_cache(c.venue, cache, postal)
            if got:
                c.rec["venue"] = {**c.venue, "lat": got[0], "lon": got[1], "geo_precision": got[2]}

    groups, near_pairs = cluster(contribs)
    report.clusters = len(groups)
    reg = Registry.load(paths.registry)
    corrections = load_corrections(paths.corrections_yaml)

    # removal requests that suppress a whole show
    for p in patches:
        if p["suppress"]:
            entry = reg.by_id.get(p["id"])
            if entry is None:
                report.warnings.append(f"{p['origin']}: no show with id {p['id']} to remove")
            else:
                entry["suppressed"] = True

    prior = {r["id"]: r for r in read_jsonl(paths.shows) + read_jsonl(paths.store_events)}
    used_ids: set[str] = set()
    merged_shows: list[dict] = []
    cadence_hints: dict[str, str] = {}
    id_of_group: dict[int, str] = {}

    for gi, idxs in enumerate(groups):
        members = [contribs[i] for i in idxs]
        merged = resolve_cluster(members, today)
        if not merged.get("name") or not merged["days"]:
            continue
        sid_id, series_id, entry = assign_identity(reg, members, merged, today, used_ids)
        if entry.get("suppressed"):
            report.suppressed += 1
            used_ids.add(sid_id)
            continue
        used_ids.add(sid_id)
        entry["first_seen"] = min(entry.get("first_seen") or merged["first_seen"], merged["first_seen"])
        # A date made up from a series rule is not kept once the rule stops making it.
        entry["generated_tentative"] = all(m.generated == "tentative" for m in members)
        merged["id"], merged["series_id"] = sid_id, series_id
        merged["first_seen"] = entry["first_seen"]
        for i in idxs:
            id_of_group[i] = sid_id
        hint = next((m.cadence for m in members if m.cadence), None)
        if hint:
            cadence_hints[series_id] = hint
        merged_shows.append(merged)

    # carry forward anything we knew before that no source mentions today
    produced = {s["id"] for s in merged_shows}
    carried = []
    for pid, rec in prior.items():
        if pid in produced:
            continue
        entry = reg.by_id.get(pid)
        if entry and entry.get("suppressed"):
            report.suppressed += 1
            continue
        if entry and entry.get("generated_tentative"):
            continue
        rec = copy.deepcopy(rec)
        rec["estimate"] = None
        carried.append(rec)
        report.carried_forward += 1
    all_records = merged_shows + [complete_for_carry(r) for r in carried]

    # promoters ids
    for s in all_records:
        org = s.get("organizer") or {}
        if org.get("name") and not org.get("promoter_id"):
            org["promoter_id"] = slugify(org["name"])

    # approved fixes, then corrections last
    by_id = {s["id"]: s for s in all_records}
    for p in patches:
        if p["suppress"] or not p["patch"]:
            continue
        target = by_id.get(p["id"])
        if target is None:
            report.warnings.append(f"{p['origin']}: no show with id {p['id']} to fix")
            continue
        report.patches_applied += apply_set(target, p["patch"], report.warnings, p["origin"])
    dropped = set()
    series_corr, promoter_corr = {}, {}
    for key, corr in corrections.items():
        if key.startswith("series:"):
            series_corr[key[7:]] = corr
            continue
        if key.startswith("promoter:"):
            promoter_corr[key[9:]] = corr
            continue
        target = by_id.get(key)
        if target is None:
            report.warnings.append(f"corrections.yaml: no show with id {key}")
            continue
        if corr.get("drop"):
            dropped.add(key)
            report.corrections_applied += 1
            continue
        report.corrections_applied += apply_set(target, corr.get("set") or {}, report.warnings, f"corrections.yaml {key}")
    all_records = [s for s in all_records if s["id"] not in dropped]

    # finish each record
    finished = []
    for s in all_records:
        s = model.complete_show(s)
        if any(s["sells"].values()):
            s["mix"] = model.derive_mix(s["sells"])
        s["estimate"] = None
        fill_from_cache(s, cache, postal)
        finished.append(s)
    finished.sort(key=lambda s: s["id"])

    # possible duplicates, with final ids
    dup_rows = []
    for pr in near_pairs:
        a, b = contribs[pr["a"]], contribs[pr["b"]]
        ida, idb = id_of_group.get(pr["a"]), id_of_group.get(pr["b"])
        if ida is None or idb is None or ida == idb:
            continue
        dup_rows.append({"reason": pr["reason"], "a": _brief(ida, a), "b": _brief(idb, b)})
    ids_now = {s["id"] for s in finished}
    series_dates = defaultdict(list)
    for s in finished:
        series_dates[s["series_id"]].append(s)
    for r in carried:
        if r["id"] not in ids_now or parse_iso_date(r["days"][0]["date"]) is None:
            continue
        start = parse_iso_date(r["days"][0]["date"])
        if start >= today:
            for other in series_dates.get(r["series_id"], []):
                o_start = parse_iso_date(other["days"][0]["date"])
                if other["id"] != r["id"] and o_start and abs((o_start - start).days) <= 21 and other["id"] not in prior:
                    dup_rows.append({"reason": "an earlier listing is no longer mentioned and a nearby date in the same series appeared; it may have moved",
                                     "a": {"id": r["id"], "name": r["name"], "date": r["days"][0]["date"]},
                                     "b": {"id": other["id"], "name": other["name"], "date": other["days"][0]["date"]}})
    dup_rows.sort(key=lambda r: (r["a"]["id"], r["b"]["id"]))
    report.near_misses = len(dup_rows)

    events = [s for s in finished if s["event_type"] == "store_event"]
    shows = [s for s in finished if s["event_type"] != "store_event"]
    series = build_series(shows, cadence_hints)
    promoters = build_promoters(shows)
    for s in series:
        corr = series_corr.get(s["id"])
        if corr:
            report.corrections_applied += apply_generic(s, corr.get("set") or {})
    for pm in promoters:
        corr = promoter_corr.get(pm["id"])
        if corr:
            report.corrections_applied += apply_generic(pm, corr.get("set") or {})

    reg.entries.sort(key=lambda e: e["id"])
    write_jsonl(paths.registry, reg.entries, sort_keys=True)
    write_jsonl(paths.shows, shows)
    write_jsonl(paths.store_events, events)
    write_jsonl(paths.series, series)
    write_jsonl(paths.promoters, promoters)
    write_jsonl(paths.possible_duplicates, dup_rows)
    if unplaced_rows:
        write_jsonl(paths.review / "unplaced.jsonl", unplaced_rows)
    elif (paths.review / "unplaced.jsonl").exists():
        (paths.review / "unplaced.jsonl").unlink()
    report.shows, report.store_events = len(shows), len(events)
    report.series, report.promoters = len(series), len(promoters)
    return report


def complete_for_carry(rec: dict) -> dict:
    rec = copy.deepcopy(rec)
    rec["estimate"] = None
    return rec


def apply_generic(obj: dict, patch: dict) -> int:
    for path, value in patch.items():
        deep_set(obj, path, value.isoformat() if isinstance(value, date) else value)
    return len(patch)


def _brief(show_id: str, c: Contribution) -> dict:
    v = c.venue
    return {"id": show_id, "name": c.rec.get("name"), "date": c.start.isoformat(), "venue": v.get("name"),
            "city": v.get("city"), "source": c.source}
