"""csa import-issues: turn open GitHub issues into a review queue.

Reads open issues labeled add-show, fix-show, organizer or removal from the public repository
and parses the issue form bodies (forms live in .github/ISSUE_TEMPLATE/). Each issue becomes
data/submissions/pending/issue-<number>.json. Nothing goes live until a reviewer moves a file to
data/submissions/approved/ (or to rejected/ to stop it coming back).

Privacy: the issue author's username is never read or stored, @handles in the text are replaced,
and phone numbers are removed from everything we keep.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Protocol

import httpx
import yaml

from . import USER_AGENT
from .normalize import repair_edition
from .paths import Paths
from .textparse import (find_dates, host_of, norm_url, parse_address_text, parse_int, parse_money,
                        parse_time_range, scrub_phones, strip_dates)
from .util import read_json, read_jsonl, today as today_fn, write_json
from .vocab import Vocab

REPO = "holdTheDoorHoid/card-show-atlas"
LABELS = ("add-show", "fix-show", "organizer", "removal")
NO_RESPONSE = {"_no response_", "no response", ""}
MAX_RAW = 2000


# ---------------------------------------------------------------- the forms

@dataclass
class FormField:
    id: str
    label: str
    type: str
    options: list[str] = field(default_factory=list)


@dataclass
class FormSpec:
    name: str
    labels: list[str]
    fields: list[FormField]

    def by_label(self) -> dict[str, FormField]:
        return {f.label.strip().lower(): f for f in self.fields}


def load_forms(directory: Path) -> list[FormSpec]:
    specs = []
    for p in sorted(Path(directory).glob("*.yml")):
        if p.name == "config.yml":
            continue
        data = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
        fields = []
        for item in data.get("body") or []:
            if item.get("type") == "markdown" or "id" not in item:
                continue
            attrs = item.get("attributes") or {}
            options = [o.get("label") if isinstance(o, dict) else str(o) for o in attrs.get("options") or []]
            fields.append(FormField(item["id"], str(attrs.get("label", item["id"])), item["type"], options))
        specs.append(FormSpec(data.get("name", p.stem), [str(x) for x in data.get("labels") or []], fields))
    return specs


def parse_body(body: str, spec: FormSpec) -> dict[str, Any]:
    """Field id to value. Checkbox fields give a list of ticked labels; empty answers are None."""
    sections: dict[str, str] = {}
    current = None
    for line in (body or "").replace("\r\n", "\n").split("\n"):
        if line.startswith("### "):
            current = line[4:].strip().lower()
            sections[current] = ""
        elif current is not None:
            sections[current] += line + "\n"
    out: dict[str, Any] = {}
    labels = spec.by_label()
    for label, text in sections.items():
        fld = labels.get(label)
        if fld is None:
            continue
        text = text.strip()
        if fld.type == "checkboxes":
            out[fld.id] = [m.group(1).strip() for m in re.finditer(r"^- \[[xX]\]\s*(.+)$", text, re.M)]
        else:
            out[fld.id] = None if text.lower() in NO_RESPONSE else text
    return out


# ---------------------------------------------------------------- fetching

class Fetcher(Protocol):
    def get(self, path: str) -> Any: ...


class GhCliFetcher:
    """Uses the gh command line tool, which brings its own login and a higher rate limit."""

    def __init__(self, run: Callable[..., subprocess.CompletedProcess] = subprocess.run):
        self._run = run

    def get(self, path: str) -> Any:
        proc = self._run(["gh", "api", path, "-H", "Accept: application/vnd.github+json"],
                         capture_output=True, text=True, timeout=60)
        if proc.returncode != 0:
            raise RuntimeError(f"gh api failed: {proc.stderr.strip()[:200]}")
        return json.loads(proc.stdout)


class RestFetcher:
    """Plain REST. No token is needed for a public repository; GITHUB_TOKEN or GH_TOKEN raises the limit."""

    def __init__(self, transport: httpx.BaseTransport | None = None):
        headers = {"User-Agent": USER_AGENT, "Accept": "application/vnd.github+json"}
        token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
        if token:
            headers["Authorization"] = f"Bearer {token}"
        self._client = httpx.Client(base_url="https://api.github.com", headers=headers, transport=transport, timeout=30)

    def get(self, path: str) -> Any:
        resp = self._client.get("/" + path.lstrip("/"))
        resp.raise_for_status()
        return resp.json()


def default_fetcher() -> Fetcher:
    if shutil.which("gh"):
        gh = GhCliFetcher()

        class _Both:
            def __init__(self):
                self._rest = None

            def get(self, path: str):
                try:
                    return gh.get(path)
                except (RuntimeError, OSError, subprocess.TimeoutExpired):
                    self._rest = self._rest or RestFetcher()
                    return self._rest.get(path)
        return _Both()
    return RestFetcher()


def fetch_open_issues(fetcher: Fetcher, repo: str, labels=LABELS) -> list[dict]:
    seen: dict[int, dict] = {}
    for label in labels:
        page = 1
        while True:
            rows = fetcher.get(f"repos/{repo}/issues?state=open&labels={label}&per_page=100&page={page}")
            for row in rows:
                if "pull_request" in row:
                    continue
                seen.setdefault(row["number"], row)
            if len(rows) < 100:
                break
            page += 1
    return [seen[k] for k in sorted(seen)]


# ---------------------------------------------------------------- cleaning what we keep

def clean_raw(text: Any) -> str | None:
    if not isinstance(text, str):
        return None
    text = re.sub(r"(?<![\w/])@[A-Za-z0-9][A-Za-z0-9\-]{0,38}\b", "[handle removed]", text)
    text, _ = scrub_phones(text)
    text = text.strip()
    return text[:MAX_RAW] if text else None


def _runs(dates: list[date]) -> list[list[date]]:
    runs: list[list[date]] = []
    for d in sorted(set(dates)):
        if runs and (d - runs[-1][-1]).days == 1:
            runs[-1].append(d)
        else:
            runs.append([d])
    return runs


def _day_entries(run: list[date], open_t: str | None, close_t: str | None) -> list[dict]:
    return [{"date": d.isoformat(), "open": open_t, "close": close_t} for d in run]


def _links_from(url_text: str | None) -> dict:
    url = norm_url(url_text) if url_text else None
    if not url:
        return {}
    host = host_of(url)
    if host.endswith("facebook.com") or host == "fb.com":
        return {"facebook": url}
    if host.endswith("instagram.com"):
        return {"instagram": url}
    return {"official": url}


def _first_url(text: str | None) -> str | None:
    if not text:
        return None
    for tok in re.findall(r"https?://[^\s<>)\]]+|www\.[^\s<>)\]]+", text):
        u = norm_url(tok)
        if u:
            return u
    return None


# ---------------------------------------------------------------- conversions

_DEADLINE_WORDS = re.compile(r"\b(?:deadline|apply by|applications? (?:close|due)|due|by|before)\b[^\n]{0,40}", re.I)


def _vendor_from_text(text: str | None, created: date, notes: list[str]) -> dict:
    """Pull the application link and deadline out of free text. Prices are only flagged for the reviewer."""
    if not text:
        return {}
    v: dict[str, Any] = {}
    url = _first_url(text)
    if url:
        v["application_url"] = url
    for m in _DEADLINE_WORDS.finditer(text):
        got = find_dates(m.group(0), created)
        if len(got) == 1:
            v["deadline"] = got[0].isoformat()
            break
    prices = [p.rstrip(",") for p in re.findall(r"\$\s?(\d[\d,]*(?:\.\d+)?)", text)]
    if prices:
        notes.append(f"vendor: prices seen in the text: {', '.join(prices)}. Add them to vendor.tables by hand.")
    return v


def convert_add_show(f: dict, vocab: Vocab, created: date, notes: list[str]) -> list[dict]:
    base: dict[str, Any] = {"name": f.get("name")}
    venue_text = f.get("venue")
    if venue_text:
        venue = parse_address_text(venue_text)
        if not (venue.get("city") and venue.get("region")):
            notes.append("venue: could not find a city and a state or province, please fill in venue by hand")
        base["venue"] = venue
    base.update({"links": _links_from(f.get("link"))} if f.get("link") else {})
    sells = {"tcg": [], "sports": [], "other": []}
    ticked = f.get("sells") or []
    for label in ticked:
        for i in vocab.resolve("sells", label):
            g = vocab.sells_ids[i]
            if i not in sells[g]:
                sells[g].append(i)
    if ticked:
        base["sells"] = sells
    if f.get("admission"):
        amount, cur = parse_money(f["admission"])
        if amount is None:
            base["admission"] = {"notes": f["admission"]}
        else:
            base["admission"] = {"free": amount == 0, "adult": amount, "currency": cur, "notes": None}
    tables = parse_int(f.get("tables")) if f.get("tables") else None
    if tables:
        base["size"] = {"tables": tables}
    vendor = _vendor_from_text(f.get("vendor"), created, notes)
    if vendor:
        base["vendor"] = vendor
    open_t, close_t = parse_time_range(f.get("hours") or "") if f.get("hours") else (None, None)
    if f.get("hours") and not open_t:
        notes.append(f"hours: could not read {f['hours']!r}")
    dates = find_dates(f.get("dates") or "", created)
    if not dates:
        notes.append(f"dates: no calendar date found in {f.get('dates')!r}. For a repeating show, "
                     "add a recurring series by hand or enter the next dates.")
        return [{**base, "days": []}]
    return [{**base, "days": _day_entries(run, open_t, close_t)} for run in _runs(dates)]


def convert_organizer(f: dict, vocab: Vocab, created: date, notes: list[str]) -> list[dict]:
    official = norm_url(f.get("official")) if f.get("official") else None
    base: dict[str, Any] = {"name": f.get("show"), "organizer": {"url": official}, "links": {"official": official}}
    if f.get("attendance"):
        n = parse_int(f["attendance"])
        if n:
            base["size"] = {"reported_attendance": {"value": n, "year": None, "source_url": official}}
            notes.append("attendance: the year this number is for was not asked, set size.reported_attendance.year by hand")
    notes.append("Check that the official page really belongs to the organizer, then set verification to "
                 "organizer_confirmed on each record.")
    vendor = _vendor_from_text(f.get("vendor"), created, notes)
    if vendor:
        base["vendor"] = vendor
    records = []
    for line in (f.get("dates") or "").split("\n"):
        dates = find_dates(line, created)
        if not dates:
            continue
        hours = parse_time_range(line)
        venue_text = strip_dates(line).strip(" -,:;")
        venue = parse_address_text(venue_text) if re.search(r"\b[A-Z]{2}\b|\d{5}", venue_text) else {}
        for run in _runs(dates):
            rec = {**base, "days": _day_entries(run, hours[0], hours[1])}
            if venue:
                rec["venue"] = venue
            records.append(rec)
    if not records:
        notes.append(f"dates: no calendar date found in {f.get('dates')!r}")
        records = [{**base, "days": []}]
    return records


def find_target(page_url: str | None, show_ids: set[str]) -> dict:
    out = {"page": norm_url(page_url) if page_url else None, "id": None, "found": False}
    if not out["page"]:
        return out
    segments = [s for s in re.split(r"[/?#]", out["page"].split("://", 1)[-1])[1:] if s]
    segments = [re.sub(r"\.html?$", "", s) for s in segments]
    for s in reversed(segments):
        if s in show_ids:
            out.update(id=s, found=True)
            return out
    if segments:
        out["id"] = segments[-1]
    return out


# ---------------------------------------------------------------- one issue

def body_hash(body: str) -> str:
    return hashlib.sha1((body or "").encode()).hexdigest()[:12]


def convert_issue(issue: dict, specs: list[FormSpec], vocab: Vocab, show_ids: set[str], today: date,
                  repo: str = REPO) -> dict:
    labels = [l["name"] if isinstance(l, dict) else str(l) for l in issue.get("labels", [])]
    kind = next((k for k in LABELS if k in labels), None)
    spec = next((s for s in specs if kind and kind in s.labels), None)
    created = today
    try:
        created = datetime.fromisoformat(str(issue.get("created_at", "")).replace("Z", "+00:00")).date()
    except ValueError:
        pass
    body = issue.get("body") or ""
    notes: list[str] = []
    fields = parse_body(body, spec) if spec else {}
    out: dict[str, Any] = {
        "schema": 1, "kind": kind, "issue": issue["number"],
        "issue_url": f"https://github.com/{repo}/issues/{issue['number']}",
        "body_hash": body_hash(body), "imported": today.isoformat(), "status": "pending",
        "review_notes": notes,
    }
    if spec is None or not fields:
        notes.append("The form fields could not be read from this issue. Read the issue itself.")
        out["raw"] = {"body": clean_raw(body)}
        return out
    out["raw"] = {k: (clean_raw(v) if isinstance(v, str) else v) for k, v in fields.items() if v}
    clean_fields = {k: (scrub_phones(v)[0] if isinstance(v, str) else v) for k, v in fields.items()}
    if kind in ("add-show", "organizer"):
        convert = convert_add_show if kind == "add-show" else convert_organizer
        records = convert(clean_fields, vocab, created, notes)
        repaired = []
        for rec in records:
            r, rep_notes = repair_edition(rec, vocab, created)
            r["verification"] = "community"
            r["sources"] = [{"source": "github_issues", "url": out["issue_url"], "retrieved": today.isoformat(),
                             "fields": [k for k in r if k in ("name", "days", "venue", "sells", "admission", "size",
                                                              "vendor", "organizer", "links")]}]
            r["last_checked"] = today.isoformat()
            notes.extend(n for n in rep_notes if n not in notes)
            repaired.append(r)
        out["records"] = repaired
    elif kind == "fix-show":
        out["target"] = find_target(fields.get("page"), show_ids)
        out["change_request"] = clean_raw(fields.get("wrong"))
        out["evidence"] = [u for u in [norm_url(fields.get("proof")) if fields.get("proof") else None] if u]
        out["patch"] = {}
        notes.append("To approve: fill in patch with dotted field names, for example {\"venue.city\": \"Edison\"}, "
                     "then move this file to approved/.")
    elif kind == "removal":
        out["target"] = find_target(fields.get("page"), show_ids)
        out["request"] = clean_raw(fields.get("what"))
        out["patch"] = {}
        out["suppress"] = False
        notes.append("To approve: set suppress to true to remove the whole show, or list fields to clear in "
                     "patch (for example {\"vendor.contact\": null}), then move this file to approved/.")
    if out.get("target") and not out["target"]["found"]:
        notes.append("The page link did not match a show we have. Check the id by hand.")
    return out


# ---------------------------------------------------------------- the whole run

@dataclass
class IssueReport:
    fetched: int = 0
    written: int = 0
    updated: int = 0
    unchanged: int = 0
    already_reviewed: int = 0
    closed_but_pending: list[str] = field(default_factory=list)
    by_kind: dict[str, int] = field(default_factory=dict)

    def lines(self) -> list[str]:
        out = [f"Open issues read: {self.fetched}. New in the queue: {self.written}, updated: {self.updated}, "
               f"unchanged: {self.unchanged}, already reviewed: {self.already_reviewed}."]
        if self.by_kind:
            out.append("  by kind: " + ", ".join(f"{k} {v}" for k, v in sorted(self.by_kind.items())))
        if self.closed_but_pending:
            out.append("  pending files whose issue is no longer open: " + ", ".join(self.closed_but_pending))
        return out


def _reviewed(paths: Paths, number: int) -> dict | None:
    for d in (paths.approved, paths.rejected):
        p = d / f"issue-{number}.json"
        if p.exists():
            return read_json(p)
    return None


def import_issues(paths: Paths, vocab: Vocab, fetcher: Fetcher | None = None, repo: str = REPO,
                  today: date | None = None, issues: list[dict] | None = None) -> IssueReport:
    today = today or today_fn()
    fetcher = fetcher or default_fetcher()
    specs = load_forms(paths.issue_templates)
    if issues is None:
        issues = fetch_open_issues(fetcher, repo)
    issues = [i for i in issues if "pull_request" not in i]
    show_ids = {r.get("id") for r in read_jsonl(paths.shows)}
    rep = IssueReport(fetched=len(issues))
    open_numbers = set()
    for issue in issues:
        open_numbers.add(issue["number"])
        item = convert_issue(issue, specs, vocab, show_ids, today, repo)
        reviewed = _reviewed(paths, issue["number"])
        if reviewed is not None and reviewed.get("body_hash") == item["body_hash"]:
            rep.already_reviewed += 1
            continue
        if reviewed is not None:
            item["review_notes"].insert(0, "The issue was edited after an earlier review. Look again.")
        target = paths.pending / f"issue-{issue['number']}.json"
        existing = read_json(target)
        if existing is not None and existing.get("body_hash") == item["body_hash"]:
            rep.unchanged += 1
            continue
        write_json(target, item)
        rep.by_kind[item["kind"] or "unknown"] = rep.by_kind.get(item["kind"] or "unknown", 0) + 1
        if existing is None:
            rep.written += 1
        else:
            rep.updated += 1
    if paths.pending.exists():
        for p in sorted(paths.pending.glob("issue-*.json")):
            n = int(p.stem.split("-")[1])
            if n not in open_numbers:
                rep.closed_but_pending.append(p.name)
    return rep
