"""csa estimate: the crowd model of DESIGN section 4. Writes `estimate` on every show (DATA_MODEL section 4).

Signals are tried best first:

  reported  attendance the organizer or press gave for this edition
  history   a figure reported for an earlier edition of the same series, moved by the series trend
  players   registered players, times a people per player factor
  tables    vendor tables, times a people per table factor for the event type and number of days
  history   an earlier edition's table or player count, when this edition has none of its own
  area      venue floor area
  type_default  a rough guess for the event type

Factors and cut points come from data/model/priors.json. For tables, a factor fitted from shows
that report both attendance and tables replaces the prior once a group has enough of them.
"""

from __future__ import annotations

import math
import statistics
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

from .paths import Paths
from .util import parse_iso_date, read_json, read_jsonl, today as today_fn, write_jsonl

FACTOR_TYPES = ("card_show", "convention", "tournament", "pop_culture_con")


class PriorsError(ValueError):
    pass


def load_priors(path: Path) -> dict:
    priors = read_json(path)
    if not isinstance(priors, dict):
        raise PriorsError(f"{path} is missing or not a JSON object")
    problems = validate_priors(priors)
    if problems:
        raise PriorsError("; ".join(problems))
    return priors


def validate_priors(priors: dict) -> list[str]:
    """Every value that carries a number must say where it comes from."""
    problems: list[str] = []

    def walk(node: Any, where: str):
        if not isinstance(node, dict):
            return
        numeric = any(isinstance(node.get(k), (int, float)) and not isinstance(node.get(k), bool)
                      for k in ("low", "mid", "high", "value"))
        if numeric and not str(node.get("source") or "").strip():
            problems.append(f"{where} has no source note")
        for k, v in node.items():
            if isinstance(v, dict):
                walk(v, f"{where}.{k}" if where else k)

    walk(priors, "")
    for need in ("attendees_per_table", "type_default", "size_classes", "reported_band", "history", "calibration"):
        if need not in priors:
            problems.append(f"{need} is missing")
    return problems


def day_bucket(show: dict) -> str:
    n = len(show.get("days") or [])
    return "1" if n <= 1 else ("2" if n == 2 else "3+")


def round_sig(x: float, sig: int = 2) -> int:
    if x <= 0:
        return 0
    digits = sig - int(math.floor(math.log10(x))) - 1
    return int(round(x, digits)) if digits < 0 else int(round(x))


def _band(mid: float, low_f: float, high_f: float) -> dict:
    lo, hi = round_sig(mid * low_f), round_sig(mid * high_f)
    m = round_sig(mid)
    return {"low": min(lo, m), "mid": m, "high": max(hi, m)}


def _triple(low: float, mid: float, high: float, mult: float = 1.0) -> dict:
    lo, m, hi = round_sig(low * mult), round_sig(mid * mult), round_sig(high * mult)
    return {"low": min(lo, m), "mid": m, "high": max(hi, m)}


# ---------------------------------------------------------------- calibration

@dataclass
class Fit:
    group: tuple[str, str]
    n: int
    median: float
    p25: float
    p75: float
    prior_mid: float | None
    used: str  # "fitted" or "prior"


def _quantile(values: list[float], q: float) -> float:
    s = sorted(values)
    if len(s) == 1:
        return s[0]
    pos = q * (len(s) - 1)
    lo, hi = math.floor(pos), math.ceil(pos)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


def calibration_samples(shows: list[dict]) -> dict[tuple[str, str], list[float]]:
    """Attendees per table for shows that publish both numbers for the same edition."""
    out: dict[tuple[str, str], list[float]] = defaultdict(list)
    for s in shows:
        size = s.get("size") or {}
        ra = size.get("reported_attendance")
        tables = size.get("tables") or size.get("booths")
        first = parse_iso_date(((s.get("days") or [{}])[0]).get("date"))
        if not ra or not ra.get("value") or not tables or not first:
            continue
        if ra.get("year") not in (None, first.year):
            continue  # a figure for a different year says little about this year's tables
        if s.get("event_type") not in FACTOR_TYPES:
            continue
        out[(s["event_type"], day_bucket(s))].append(ra["value"] / tables)
    return out


def fit_factors(shows: list[dict], priors: dict) -> list[Fit]:
    min_n = priors["calibration"]["min_samples"]["value"]
    fits = []
    samples = calibration_samples(shows)
    for group in sorted(set(samples) | {(t, b) for t in priors["attendees_per_table"] for b in priors["attendees_per_table"][t]}):
        vals = samples.get(group, [])
        prior = priors["attendees_per_table"].get(group[0], {}).get(group[1])
        if not vals and not prior:
            continue
        fits.append(Fit(group, len(vals), statistics.median(vals) if vals else float("nan"),
                        _quantile(vals, 0.25) if vals else float("nan"), _quantile(vals, 0.75) if vals else float("nan"),
                        prior["mid"] if prior else None, "fitted" if len(vals) >= min_n else "prior"))
    return fits


