"""csa import-research <wave>: check, repair and file what the research agents found.

Reads research/inbox/<wave>/*.json (one file per agent, DATA_MODEL section 9). A file may also
be a bare list of records or a single bare record. Good records go to data/research/<wave>.jsonl,
rejected ones to research/inbox/<wave>/_rejected.jsonl with the reasons, and leads and blocked
pages to data/research/leads/<wave>.jsonl.

Running the import again is safe. Records are filed under the agent that wrote them, so a
rewritten agent file replaces that agent's earlier records and nothing else.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

from . import model, regions
from .domains import DomainPolicy
from .normalize import Notes, _clean_text, repair_edition
from .paths import Paths
from .recurring import repair_series, rule_problems
from .textparse import host_of, norm_url, same_site
from .util import add_months, parse_iso_date, read_jsonl, today as today_fn, write_jsonl
from .vocab import Vocab

EVIDENCE_FIELDS_EXTRA = {"cadence", "known_dates", "cancelled_dates", "rule", "hours", "last_confirmed"}
EARLIEST_YEAR = 2015
MAX_YEARS_AHEAD = 3
MAX_SPAN_DAYS = 14


SUPPORT_ALIASES = {k: f"venue.{k}" for k in ("city", "region", "address", "postal", "country", "lat", "lon")}
SUPPORT_ALIASES.update({"dates": "days", "date": "days"})
DATE_SUPPORT = {"days", "known_dates", "rule", "cadence"}
NEVER_USE_REASON = "evidence only from never use sources"
LINK_ONLY_REASON = "evidence only from link only sites (Facebook, Instagram, TikTok, X, Eventbrite, Meetup, AllEvents)"


@dataclass
class ImportReport:
    wave: str
    files: int = 0
    records_seen: int = 0
    accepted: int = 0
    editions: int = 0
    series: int = 0
    rejected: int = 0
    repaired: int = 0  # records that needed at least one repair
    leads: int = 0
    blocked: int = 0
    never_use_dropped: int = 0
    searches_used: int = 0
    fetches_used: int = 0
    rejected_rows: list[dict] = field(default_factory=list)

    def lines(self) -> list[str]:
        out = [f"Wave {self.wave}: {self.files} agent files, {self.records_seen} records.",
               f"  accepted {self.accepted} ({self.editions} editions, {self.series} series), "
               f"{self.repaired} of them repaired",
               f"  rejected {self.rejected}",
               f"  leads kept {self.leads}, blocked pages noted {self.blocked}, "
               f"evidence dropped from never use sites {self.never_use_dropped}",
               f"  agents used {self.searches_used} searches and {self.fetches_used} fetches"]
        for row in self.rejected_rows[:20]:
            out.append(f"    rejected {row.get('file')} #{row.get('index')} {row.get('name') or ''}: "
                       + "; ".join(row["reasons"]))
        if len(self.rejected_rows) > 20:
            out.append(f"    and {len(self.rejected_rows) - 20} more in _rejected.jsonl")
        return out


# ---------------------------------------------------------------- evidence

@dataclass
class EvidenceResult:
    kept: list[dict] = field(default_factory=list)
    given: int = 0
    dropped_never: int = 0
    dropped_link_only: int = 0

    @property
    def dropped_any_source(self) -> bool:
        return bool(self.dropped_never or self.dropped_link_only)

    def supported(self) -> set[str]:
        return {f for ev in self.kept for f in ev["supports"]}


def _clean_evidence(raw: Any, notes: Notes, today: date, policy: DomainPolicy) -> EvidenceResult:
    res = EvidenceResult()
    for i, ev in enumerate(raw if isinstance(raw, list) else []):
        res.given += 1
        path = f"evidence[{i}]"
        if not isinstance(ev, dict):
            notes.add(path, "not an object, dropped")
            continue
        url = norm_url(ev.get("url"))
        if url is None:
            notes.add(path, f"{ev.get('url')!r} is not a web address, dropped")
            continue
        if policy.is_never_use(url):
            res.dropped_never += 1
            notes.add(path, f"{host_of(url)} is a never use site, evidence dropped")
            continue
        if policy.is_link_only(url):
            res.dropped_link_only += 1
            notes.add(path, f"{host_of(url)} is a link only site, not accepted as evidence")
            continue
        seen = parse_iso_date(ev.get("seen"))
        if seen is None and ev.get("seen"):
            from .textparse import parse_date_text
            seen = parse_date_text(ev.get("seen"), today)
            if seen:
                notes.add(path + ".seen", f"date {ev.get('seen')!r} became {seen.isoformat()}")
        if seen is None:
            seen = today
            notes.add(path + ".seen", "no usable date, set to the import date")
        supports = []
        for f in ev.get("supports") or []:
            f = re.sub(r"\s*\(.*?\)\s*$", "", str(f)).strip()  # "days (year 2026)" means "days"
            f = SUPPORT_ALIASES.get(f, f)
            top = f.split(".")[0]
            if (top in model.SHOW_KEY_ORDER or f in EVIDENCE_FIELDS_EXTRA) and f not in supports:
                supports.append(f)
            elif f not in supports:
                notes.add(path + ".supports", f"{f!r} is not a field name, dropped")
        res.kept.append({"url": url, "seen": seen.isoformat(), "supports": supports})
    return res


def _missing_support(supported: set[str]) -> list[str]:
    """Which of name, dates and venue no remaining evidence supports."""
    missing = []
    if "name" not in supported:
        missing.append("name")
    if not (supported & DATE_SUPPORT or any(f.startswith("days") for f in supported)):
        missing.append("dates")
    if not any(f == "venue" or f.startswith("venue.") for f in supported):
        missing.append("venue")
    return missing


def _strip_forbidden_urls(rec: dict, policy: DomainPolicy, notes: Notes) -> None:
    """Remove the addresses of never use sites from every link field."""
    def check(container: dict | None, key: str, label: str):
        if isinstance(container, dict) and container.get(key) and policy.is_never_use(container[key]):
            notes.add(label, f"{host_of(container[key])} is a never use site, address removed")
            container[key] = None
    for k in model.LINK_KEYS:
        check(rec.get("links"), k, f"links.{k}")
    check(rec.get("organizer"), "url", "organizer.url")
    check(rec.get("vendor"), "application_url", "vendor.application_url")
    check((rec.get("size") or {}).get("reported_attendance"), "source_url", "size.reported_attendance.source_url")


def _decide_verification(rec: dict, evidence: list[dict], vocab: Vocab, notes: Notes) -> str:
    official = [(rec.get("links") or {}).get("official"), (rec.get("organizer") or {}).get("url")]
    on_organizer_site = any(same_site(ev["url"], o) for ev in evidence for o in official if o)
    claimed = rec.get("verification")
    if claimed in ("community", "unverified"):
        return claimed
    if on_organizer_site:
        return "organizer_confirmed"
    if claimed == "organizer_confirmed":
        notes.add("verification", "organizer_confirmed was claimed but no evidence link is on the organizer's own site, set to listed")
    return "listed"


# ---------------------------------------------------------------- validation

def _venue_problems(rec: dict) -> list[str]:
    v = rec.get("venue") or {}
    problems = []
    if not v.get("city"):
        problems.append("venue.city is missing")
    if not v.get("region"):
        problems.append("venue.region is missing")
    elif v["region"] not in regions.REGION_COUNTRY:
        problems.append(f"venue.region {v['region']!r} is not a US state or Canadian province code")
    if v.get("country") and v["country"] not in ("US", "CA"):
        problems.append(f"venue.country {v['country']!r} is outside the US and Canada")
    return problems


def _date_problems(dates: list[str], today: date, what: str = "days") -> list[str]:
    problems = []
    for iso in dates:
        d = parse_iso_date(iso)
        if d is None:
            problems.append(f"{what}: {iso!r} is not a date")
            continue
        if d.year < EARLIEST_YEAR or d > add_months(today, 12 * MAX_YEARS_AHEAD):
            problems.append(f"{what}: {iso} is not a believable show date")
    return problems


def validate_edition(rec: dict, vocab: Vocab, today: date, notes: Notes) -> list[str]:
    problems = []
    if not rec.get("name"):
        problems.append("name is missing")
    problems += _venue_problems(rec)
    if rec.get("event_type") is None:
        notes.add("event_type", "missing, set to card_show")
        rec["event_type"] = "card_show"
    elif rec["event_type"] not in vocab.event_types:
        problems.append(f"event_type {rec['event_type']!r} is not one of {', '.join(vocab.event_types)}")
    days = rec.get("days") or []
    if not days:
        problems.append("days is empty, a show needs at least one real date")
    else:
        dates = [d["date"] for d in days]
        problems += _date_problems(dates, today)
        if not problems and (parse_iso_date(dates[-1]) - parse_iso_date(dates[0])).days > MAX_SPAN_DAYS:
            problems.append(f"days run for more than {MAX_SPAN_DAYS} days, that is not one show")
        last = parse_iso_date(dates[-1])
        size = rec.get("size") or {}
        has_size = any(size.get(k) for k in ("tables", "booths", "players", "venue_sqft", "reported_attendance"))
        if last and last < today and not has_size and not problems:
            problems.append("a past show is only kept when it states its size (tables, players or attendance)")
    vendor = rec.get("vendor") or {}
    first = parse_iso_date((days[0] or {}).get("date")) if days else None
    deadline = parse_iso_date(vendor.get("deadline"))
    if first and deadline and deadline > first:
        notes.add("vendor.deadline", f"{vendor['deadline']} is after the show, dropped")
        vendor["deadline"] = None
    opens = parse_iso_date(vendor.get("opens"))
    if opens and parse_iso_date(vendor.get("deadline")) and opens > parse_iso_date(vendor["deadline"]):
        notes.add("vendor.opens", "opens after the deadline, dropped")
        vendor["opens"] = None
    _drop_bad_coordinates(rec, notes)
    return problems


def validate_series(rec: dict, vocab: Vocab, today: date, notes: Notes) -> list[str]:
    problems = []
    if not rec.get("name"):
        problems.append("name is missing")
    problems += _venue_problems(rec)
    if rec.get("event_type") is None:
        notes.add("event_type", "missing, set to card_show")
        rec["event_type"] = "card_show"
    elif rec["event_type"] not in vocab.event_types:
        problems.append(f"event_type {rec['event_type']!r} is not one of {', '.join(vocab.event_types)}")
    problems += rule_problems(rec)
    problems += _date_problems(rec.get("known_dates") or [], today, "known_dates")
    problems += _date_problems(rec.get("cancelled_dates") or [], today, "cancelled_dates")
    if rec.get("rule", {}).get("until"):
        problems += _date_problems([rec["rule"]["until"]], today, "rule.until")
    if rec.get("last_confirmed") is None:
        notes.add("last_confirmed", "missing, so no tentative dates will be made from the rule")
    else:
        lc = parse_iso_date(rec["last_confirmed"])
        if lc and lc > today:
            problems.append(f"last_confirmed {rec['last_confirmed']} is in the future")
    freq = (rec.get("rule") or {}).get("freq")
    if freq == "monthly" and rec["rule"].get("weekday"):
        from .textparse import WEEKDAY_CODES
        wd = WEEKDAY_CODES.index(rec["rule"]["weekday"])
        for iso in rec.get("known_dates") or []:
            d = parse_iso_date(iso)
            if d and d.weekday() != wd:
                notes.add("known_dates", f"{iso} is not a {rec['rule']['weekday']}, check the year")
    _drop_bad_coordinates(rec, notes)
    return problems


def _drop_bad_coordinates(rec: dict, notes: Notes) -> None:
    v = rec.get("venue") or {}
    if v.get("lat") is not None and v.get("region"):
        ok = regions.in_region(v["lat"], v["lon"], v["region"])
        if ok is False:
            notes.add("venue", "coordinates are outside the stated region, dropped")
            v["lat"] = v["lon"] = v["geo_precision"] = None


# ---------------------------------------------------------------- one record

def process_record(raw: Any, vocab: Vocab, today: date,
                   policy: DomainPolicy | None = None) -> tuple[dict | None, list[str], list[str]]:
    """Return (clean record or None, reasons it was rejected, repair notes)."""
    policy = policy or DomainPolicy()
    if not isinstance(raw, dict):
        return None, ["the record is not a JSON object"], []
    kind = raw.get("kind")
    if kind is None:
        kind = "series" if ("rule" in raw or "known_dates" in raw) else "edition"
    if kind not in ("edition", "series"):
        return None, [f"kind {kind!r} must be edition or series"], []

    work = {k: v for k, v in raw.items() if k not in ("evidence", "agent_confidence", "kind", "estimate", "sources")}
    if kind == "series":
        rec, notes_list = repair_series(work, vocab, today)
    else:
        rec, notes_list = repair_edition(work, vocab, today)
    notes = Notes(notes_list)

    conf = raw.get("agent_confidence")
    cid = vocab.resolve_one("agent_confidence", conf) if conf is not None else None
    if cid is None:
        notes.add("agent_confidence", f"{conf!r} not understood, set to low" if conf else "missing, set to low")
        cid = "low"
    reasons = validate_series(rec, vocab, today, notes) if kind == "series" else validate_edition(rec, vocab, today, notes)

    _strip_forbidden_urls(rec, policy, notes)
    found = _clean_evidence(raw.get("evidence"), notes, today, policy)
    evidence = found.kept
    if not evidence:
        if found.dropped_never:
            reasons.append(NEVER_USE_REASON)
        else:
            reasons.append("no usable evidence: each record needs at least one link to a page that is not Facebook, "
                           "Instagram, Eventbrite, Meetup, TikTok, X or AllEvents")
    elif found.dropped_any_source:
        missing = _missing_support(found.supported())
        if missing:
            reasons.append(f"{NEVER_USE_REASON if found.dropped_never else LINK_ONLY_REASON}: "
                           f"nothing else supports the {' and the '.join(missing)}")
    if reasons:
        return None, reasons, list(notes)

    rec["verification"] = _decide_verification({**rec, "verification": raw.get("verification")}, evidence, vocab, notes)
    rec["kind"] = kind
    rec["evidence"] = evidence
    rec["agent_confidence"] = cid
    rec["sources"] = [{"source": "research", "url": ev["url"], "retrieved": ev["seen"],
                       "fields": ev["supports"]} for ev in evidence]
    rec["last_checked"] = max(ev["seen"] for ev in evidence)
    return rec, [], list(notes)


# ---------------------------------------------------------------- leads

def _lead_rows(agent: str, wave: str, data: dict) -> list[dict]:
    rows = []
    for item in data.get("leads_only") or []:
        if not isinstance(item, dict):
            continue
        notes = Notes()
        rows.append({"type": "lead", "wave": wave, "agent": agent,
                     "name": _clean_text(item.get("name"), "name", notes, 200),
                     "url": norm_url(item.get("url")) if item.get("url") else None,
                     "note": _clean_text(item.get("note"), "note", notes, 300)})
    for item in data.get("blocked") or []:
        if not isinstance(item, dict):
            continue
        notes = Notes()
        rows.append({"type": "blocked", "wave": wave, "agent": agent,
                     "url": norm_url(item.get("url")) if item.get("url") else None,
                     "status": item.get("status") if isinstance(item.get("status"), int) else None,
                     "note": _clean_text(item.get("note"), "note", notes, 300)})
    return rows


# ---------------------------------------------------------------- the import

def _read_agent_file(path: Path) -> tuple[dict | None, str | None]:
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as exc:
        return None, f"not valid JSON ({exc.msg} at line {exc.lineno})"
    except OSError as exc:
        return None, f"could not be read ({exc})"
    if isinstance(data, list):
        return {"records": data}, None
    if isinstance(data, dict) and "records" in data:
        if not isinstance(data["records"], list):
            return None, "records must be a list"
        return data, None
    if isinstance(data, dict):
        return {"records": [data]}, None  # a bare single record
    return None, "the file holds neither an agent object, a list nor a record"


def import_wave(paths: Paths, wave: str, vocab: Vocab, today: date | None = None) -> ImportReport:
    today = today or today_fn()
    inbox = paths.inbox / wave
    if not inbox.is_dir():
        raise FileNotFoundError(f"no inbox folder for wave {wave!r}: {inbox}")
    report = ImportReport(wave)
    policy = DomainPolicy.load(paths.data / "never_use_domains.yaml")
    out_path = paths.research / f"{wave}.jsonl"
    existing = read_jsonl(out_path)
    new_by_agent: dict[str, list[dict]] = {}
    leads: list[dict] = []
    rejected: list[dict] = []

    for f in sorted(inbox.glob("*.json")):
        if f.name.startswith("_"):
            continue
        report.files += 1
        agent = f.stem
        data, problem = _read_agent_file(f)
        if data is None:
            rejected.append({"file": f.name, "index": None, "name": None, "reasons": [f"the file {problem}"]})
            report.rejected += 1
            continue
        agent = str(data.get("agent") or f.stem)
        new_by_agent.setdefault(f.stem, [])
        for key, attr in (("searches_used", "searches_used"), ("fetches_used", "fetches_used")):
            if isinstance(data.get(key), int):
                setattr(report, attr, getattr(report, attr) + data[key])
        leads += _lead_rows(agent, wave, data)
        for i, raw in enumerate(data["records"]):
            report.records_seen += 1
            clean, reasons, notes = process_record(raw, vocab, today, policy)
            report.never_use_dropped += sum(1 for n in notes if "never use site, evidence dropped" in n)
            if clean is None:
                name = raw.get("name") if isinstance(raw, dict) else None
                rejected.append({"file": f.name, "index": i, "name": name, "reasons": reasons})
                report.rejected += 1
                continue
            clean["research_id"] = f"{wave}/{f.stem}/{i}"
            clean["wave"] = wave
            clean["agent"] = agent
            clean["imported"] = today.isoformat()
            if notes:
                clean["repairs"] = notes
                report.repaired += 1
            new_by_agent[f.stem].append(clean)
            report.accepted += 1
            if clean["kind"] == "series":
                report.series += 1
            else:
                report.editions += 1

    replaced = {f"{wave}/{stem}/" for stem in new_by_agent}
    kept = [r for r in existing if not any(str(r.get("research_id", "")).startswith(p) for p in replaced)]
    rows = kept + [r for recs in new_by_agent.values() for r in recs]
    rows.sort(key=lambda r: (r["research_id"].rsplit("/", 1)[0], int(r["research_id"].rsplit("/", 1)[1])))
    write_jsonl(out_path, rows)

    if leads:
        lead_path = paths.research_leads / f"{wave}.jsonl"
        write_jsonl(lead_path, leads)
    report.leads = sum(1 for r in leads if r["type"] == "lead")
    report.blocked = sum(1 for r in leads if r["type"] == "blocked")

    rej_path = inbox / "_rejected.jsonl"
    if rejected:
        write_jsonl(rej_path, rejected)
    elif rej_path.exists():
        rej_path.unlink()
    report.rejected_rows = rejected
    return report
