"""Small helpers shared by every command."""

from __future__ import annotations

import functools
import json
import math
import os
import re
import tempfile
import unicodedata
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator


def today() -> date:
    """Today's date. CSA_TODAY (YYYY-MM-DD) overrides it so runs and tests are repeatable."""
    env = os.environ.get("CSA_TODAY")
    if env:
        return date.fromisoformat(env)
    return date.today()


def now_iso() -> str:
    """UTC time like 2026-10-21T04:00:00Z. With CSA_TODAY set it is midnight of that day, so runs repeat exactly."""
    if os.environ.get("CSA_TODAY"):
        return f"{today().isoformat()}T00:00:00Z"
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def iso(d: date | None) -> str | None:
    return d.isoformat() if d else None


def add_months(d: date, months: int) -> date:
    y, m = divmod(d.year * 12 + (d.month - 1) + months, 12)
    m += 1
    last = [31, 29 if (y % 4 == 0 and (y % 100 != 0 or y % 400 == 0)) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
    return date(y, m, min(d.day, last))


# ---------------------------------------------------------------- files

def read_json(path: Path, default: Any = None) -> Any:
    path = Path(path)
    if not path.exists():
        return default
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def _atomic_write(path: Path, text: str) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
        os.chmod(tmp, 0o644)  # mkstemp makes files private; data files are ordinary public files
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def write_json(path: Path, obj: Any, *, indent: int | None = 2, sort_keys: bool = True, compact: bool = False) -> None:
    if compact:
        text = json.dumps(obj, ensure_ascii=False, separators=(",", ":"), sort_keys=sort_keys)
    else:
        text = json.dumps(obj, ensure_ascii=False, indent=indent, sort_keys=sort_keys)
    _atomic_write(path, text + "\n")


def read_jsonl(path: Path) -> list[dict]:
    path = Path(path)
    if not path.exists():
        return []
    rows = []
    with path.open("r", encoding="utf-8") as fh:
        for n, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path} line {n}: not valid JSON ({exc.msg})") from exc
    return rows


def write_jsonl(path: Path, rows: Iterable[dict], *, sort_keys: bool = False) -> int:
    lines = [json.dumps(r, ensure_ascii=False, sort_keys=sort_keys, separators=(",", ":")) for r in rows]
    _atomic_write(path, "".join(line + "\n" for line in lines))
    return len(lines)


def iter_jsonl_files(directory: Path) -> Iterator[tuple[Path, list[dict]]]:
    directory = Path(directory)
    if not directory.exists():
        return
    for p in sorted(directory.glob("*.jsonl")):
        yield p, read_jsonl(p)


# ---------------------------------------------------------------- text

def strip_accents(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c))


@functools.lru_cache(maxsize=1 << 16)
def _norm_cached(text: str) -> str:
    text = strip_accents(text).lower().replace("&", " and ")
    text = text.replace("'", "").replace("\u2019", "")
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def norm_text(text: str | None) -> str:
    """Lowercase, no accents, letters and digits separated by single spaces."""
    if not text:
        return ""
    text = strip_accents(str(text)).lower().replace("&", " and ")
    text = text.replace("'", "").replace("’", "")
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def slugify(text: str | None) -> str:
    return norm_text(text).replace(" ", "-")


# ---------------------------------------------------------------- dates

def parse_iso_date(value: Any) -> date | None:
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        try:
            return date.fromisoformat(value)
        except ValueError:
            return None
    return None


def daterange(start: date, end: date) -> Iterator[date]:
    d = start
    while d <= end:
        yield d
        d += timedelta(days=1)


# ---------------------------------------------------------------- nested dicts

def deep_get(obj: Any, path: str, default: Any = None) -> Any:
    cur = obj
    for part in path.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return default
    return cur


def deep_set(obj: dict, path: str, value: Any) -> None:
    parts = path.split(".")
    cur = obj
    for part in parts[:-1]:
        nxt = cur.get(part)
        if not isinstance(nxt, dict):
            nxt = {}
            cur[part] = nxt
        cur = nxt
    cur[parts[-1]] = value


def is_empty(value: Any) -> bool:
    return value is None or value == "" or value == [] or value == {}


# ---------------------------------------------------------------- geometry

def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))