def factors_in_use(fits: list[Fit], priors: dict) -> dict[tuple[str, str], dict]:
    out = {}
    for f in fits:
        if f.used == "fitted":
            out[f.group] = {"low": f.p25, "mid": f.median, "high": f.p75}
        else:
            p = priors["attendees_per_table"].get(f.group[0], {}).get(f.group[1])
            if p:
                out[f.group] = {"low": p["low"], "mid": p["mid"], "high": p["high"]}
    return out


def calibration_report(fits: list[Fit], min_n: int) -> list[str]:
    lines = [f"Attendees per table, fitted from shows that report both numbers (a fit is used from {min_n} shows)",
             f"{'event type':<16}{'days':<6}{'shows':>6}{'median':>9}{'low (p25)':>11}{'high (p75)':>12}{'prior mid':>11}  used"]
    for f in fits:
        def num(x):
            return "" if x != x else f"{x:.1f}"
        lines.append(f"{f.group[0]:<16}{f.group[1]:<6}{f.n:>6}{num(f.median):>9}{num(f.p25):>11}{num(f.p75):>12}"
                     f"{(f'{f.prior_mid:.1f}' if f.prior_mid is not None else ''):>11}  {f.used}")
    if not any(f.n for f in fits):
        lines.append("No show reports both attendance and tables yet, so every group uses its prior.")
    return lines


# ---------------------------------------------------------------- the model

@dataclass
class Model:
    priors: dict
    factors: dict[tuple[str, str], dict]
    by_series: dict[str, list[dict]] = field(default_factory=dict)
    fitted_n: dict[tuple[str, str], int] = field(default_factory=dict)

    def size_class(self, mid: float) -> str:
        c = self.priors["size_classes"]
        if mid < c["small_max"]["value"]:
            return "small"
        if mid < c["medium_max"]["value"]:
            return "medium"
        if mid < c["large_max"]["value"]:
            return "large"
        return "major"

    def confidence(self, basis: str) -> str:
        return self.priors["confidence_by_basis"][basis]

    def factor(self, show: dict) -> dict | None:
        return self.factors.get((show.get("event_type"), day_bucket(show)))

    # -------- signals
    def _tables_estimate(self, show: dict) -> dict | None:
        size = show.get("size") or {}
        tables = size.get("tables") or size.get("booths")
        f = self.factor(show)
        if not tables or not f:
            return None
        return _triple(tables * f["low"], tables * f["mid"], tables * f["high"])

    def _past_points(self, show: dict) -> list[dict]:
        first = ((show.get("days") or [{}])[0]).get("date") or ""
        return [e for e in self.by_series.get(show.get("series_id"), []) if e["id"] != show["id"] and e["days"][0]["date"] < first]

    def _reported_points(self, show: dict) -> list[tuple[int, float, int | None, dict]]:
        """(year, attendance, tables, record) for earlier reports in this series, including this record's own old figure."""
        first = parse_iso_date(((show.get("days") or [{}])[0]).get("date"))
        points = []
        max_age = self.priors["history"]["max_age_years"]["value"]
        for e in self._past_points(show) + [show]:
            ra = (e.get("size") or {}).get("reported_attendance")
            if not ra or not ra.get("value"):
                continue
            d = parse_iso_date(e["days"][0]["date"])
            year = ra.get("year") or (d.year if d else None)
            if year is None or (e is show and year >= (first.year if first else 9999)):
                continue  # this edition's own figure is handled as "reported"
            if first and first.year - year > max_age:
                continue
            tables = (e.get("size") or {}).get("tables") or (e.get("size") or {}).get("booths")
            points.append((year, float(ra["value"]), tables, e))
        points.sort(key=lambda p: (p[0], p[3]["days"][0]["date"]))
        return points

    def estimate(self, show: dict) -> dict | None:
        if show.get("event_type") == "store_event":
            return None
        size = show.get("size") or {}
        tables = size.get("tables") or size.get("booths")
        traffic = None
        days = day_bucket(show)
        label = {"1": "one day", "2": "two day", "3+": "multi day"}[days]
        et = (show.get("event_type") or "card_show").replace("_", " ")
        first = parse_iso_date(((show.get("days") or [{}])[0]).get("date"))

        def finish(att: dict, basis: str, explain: str) -> dict:
            tpt = round(att["mid"] / tables, 1) if tables else None
            return {"attendance": att, "basis": basis, "confidence": self.confidence(basis),
                    "size_class": self.size_class(att["mid"]), "traffic_per_table": tpt, "explain": explain}

        # 1. this edition's reported figure
        ra = size.get("reported_attendance")
        if ra and ra.get("value") and (ra.get("year") is None or first is None or ra["year"] >= first.year):
            b = self.priors["reported_band"]
            att = _band(ra["value"], b["low"], b["high"])
            att["mid"] = int(ra["value"])
            att["low"], att["high"] = min(att["low"], att["mid"]), max(att["high"], att["mid"])
            yr = f" in {ra['year']}" if ra.get("year") else ""
            return finish(att, "reported", f"Reported by the organizer or press: about {int(ra['value']):,} people{yr}.")

        # 2. an earlier edition's reported figure, carried forward
        points = self._reported_points(show)
        if points:
            year, value, past_tables, _ = points[-1]
            h = self.priors["history"]
            mid = value
            if len(points) >= 2 and points[-2][1] > 0:
                clamp = h["trend_clamp"]
                mid *= min(max(value / points[-2][1], clamp["low"]), clamp["high"])
            if tables and past_tables:
                rc = h["table_ratio_clamp"]
                mid *= min(max(tables / past_tables, rc["low"]), rc["high"])
            att = _band(mid, h["band"]["low"], h["band"]["high"])
            return finish(att, "history", f"Carried forward from {int(value):,} people reported for {year}"
                          + (", adjusted for the trend in earlier years." if len(points) >= 2 else "."))

        # 3. players
        players = size.get("players")
        pa = self.priors["players_to_attendance"]
        if players:
            att = _triple(players * pa["low"], players * pa["mid"], players * pa["high"])
            return finish(att, "players", f"Estimated from {players:,} registered players at a {label} {et}.")

        # 4. tables
        est = self._tables_estimate(show)
        if est:
            note = ""
            n_fit = self.fitted_n.get((show.get("event_type"), days))
            if n_fit:
                note = f" Uses a factor fitted from {n_fit} shows."
            return finish(est, "tables", f"Estimated from {tables:,} vendor tables at a {label} {et}.{note}")

        # 5. an earlier edition's size
        for e in reversed(self._past_points(show)):
            es = e.get("size") or {}
            if es.get("players"):
                att = _triple(es["players"] * pa["low"], es["players"] * pa["mid"], es["players"] * pa["high"])
                return finish(att, "history", f"Estimated from {es['players']:,} players at an earlier edition.")
            past = self._tables_estimate({**e, "event_type": show.get("event_type"), "days": show.get("days")})
            if past:
                n = es.get("tables") or es.get("booths")
                return finish(past, "history", f"Estimated from {n:,} vendor tables at an earlier edition.")

        # 6. floor area
        sqft = size.get("venue_sqft")
        if sqft:
            a = self.priors["attendees_per_1000_sqft_per_day"]
            nd = max(len(show.get("days") or []), 1)
            k = sqft / 1000 * nd
            att = _triple(k * a["low"], k * a["mid"], k * a["high"])
            return finish(att, "area", f"Rough guess from a venue of {sqft:,} square feet over {nd} day{'s' if nd > 1 else ''}.")

        # 7. nothing known
        d = self.priors["type_default"].get(show.get("event_type")) or self.priors["type_default"]["card_show"]
        pick = d.get(days) or d["1"]
        att = _triple(pick["low"], pick["mid"], pick["high"])
        return finish(att, "type_default", f"Rough guess for a {label} {et} with no size information.")


