"""Recurring series (DATA_MODEL section 9.1): repair a series record, then expand it into editions.

Expansion rules, applied by `csa merge` every run so the 90 day window moves with the calendar:

* every date in known_dates becomes a scheduled edition (cancelled if it is also in cancelled_dates);
* the rule makes tentative editions for the next 90 days only, never past `until`, skipping
  skip_months and cancelled_dates and dates that are already known;
* a series whose last_confirmed is missing or older than 120 days makes no tentative editions.
"""

from __future__ import annotations

import calendar
import copy
from datetime import date, timedelta
from typing import Any

from .normalize import Notes, _clean_text, _date_value, _time_value, repair_edition
from .textparse import WEEKDAY_CODES, nth_value, weekday_code
from .util import parse_iso_date
from .vocab import Vocab

TENTATIVE_HORIZON_DAYS = 90
STALE_AFTER_DAYS = 120
TENTATIVE_NOTE = "Usually on this date. Check with the organizer before you go."
FREQS = ("weekly", "monthly", "none")

# What each series field means for an edition's `sources[].fields`.
_FIELD_MAP = {"cadence": "days", "known_dates": "days", "cancelled_dates": "days", "rule": "days",
              "hours": "days", "last_confirmed": "days"}


def repair_series(rec: dict, vocab: Vocab, today: date | None = None) -> tuple[dict, list[str]]:
    """Repair the shared show fields and the series only fields. Returns (record, notes)."""
    shared = {k: v for k, v in rec.items() if k not in ("rule", "hours", "known_dates", "cancelled_dates",
                                                         "last_confirmed", "cadence")}
    out, notes_list = repair_edition(shared, vocab, today)
    notes = Notes(notes_list)
    out.pop("days", None)
    if rec.get("cadence") is not None:
        out["cadence"] = _clean_text(rec["cadence"], "cadence", notes, 200)

    rule_in = rec.get("rule")
    rule: dict[str, Any] = {"freq": "none", "weekday": None, "nth": None, "skip_months": [], "until": None}
    if isinstance(rule_in, dict):
        freq = str(rule_in.get("freq") or "none").strip().lower()
        if freq not in FREQS:
            notes.add("rule.freq", f"{rule_in.get('freq')!r} is not weekly, monthly or none, treated as none")
            freq = "none"
        rule["freq"] = freq
        if rule_in.get("weekday") is not None:
            wd = weekday_code(rule_in["weekday"])
            if wd is None:
                notes.add("rule.weekday", f"{rule_in['weekday']!r} is not a weekday, dropped")
            elif wd != rule_in["weekday"]:
                notes.add("rule.weekday", f"{rule_in['weekday']!r} became {wd}")
            rule["weekday"] = wd
        if rule_in.get("nth") is not None:
            n = nth_value(rule_in["nth"])
            if n is None:
                notes.add("rule.nth", f"{rule_in['nth']!r} is not 1 to 4 or -1, dropped")
            elif n != rule_in["nth"]:
                notes.add("rule.nth", f"{rule_in['nth']!r} became {n}")
            rule["nth"] = n
        months = []
        for m in rule_in.get("skip_months") or []:
            mi = _month_number(m)
            if mi is None:
                notes.add("rule.skip_months", f"{m!r} is not a month, dropped")
            elif mi not in months:
                months.append(mi)
        rule["skip_months"] = sorted(months)
        rule["until"] = _date_value(rule_in.get("until"), "rule.until", notes, today)
    out["rule"] = rule

    hours_in = rec.get("hours") if isinstance(rec.get("hours"), dict) else {}
    out["hours"] = {"open": _time_value(hours_in.get("open"), "hours.open", notes),
                    "close": _time_value(hours_in.get("close"), "hours.close", notes)}

    for key in ("known_dates", "cancelled_dates"):
        vals = []
        for i, v in enumerate(rec.get(key) or []):
            d = _date_value(v, f"{key}[{i}]", notes, today)
            if d and d not in vals:
                vals.append(d)
        out[key] = sorted(vals)
    out["last_confirmed"] = _date_value(rec.get("last_confirmed"), "last_confirmed", notes, today)
    out["kind"] = "series"
    return out, list(notes)


def _month_number(value: Any) -> int | None:
    if isinstance(value, int) and 1 <= value <= 12:
        return value
    from .textparse import MONTHS
    s = str(value).strip().lower().rstrip(".")
    if s.isdigit() and 1 <= int(s) <= 12:
        return int(s)
    return MONTHS.get(s)


