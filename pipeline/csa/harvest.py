"""csa harvest <source_id>|all: run scripted sources and write data/harvest/<id>.jsonl.

A source is a module csa/sources/<id>.py with `harvest(ctx) -> Iterable[dict]`. The runner gives it
a polite HTTP client, repairs and stamps what it yields, and writes the file only when the run
finished well, so a broken or blocked run never wipes out the last good data.
"""

from __future__ import annotations

import importlib
import traceback
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any, Callable

import httpx

from . import model
from .http import BotChallenge, FetchError, HttpClient
from .normalize import repair_edition
from .paths import Paths
from .sourcesreg import by_id, load_sources
from .util import read_json, read_jsonl, today as today_fn, write_json, write_jsonl
from .vocab import Vocab

# Fields a record may carry; the registry's `fields` list narrows this per source.
SHOW_FIELDS = {"name", "event_type", "status", "days", "timezone", "venue", "sells", "mix", "admission",
               "size", "vendor", "organizer", "links"}
IMPLIED = {"venue": {"timezone"}, "sells": {"mix"}}
MIN_KEEP_RATIO = 0.2
MIN_PREVIOUS_FOR_GUARD = 5


@dataclass
class HarvestContext:
    """What a source module receives."""
    source: dict
    http: HttpClient
    today: date
    paths: Paths
    messages: list[str] = field(default_factory=list)

    def log(self, text: str) -> None:
        self.messages.append(text)


@dataclass
class HarvestResult:
    source_id: str
    status: str  # ok, blocked, error, suspicious, disabled
    records: int = 0
    skipped: int = 0
    message: str = ""
    network_requests: int = 0
    cache_hits: int = 0
    refused: list[str] = field(default_factory=list)
    skip_reasons: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.status in ("ok", "disabled")

    def line(self) -> str:
        bits = [f"{self.source_id}: {self.status}"]
        if self.status == "ok":
            bits.append(f"{self.records} records ({self.skipped} skipped), {self.network_requests} requests, "
                        f"{self.cache_hits} from cache")
        if self.message:
            bits.append(self.message)
        return ", ".join(bits)


def load_module(entry: dict):
    name = entry.get("module") or f"csa.sources.{entry['id']}"
    return importlib.import_module(name)


def _fields_in_record(rec: dict) -> list[str]:
    return [k for k in model.SHOW_KEY_ORDER if k in rec and rec[k] not in (None, "", [], {})
            and k in SHOW_FIELDS]


def stamp_record(raw: dict, entry: dict, vocab: Vocab, today: date) -> tuple[dict | None, str | None]:
    """Clean one record from a source module. Returns (record, None) or (None, why it was skipped)."""
    if not isinstance(raw, dict):
        return None, "the source yielded something that is not a dict"
    source_url = raw.get("source_url")
    allowed = set(entry.get("fields") or SHOW_FIELDS)
    for f in list(allowed):
        allowed |= IMPLIED.get(f, set())
    kept = {k: v for k, v in raw.items() if k in SHOW_FIELDS and k in allowed}
    rec, _notes = repair_edition(kept, vocab, today)
    rec = {k: v for k, v in rec.items() if k in SHOW_FIELDS}
    v = rec.get("venue") or {}
    if not rec.get("name"):
        return None, "no name"
    if not rec.get("days"):
        return None, f"{rec['name']}: no usable date"
    if not v.get("city") or not v.get("region"):
        return None, f"{rec['name']}: venue needs a city and a state or province"
    rec["verification"] = "organizer_confirmed" if entry["kind"] == "promoter" else "listed"
    rec["last_checked"] = today.isoformat()
    rec["sources"] = [{"source": entry["id"], "url": source_url, "retrieved": today.isoformat(),
                       "fields": _fields_in_record(rec)}]
    return rec, None


def _sort_key(rec: dict):
    return (rec["days"][0]["date"], (rec.get("name") or "").lower(), (rec.get("venue") or {}).get("city") or "")


def _status_path(paths: Paths) -> Path:
    return paths.harvest / "_status.json"


def _record_status(paths: Paths, res: HarvestResult, today: date) -> None:
    data = read_json(_status_path(paths), {})
    data[res.source_id] = {"status": res.status, "date": today.isoformat(), "records": res.records,
                           "skipped": res.skipped, "message": res.message}
    write_json(_status_path(paths), data)