@dataclass
class EstimateReport:
    shows: int = 0
    by_basis: dict[str, int] = field(default_factory=dict)
    by_class: dict[str, int] = field(default_factory=dict)
    fits: list[Fit] = field(default_factory=list)

    def lines(self) -> list[str]:
        b = ", ".join(f"{k} {v}" for k, v in sorted(self.by_basis.items())) or "none"
        c = ", ".join(f"{k} {v}" for k, v in sorted(self.by_class.items())) or "none"
        fitted = [f"{f.group[0]}/{f.group[1]}" for f in self.fits if f.used == "fitted"]
        return [f"Estimated {self.shows} shows. By basis: {b}. By size: {c}.",
                "  fitted factors in use: " + (", ".join(fitted) if fitted else "none, all priors")]


def build_model(shows: list[dict], priors: dict) -> tuple[Model, list[Fit]]:
    fits = fit_factors(shows, priors)
    by_series: dict[str, list[dict]] = defaultdict(list)
    for s in shows:
        by_series[s.get("series_id")].append(s)
    for v in by_series.values():
        v.sort(key=lambda e: e["days"][0]["date"])
    fitted_n = {f.group: f.n for f in fits if f.used == "fitted"}
    return Model(priors, factors_in_use(fits, priors), by_series, fitted_n), fits


def run_estimate(paths: Paths) -> EstimateReport:
    priors = load_priors(paths.priors)
    shows = read_jsonl(paths.shows)
    model, fits = build_model(shows, priors)
    rep = EstimateReport(fits=fits)
    for s in shows:
        s["estimate"] = model.estimate(s)
        if s["estimate"]:
            rep.shows += 1
            rep.by_basis[s["estimate"]["basis"]] = rep.by_basis.get(s["estimate"]["basis"], 0) + 1
            rep.by_class[s["estimate"]["size_class"]] = rep.by_class.get(s["estimate"]["size_class"], 0) + 1
    write_jsonl(paths.shows, shows)
    return rep


def run_calibrate(paths: Paths) -> list[str]:
    priors = load_priors(paths.priors)
    shows = read_jsonl(paths.shows)
    fits = fit_factors(shows, priors)
    return calibration_report(fits, priors["calibration"]["min_samples"]["value"])
