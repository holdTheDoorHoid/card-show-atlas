"""csa check: rules for the data. Errors block the build, warnings are listed.

Run on data/shows.jsonl, data/store_events.jsonl and the store events in data/store/ (and the series and promoter files
they point at).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from . import model, regions, store
from .domains import DomainPolicy
from .paths import Paths
from .sourcesreg import load_sources
from .textparse import PHONE_RX, host_of
from .util import add_months, parse_iso_date, read_jsonl, today as today_fn
from .vocab import Vocab

ERROR, WARNING = "error", "warning"
MAX_SPAN_ERROR = 31
MAX_SPAN_WARN = 14
HOME_WORDS = re.compile(r"\b(residence|private home|my house|my home|home of|backyard)\b", re.I)
APARTMENT = re.compile(r"\b(apt|apartment|unit)\b\.?\s*#?\s*\w+|#\s*\d+[a-z]?\b", re.I)
TIME_RX = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
ID_RX = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*-\d{4}-\d{2}-\d{2}(?:-\d+)?$")
FREE_TEXT = ["summary", "vendor.contact", "vendor.notes", "vendor.electricity", "admission.notes", "organizer.name"]


@dataclass
class Finding:
    severity: str
    show_id: str
    rule: str
    message: str

    def line(self) -> str:
        return f"{self.severity.upper():<8}{self.show_id}  [{self.rule}]  {self.message}"


@dataclass
class CheckReport:
    findings: list[Finding] = field(default_factory=list)
    records: int = 0

    @property
    def errors(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == ERROR]

    @property
    def warnings(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == WARNING]

    @property
    def ok(self) -> bool:
        return not self.errors

    def lines(self, limit: int = 200) -> list[str]:
        out = []
        ordered = sorted(self.findings, key=lambda f: (f.severity != ERROR, f.show_id, f.rule))
        for f in ordered[:limit]:
            out.append(f.line())
        if len(ordered) > limit:
            out.append(f"... and {len(ordered) - limit} more")
        out.append(f"Checked {self.records} records: {len(self.errors)} errors, {len(self.warnings)} warnings.")
        if self.errors:
            out.append("Errors block the build. Fix the data or add a correction in data/corrections.yaml.")
        return out


def _get(rec: dict, path: str):
    cur = rec
    for part in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


def check_show(s: dict, vocab: Vocab, known_sources: set[str], policy: DomainPolicy, today: date) -> list[Finding]:
    sid = s.get("id") or "(no id)"
    out: list[Finding] = []

    def err(rule, msg):
        out.append(Finding(ERROR, sid, rule, msg))

    def warn(rule, msg):
        out.append(Finding(WARNING, sid, rule, msg))

    # ---- required fields
    for path in ("id", "series_id", "name", "event_type", "status", "verification", "first_seen", "last_checked"):
        if not _get(s, path):
            err("required", f"{path} is missing")
    for path in ("venue.city", "venue.region", "venue.country"):
        if not _get(s, path):
            err("required", f"{path} is missing")
    if not s.get("sources"):
        err("required", "sources is empty, every show needs at least one source to credit")
    days = s.get("days") or []
    if not days:
        err("required", "days is empty")
    if s.get("id") and not ID_RX.match(s["id"]):
        err("id", f"{s['id']!r} is not a series slug followed by a date")

    # ---- vocabulary
    if s.get("event_type") and s["event_type"] not in vocab.event_types:
        err("vocab", f"event_type {s['event_type']!r} is not in the vocabulary")
    if s.get("status") and s["status"] not in vocab.statuses:
        err("vocab", f"status {s['status']!r} is not in the vocabulary")
    if s.get("verification") and s["verification"] not in vocab.verifications:
        err("vocab", f"verification {s['verification']!r} is not in the vocabulary")
    vs = _get(s, "vendor.status")
    if vs and vs not in vocab.vendor_statuses:
        err("vocab", f"vendor.status {vs!r} is not in the vocabulary")
    if s.get("mix") and s["mix"] not in ("tcg", "sports", "mixed", "unknown"):
        err("vocab", f"mix {s['mix']!r} is not tcg, sports, mixed or unknown")
    for group, ids in (s.get("sells") or {}).items():
        if group not in ("tcg", "sports", "other"):
            err("vocab", f"sells has an unknown group {group!r}")
            continue
        valid = set(vocab.group_ids(group))
        for i in ids or []:
            if i not in valid:
                err("vocab", f"sells.{group} has {i!r}, which is not in the vocabulary for {group}")

    # ---- dates
    parsed: list[date] = []
    for i, d in enumerate(days):
        dd = parse_iso_date(d.get("date")) if isinstance(d, dict) else None
        if dd is None:
            err("dates", f"days[{i}].date {d.get('date') if isinstance(d, dict) else d!r} is not a date (YYYY-MM-DD)")
            continue
        parsed.append(dd)
        for k in ("open", "close"):
            t = d.get(k)
            if t is not None and not TIME_RX.match(str(t)):
                err("dates", f"days[{i}].{k} {t!r} is not a 24 hour time (HH:MM)")
        if d.get("open") and d.get("close") and TIME_RX.match(str(d["open"])) and TIME_RX.match(str(d["close"])) \
                and d["close"] <= d["open"]:
            warn("dates", f"days[{i}] closes at {d['close']}, which is not after it opens at {d['open']}")
    if parsed:
        if parsed != sorted(set(parsed)):
            err("dates", "days are not in date order without repeats")
        first, last = parsed[0], parsed[-1]
        if first.year < 2000 or first.year > today.year + 3:
            err("dates", f"{first.isoformat()} is a very unlikely year for a show")
        span = (last - first).days
        if span > MAX_SPAN_ERROR:
            err("dates", f"the days run for {span + 1} days, which is not one show")
        elif span > MAX_SPAN_WARN:
            warn("dates", f"the days run for {span + 1} days, check they belong to one show")
        if first > add_months(today, 24):
            warn("dates", f"{first.isoformat()} is more than 24 months away and will not be published yet")
        size = s.get("size") or {}
        has_size = any(size.get(k) for k in ("tables", "booths", "players", "venue_sqft", "reported_attendance"))
        fs = parse_iso_date(s.get("first_seen"))
        if fs and (fs - last).days > 60 and s.get("status") in ("scheduled", "tentative") and not has_size \
                and (today - fs).days < 30:
            warn("dates", f"this show ended {(fs - last).days} days before we first saw it and says nothing about its size. Is the year right?")

    # ---- timezone
    tz = s.get("timezone")
    if tz:
        try:
            ZoneInfo(tz)
        except (ZoneInfoNotFoundError, ValueError):
            err("timezone", f"{tz!r} is not an IANA time zone name")
    else:
        warn("timezone", "no time zone yet (it is filled in from the coordinates)")

    # ---- coordinates
    v = s.get("venue") or {}
    lat, lon = v.get("lat"), v.get("lon")
    if (lat is None) != (lon is None):
        err("coordinates", "only one of lat and lon is set")
    elif lat is not None:
        if not (isinstance(lat, (int, float)) and isinstance(lon, (int, float)) and -90 <= lat <= 90 and -180 <= lon <= 180):
            err("coordinates", f"({lat}, {lon}) are not valid coordinates")
        else:
            region, country = v.get("region"), v.get("country")
            if region in regions.REGION_COUNTRY and regions.in_region(lat, lon, region) is False:
                err("coordinates", f"({lat}, {lon}) is outside {region}")
            elif country in ("US", "CA") and regions.in_country(lat, lon, country) is False:
                err("coordinates", f"({lat}, {lon}) is outside {country}")
        if v.get("geo_precision") not in model.GEO_PRECISIONS:
            err("coordinates", f"geo_precision {v.get('geo_precision')!r} must be one of {', '.join(model.GEO_PRECISIONS)}")
    else:
        if days and parsed and parsed[-1] >= today:
            warn("coordinates", "no coordinates yet, so this show will not appear on the map")
    if v.get("region") and v["region"] not in regions.REGION_COUNTRY:
        err("required", f"venue.region {v['region']!r} is not a state or province code")
    elif v.get("region") and v.get("country") and regions.country_of_region(v["region"]) != v["country"]:
        err("required", f"venue.region {v['region']} does not belong to country {v['country']}")

    # ---- money
    cur_country = {"US": "USD", "CA": "CAD"}.get(v.get("country"))
    adm = s.get("admission") or {}
    prices = [("admission.adult", adm.get("adult")), ("admission.child", adm.get("child"))]
    for i, t in enumerate(_get(s, "vendor.tables") or []):
        prices.append((f"vendor.tables[{i}].price", t.get("price")))
        if t.get("price") is not None and not t.get("currency"):
            err("money", f"vendor.tables[{i}] has a price but no currency")
        elif t.get("currency") and t["currency"] not in model.CURRENCIES:
            err("money", f"vendor.tables[{i}].currency {t['currency']!r} must be USD or CAD")
        elif t.get("currency") and cur_country and t["currency"] != cur_country:
            warn("money", f"vendor.tables[{i}] is priced in {t['currency']} for a show in {v.get('country')}. Check it.")
    if any(val not in (None, 0) for name, val in prices[:2]):  # a price of zero needs no currency
        if not adm.get("currency"):
            err("money", "admission has a price but no currency")
        elif adm["currency"] not in model.CURRENCIES:
            err("money", f"admission.currency {adm['currency']!r} must be USD or CAD")
        elif cur_country and adm["currency"] != cur_country:
            warn("money", f"admission is priced in {adm['currency']} for a show in {v.get('country')}. Check it.")
    for name, val in prices:
        if val is None:
            continue
        if not isinstance(val, (int, float)) or isinstance(val, bool):
            err("money", f"{name} {val!r} is not a number")
        elif val < 0:
            err("money", f"{name} is negative")
        elif val > (200 if name.startswith("admission") else 5000):
            warn("money", f"{name} is {val}, which is unusually high")
    if adm.get("free") is True and (adm.get("adult") or 0) > 0:
        err("money", "admission is marked free but has an adult price")

    # ---- vendor dates
    vendor = s.get("vendor") or {}
    deadline, opens = parse_iso_date(vendor.get("deadline")), parse_iso_date(vendor.get("opens"))
    for k in ("deadline", "opens"):
        if vendor.get(k) and parse_iso_date(vendor[k]) is None:
            err("vendor", f"vendor.{k} {vendor[k]!r} is not a date")
    if deadline and parsed and deadline > parsed[0]:
        err("vendor", f"the vendor deadline {deadline.isoformat()} is after the show starts on {parsed[0].isoformat()}")
    if opens and deadline and opens > deadline:
        err("vendor", f"applications open on {opens.isoformat()}, after the deadline {deadline.isoformat()}")
    if vendor.get("setup") and not TIME_RX.match(str(vendor["setup"])):
        err("vendor", f"vendor.setup {vendor['setup']!r} is not a 24 hour time (HH:MM)")

    # ---- privacy
    for path in FREE_TEXT:
        val = _get(s, path)
        if isinstance(val, str) and PHONE_RX.search(val):
            warn("privacy", f"{path} holds a phone number. Keep it only if it is a business line the organizer published for this show.")
    for i, t in enumerate(_get(s, "vendor.tables") or []):
        for k in ("label", "notes"):
            if isinstance(t.get(k), str) and PHONE_RX.search(t[k]):
                warn("privacy", f"vendor.tables[{i}].{k} holds a phone number")
    if isinstance(v.get("address"), str) and APARTMENT.search(v["address"]):
        warn("privacy", f"venue.address {v['address']!r} looks like a residential address (apartment or unit)")
    for k in ("name", "address"):
        if isinstance(v.get(k), str) and HOME_WORDS.search(v[k]):
            warn("privacy", f"venue.{k} {v[k]!r} suggests a private home")

    # ---- urls
    for path, url in model.all_urls(s):
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or "." not in parts.netloc or " " in url:
            err("urls", f"{path} {url!r} is not a well formed web address")
        elif policy.is_never_use(url):
            warn("urls", f"{path} points at {host_of(url)}, a site on the never use list")

    # ---- sources and text
    for i, src in enumerate(s.get("sources") or []):
        if not isinstance(src, dict) or not src.get("source"):
            err("sources", f"sources[{i}] has no source id")
        elif known_sources and src["source"] not in known_sources:
            warn("sources", f"sources[{i}] names {src['source']!r}, which is not in data/sources.yaml (no credit text)")
        if isinstance(src, dict) and src.get("retrieved") and parse_iso_date(src["retrieved"]) is None:
            err("sources", f"sources[{i}].retrieved {src['retrieved']!r} is not a date")
    if isinstance(s.get("summary"), str) and len(s["summary"]) > 300:
        warn("text", "summary is longer than 300 characters. Is it written fresh, not copied?")

    # ---- estimate shape
    est = s.get("estimate")
    if est is not None:
        a = est.get("attendance") or {}
        if not (isinstance(a.get("low"), (int, float)) and a["low"] <= a.get("mid", -1) <= a.get("high", -1)):
            err("estimate", "estimate.attendance must have low <= mid <= high")
        if est.get("basis") not in ("reported", "players", "tables", "area", "history", "type_default"):
            err("estimate", f"estimate.basis {est.get('basis')!r} is not a known basis")
        if est.get("confidence") not in ("reported", "estimated", "rough"):
            err("estimate", f"estimate.confidence {est.get('confidence')!r} is not reported, estimated or rough")
        if est.get("size_class") not in ("small", "medium", "large", "major"):
            err("estimate", f"estimate.size_class {est.get('size_class')!r} is not small, medium, large or major")
    return out


def check_records(shows: list[dict], vocab: Vocab, known_sources: set[str], policy: DomainPolicy, today: date,
                  series: list[dict] | None = None, promoters: list[dict] | None = None) -> CheckReport:
    rep = CheckReport(records=len(shows))
    seen: dict[str, int] = {}
    for s in shows:
        rep.findings += check_show(s, vocab, known_sources, policy, today)
        if s.get("id"):
            seen[s["id"]] = seen.get(s["id"], 0) + 1
    for i, n in seen.items():
        if n > 1:
            rep.findings.append(Finding(ERROR, i, "id", f"the id appears {n} times"))
    if series is not None:
        series_ids = {x["id"] for x in series}
        for s in shows:
            if s.get("series_id") and s["series_id"] not in series_ids and s.get("event_type") != "store_event":
                rep.findings.append(Finding(ERROR, s["id"], "refs", f"series {s['series_id']} has no record in series.jsonl"))
        for x in series:
            for e in x.get("editions", []):
                if e not in seen:
                    rep.findings.append(Finding(ERROR, x["id"], "refs", f"series lists the edition {e}, which is not in shows.jsonl"))
    if promoters is not None:
        series_ids = {x["id"] for x in series or []}
        for p in promoters:
            for sid in p.get("series", []):
                if series is not None and sid not in series_ids:
                    rep.findings.append(Finding(ERROR, p["id"], "refs", f"promoter lists the series {sid}, which does not exist"))
    return rep


def run_check(paths: Paths, vocab: Vocab, today: date | None = None) -> CheckReport:
    today = today or today_fn()
    shows = read_jsonl(paths.shows)
    events = read_jsonl(paths.store_events) + store.read_all(paths)
    known = {s["id"] for s in load_sources(paths.sources_yaml)}
    policy = DomainPolicy.load(paths.data / "never_use_domains.yaml")
    series = read_jsonl(paths.series) if paths.series.exists() else None
    promoters = read_jsonl(paths.promoters) if paths.promoters.exists() else None
    rep = check_records(shows + events, vocab, known, policy, today, series, promoters)
    # store events are not part of series
    return rep