def run_source(
    paths: Paths,
    source_id: str,
    vocab: Vocab,
    *,
    today: date | None = None,
    transport: httpx.BaseTransport | None = None,
    refresh: bool = False,
    force_disabled: bool = False,
    http_options: dict[str, Any] | None = None,
) -> HarvestResult:
    today = today or today_fn()
    registry = by_id(paths.sources_yaml)
    if source_id not in registry:
        raise KeyError(f"{source_id!r} is not in {paths.sources_yaml}. Known sources: {', '.join(sorted(registry)) or 'none'}")
    entry = registry[source_id]
    if entry["method"] != "script":
        raise ValueError(f"{source_id} has method {entry['method']!r}; only script sources can be harvested")
    if not entry["enabled"] and not force_disabled:
        return HarvestResult(source_id, "disabled", message="enabled is false in sources.yaml")

    opts = dict(http_options or {})
    opts.setdefault("min_interval", float(entry.get("min_interval", 1.0)))
    opts.setdefault("cache_ttl_hours", 0.0 if refresh else 12.0)
    client = HttpClient(source_id, paths.raw, transport=transport, **opts)
    ctx = HarvestContext(entry, client, today, paths)
    res = HarvestResult(source_id, "ok")
    out_path = paths.harvest / f"{source_id}.jsonl"
    try:
        module = load_module(entry)
        records: list[dict] = []
        for raw in module.harvest(ctx):
            rec, why = stamp_record(raw, entry, vocab, today)
            if rec is None:
                res.skipped += 1
                if len(res.skip_reasons) < 10:
                    res.skip_reasons.append(why or "skipped")
                continue
            records.append(rec)
        records.sort(key=_sort_key)
        previous = len(read_jsonl(out_path))
        if previous >= MIN_PREVIOUS_FOR_GUARD and len(records) < previous * MIN_KEEP_RATIO:
            res.status = "suspicious"
            res.message = (f"returned {len(records)} records but the last run had {previous}. "
                           "The old file was kept. Has the site layout changed?")
        else:
            write_jsonl(out_path, records)
            res.records = len(records)
    except BotChallenge as exc:
        res.status = "blocked"
        res.message = str(exc)
    except FetchError as exc:
        res.status = "error"
        res.message = f"fetch failed: {exc}"
    except Exception as exc:  # a bug in a source module must not stop the other sources
        res.status = "error"
        res.message = f"{type(exc).__name__}: {exc}"
        ctx.log(traceback.format_exc())
    finally:
        res.network_requests = client.stats.network_requests
        res.cache_hits = client.stats.cache_hits
        res.refused = list(client.stats.refused)
        client.close()
    _record_status(paths, res, today)
    return res


def run_all(paths: Paths, vocab: Vocab, **kw) -> list[HarvestResult]:
    sources = [s for s in load_sources(paths.sources_yaml) if s["method"] == "script"]
    sources.sort(key=lambda s: (s["priority"], s["_order"]))
    results = []
    for s in sources:
        results.append(run_source(paths, s["id"], vocab, **kw))
    return results


# ---------------------------------------------------------------- scaffold for a new source

TEMPLATE = '''"""{name}.

Terms and robots checked: {today}. Write down here what you found, and what the registry entry
in data/sources.yaml says we may take.
"""

from __future__ import annotations

from typing import Iterable

from ..htmlutil import event_to_show, find_links, jsonld_events

START = "{url}"


def harvest(ctx) -> Iterable[dict]:
    """Yield partial show records (DATA_MODEL section 2). Set source_url to the page a show came from."""
    page = ctx.http.get(START)  # robots.txt, rate limit and caching are handled for you
    for ev in jsonld_events(page.text):
        rec = event_to_show(ev, START)
        if rec:
            rec.setdefault("source_url", START)
            yield rec
'''

REGISTRY_SNIPPET = '''- id: {id}
  name: {name}
  url: {url}
  kind: aggregator          # aggregator, promoter, publisher, platform, venue
  method: script
  credit: "Listed by {name}"
  terms: "TODO: what the site's terms and robots.txt allow (checked {today})"
  fields: [name, days, venue, admission]
  checked: {today}
  priority: 60
  enabled: false            # turn on after the tests pass
'''


def scaffold_source(paths: Paths, source_id: str, name: str, url: str, today: date) -> tuple[Path, str]:
    import re
    if not re.fullmatch(r"[a-z][a-z0-9_]*", source_id):
        raise ValueError("a source id uses lowercase letters, digits and underscores, and starts with a letter")
    module = Path(__file__).parent / "sources" / f"{source_id}.py"
    if module.exists():
        raise FileExistsError(f"{module} already exists")
    module.write_text(TEMPLATE.format(name=name, url=url, today=today.isoformat()), encoding="utf-8")
    return module, REGISTRY_SNIPPET.format(id=source_id, name=name, url=url, today=today.isoformat())
