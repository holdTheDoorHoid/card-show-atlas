"""Make research batch files for the nightly runner.

Usage (from the repo root):
  python3 research/tools/make_batches.py leads   <wave> [--size 12] [--max 8]
  python3 research/tools/make_batches.py vendor  <wave> [--size 10] [--max 8] [--days 150]
  python3 research/tools/make_batches.py recheck <wave> [--size 15] [--max 4] [--days 21]
  python3 research/tools/make_batches.py series  <wave> [--size 12] [--max 4]

Writes research/batches/<wave>/<agent>.json and prints the agent ids. Items already handed out in an
earlier wave (research/batches/_done.jsonl) are skipped, so running a mode again picks up where the
last run stopped.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BATCHES = ROOT / "research" / "batches"
DONE = BATCHES / "_done.jsonl"


def norm(text: str | None) -> str:
    text = (text or "").lower()
    text = re.sub(r"\(.*?\)", " ", text)
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return " ".join(w for w in text.split() if w not in {"the", "card", "show", "shows", "and", "sports", "trading"})


def load_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def done_keys() -> set[str]:
    return {row["key"] for row in load_jsonl(DONE)}


def shows() -> list[dict]:
    return load_jsonl(ROOT / "data" / "shows.jsonl")


def series() -> list[dict]:
    return load_jsonl(ROOT / "data" / "series.jsonl")


def first_date(show: dict) -> str:
    return min(d["date"] for d in show.get("days") or [{"date": "9999-12-31"}])


def items_leads() -> list[tuple[str, dict]]:
    known = {norm(s.get("name")) for s in shows()}
    seen: set[str] = set()
    out = []
    for path in sorted((ROOT / "data" / "research" / "leads").glob("*.jsonl")):
        for lead in load_jsonl(path):
            if lead.get("type", "lead") != "lead":
                continue
            key = "lead:" + norm(lead.get("name")) + "|" + norm(lead.get("note"))[:40]
            n = norm(lead.get("name"))
            if not n or n in seen or n in known:
                continue
            note = (lead.get("note") or "").lower()
            if "out of scope" in note or "unrelated" in note:
                continue
            seen.add(n)
            out.append((key, {"name": lead.get("name"), "url": lead.get("url"), "note": lead.get("note")}))
    return out


def items_vendor(days: int) -> list[tuple[str, dict]]:
    today = dt.date.today().isoformat()
    until = (dt.date.today() + dt.timedelta(days=days)).isoformat()
    out = []
    for s in shows():
        d = first_date(s)
        if not (today <= d <= until) or s.get("status") == "cancelled":
            continue
        v = s.get("vendor") or {}
        if v.get("tables") or v.get("application_url"):
            continue
        link = (s.get("links") or {}).get("official") or (s.get("organizer") or {}).get("url")
        if not link:
            continue
        out.append(("vendor:" + s["id"], {"id": s["id"], "name": s["name"], "first_date": d,
                                          "city": s["venue"].get("city"), "region": s["venue"].get("region"),
                                          "official": link, "organizer": (s.get("organizer") or {}).get("name")}))
    return out


def items_recheck(days: int) -> list[tuple[str, dict]]:
    today = dt.date.today()
    until = (today + dt.timedelta(days=days)).isoformat()
    stamp = today.isocalendar()
    out = []
    for s in shows():
        d = first_date(s)
        if not (today.isoformat() <= d <= until):
            continue
        link = (s.get("links") or {}).get("official") or (s.get("organizer") or {}).get("url")
        if not link:
            continue
        # one recheck per show per ISO week
        out.append((f"recheck:{s['id']}:{stamp[0]}w{stamp[1]}", {"id": s["id"], "name": s["name"], "days": s["days"],
                                                                "status": s.get("status"), "city": s["venue"].get("city"),
                                                                "region": s["venue"].get("region"), "official": link}))
    return out


def items_series() -> list[tuple[str, dict]]:
    """Research series with a repeating rule but no dated sign of life: without one they make no tentative dates."""
    out = []
    for path in sorted((ROOT / "data" / "research").glob("*.jsonl")):
        for rec in load_jsonl(path):
            r = rec.get("record", rec)
            if r.get("kind") != "series" or r.get("last_confirmed"):
                continue
            if (r.get("rule") or {}).get("freq") not in ("weekly", "monthly"):
                continue
            ev = [e.get("url") for e in r.get("evidence") or [] if e.get("url")]
            out.append(("series:" + norm(r.get("name")) + "|" + norm((r.get("venue") or {}).get("city")),
                        {"name": r.get("name"), "cadence": r.get("cadence"), "rule": r.get("rule"),
                         "venue": r.get("venue"), "evidence": ev[:3]}))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["leads", "vendor", "recheck", "series"])
    ap.add_argument("wave")
    ap.add_argument("--size", type=int)
    ap.add_argument("--max", type=int, default=8, help="most agents (batches) to make")
    ap.add_argument("--days", type=int)
    args = ap.parse_args()

    size = args.size or {"leads": 12, "vendor": 10, "recheck": 15, "series": 12}[args.mode]
    if args.mode == "leads":
        items = items_leads()
    elif args.mode == "vendor":
        items = items_vendor(args.days or 150)
    elif args.mode == "recheck":
        items = items_recheck(args.days or 21)
    else:
        items = items_series()

    done = done_keys()
    items = [(k, v) for k, v in items if k not in done][: size * args.max]
    if not items:
        print("nothing left to research in this mode")
        return 0
    out_dir = BATCHES / args.wave
    out_dir.mkdir(parents=True, exist_ok=True)
    agents = []
    with DONE.open("a") as fh:
        for i in range(0, len(items), size):
            chunk = items[i:i + size]
            agent = f"b{i // size + 1:02d}"
            (out_dir / f"{agent}.json").write_text(json.dumps({"wave": args.wave, "mode": args.mode,
                                                              "items": [v for _, v in chunk]}, indent=1) + "\n")
            for k, _ in chunk:
                fh.write(json.dumps({"key": k, "wave": args.wave, "agent": agent}) + "\n")
            agents.append(agent)
    print(f"{len(items)} items in {len(agents)} batches: {' '.join(agents)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