def rule_problems(series: dict) -> list[str]:
    """Reasons a repaired series cannot be expanded. Empty means fine."""
    rule = series.get("rule") or {}
    freq = rule.get("freq")
    problems = []
    if freq in ("weekly", "monthly") and rule.get("weekday") is None:
        problems.append("rule.weekday is needed for a weekly or monthly rule")
    if freq == "monthly" and rule.get("nth") is None:
        problems.append("rule.nth must be 1 to 4, or -1 for the last, for a monthly rule")
    if freq == "none" and not series.get("known_dates"):
        problems.append("a rule of none needs known_dates, otherwise there is nothing to expand")
    return problems


# ---------------------------------------------------------------- date arithmetic

def nth_weekday(year: int, month: int, weekday: int, nth: int) -> date | None:
    """The nth (1 to 4) or last (-1) given weekday of a month. weekday: Monday is 0."""
    if nth == -1:
        last = calendar.monthrange(year, month)[1]
        d = date(year, month, last)
        return d - timedelta(days=(d.weekday() - weekday) % 7)
    if nth not in (1, 2, 3, 4):
        return None
    first = date(year, month, 1)
    d = first + timedelta(days=(weekday - first.weekday()) % 7 + 7 * (nth - 1))
    return d if d.month == month else None


def rule_dates(rule: dict, start: date, end: date) -> list[date]:
    """Every date the rule produces from start to end inclusive, before skip and until filtering."""
    freq = rule.get("freq")
    wd = WEEKDAY_CODES.index(rule["weekday"]) if rule.get("weekday") in WEEKDAY_CODES else None
    if wd is None or freq not in ("weekly", "monthly"):
        return []
    out: list[date] = []
    if freq == "weekly":
        d = start + timedelta(days=(wd - start.weekday()) % 7)
        while d <= end:
            out.append(d)
            d += timedelta(days=7)
        return out
    nth = rule.get("nth")
    if nth is None:
        return []
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        d = nth_weekday(y, m, wd, nth)
        if d and start <= d <= end:
            out.append(d)
        m += 1
        if m == 13:
            y, m = y + 1, 1
    return out


def is_stale(series: dict, today: date) -> bool:
    lc = parse_iso_date(series.get("last_confirmed"))
    return lc is None or (today - lc).days > STALE_AFTER_DAYS


# ---------------------------------------------------------------- expansion

def _edition_sources(series: dict) -> list[dict]:
    out = []
    for s in series.get("sources") or []:
        fields = []
        for f in s.get("fields") or []:
            f = _FIELD_MAP.get(f, f)
            if f not in fields:
                fields.append(f)
        out.append({**s, "fields": fields})
    return out


def expand_series(series: dict, today: date) -> list[dict]:
    """Partial edition records for one repaired series record.

    Each carries transient keys that merge reads and removes: _generated ("known" or "tentative"),
    _cadence and _series_name.
    """
    base_keys = ("name", "event_type", "venue", "sells", "mix", "admission", "size", "vendor", "organizer",
                 "links", "summary", "verification", "first_seen", "last_checked", "research_id", "agent_confidence")
    base = {k: copy.deepcopy(series[k]) for k in base_keys if k in series and series[k] is not None}
    base["sources"] = _edition_sources(series)
    hours = series.get("hours") or {}
    rule = series.get("rule") or {}
    cancelled = set(series.get("cancelled_dates") or [])
    known = list(series.get("known_dates") or [])
    out: list[dict] = []

    def make(d: date, generated: str, status: str) -> dict:
        rec = copy.deepcopy(base)
        rec["days"] = [{"date": d.isoformat(), "open": hours.get("open"), "close": hours.get("close")}]
        rec["status"] = status
        rec["_generated"] = generated
        rec["_cadence"] = series.get("cadence")
        if generated == "tentative":
            rec["verification"] = "unverified"
        return rec

    for iso in known:
        d = parse_iso_date(iso)
        if d:
            out.append(make(d, "known", "cancelled" if iso in cancelled else "scheduled"))

    if rule.get("freq") in ("weekly", "monthly") and not is_stale(series, today):
        until = parse_iso_date(rule.get("until"))
        skip = set(rule.get("skip_months") or [])
        for d in rule_dates(rule, today, today + timedelta(days=TENTATIVE_HORIZON_DAYS)):
            iso = d.isoformat()
            if iso in known or iso in cancelled or d.month in skip or (until and d > until):
                continue
            out.append(make(d, "tentative", "tentative"))
    return out
