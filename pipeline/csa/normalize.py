"""Repair small mistakes in a partial show record.

Every way into the data (harvest, research, submissions) runs records through repair_edition,
so the rest of the pipeline sees one consistent shape. It only fixes things whose meaning is
clear: date and time formats, region names to codes, vocabulary synonyms, money written as
text. Anything it cannot read it drops and reports. It never invents a value, with one
exception it always reports: a missing currency is taken from the venue's country.

Privacy: phone numbers are removed from every free text field, because the data may only
carry contacts the organizer published for the show, and a number alone cannot tell us whether
it is a business line.
"""

from __future__ import annotations

import copy
from datetime import date
from typing import Any

from . import model
from .regions import REGION_COUNTRY, country_code, region_code
from .textparse import (find_dates, norm_currency, norm_postal, norm_url, parse_address_text, parse_bool,
                        parse_date_text, parse_int, parse_money, parse_time_text, scrub_phones)
from .util import slugify
from .vocab import SELLS_GROUPS, Vocab

NOTE_LIMIT = 300
SHORT_LIMIT = 120
MAX_SPAN_DAYS = 14


class Notes(list):
    def add(self, path: str, text: str) -> None:
        self.append(f"{path}: {text}")


def _clean_text(value: Any, path: str, notes: Notes, limit: int = NOTE_LIMIT) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        value = str(value)
    text = " ".join(value.split())
    if not text:
        return None
    text, removed = scrub_phones(text)
    if removed:
        notes.add(path, "removed a phone number (only organizer published emails and pages are kept)")
    if not text:
        return None
    if len(text) > limit:
        notes.add(path, f"dropped, it was longer than {limit} characters and may be copied text")
        return None
    return text


def _date_value(value: Any, path: str, notes: Notes, today: date | None) -> str | None:
    if value is None or value == "":
        return None
    d = parse_date_text(value, today)
    if d is None:
        notes.add(path, f"could not read the date {value!r}, dropped")
        return None
    if str(value).strip() != d.isoformat():
        notes.add(path, f"date {value!r} became {d.isoformat()}")
    return d.isoformat()


def _time_value(value: Any, path: str, notes: Notes) -> str | None:
    if value is None or value == "":
        return None
    t = parse_time_text(value)
    if t is None:
        notes.add(path, f"could not read the time {value!r}, dropped")
        return None
    if str(value).strip() != t:
        notes.add(path, f"time {value!r} became {t}")
    return t


# ---------------------------------------------------------------- days

def repair_days(value: Any, notes: Notes, today: date | None) -> list[dict]:
    if value is None:
        return []
    items = value if isinstance(value, list) else [value]
    days: dict[str, dict] = {}
    for i, item in enumerate(items):
        path = f"days[{i}]"
        if isinstance(item, dict) and ("start" in item or "end" in item) and "date" not in item:
            s = parse_date_text(item.get("start"), today)
            e = parse_date_text(item.get("end"), today) or s
            if s and e and 0 <= (e - s).days < MAX_SPAN_DAYS:
                notes.add(path, f"range {item.get('start')} to {item.get('end')} became one entry per day")
                for n in range((e - s).days + 1):
                    d = date.fromordinal(s.toordinal() + n).isoformat()
                    days.setdefault(d, {"date": d, "open": _time_value(item.get("open"), path + ".open", notes),
                                        "close": _time_value(item.get("close"), path + ".close", notes)})
            else:
                notes.add(path, "could not read this date range, dropped")
            continue
        if isinstance(item, dict):
            raw_date, o, c = item.get("date"), item.get("open"), item.get("close")
        else:
            raw_date, o, c = item, None, None
        found = find_dates(str(raw_date), today) if raw_date is not None else []
        if not found:
            notes.add(path, f"could not read the date {raw_date!r}, dropped")
            continue
        if len(found) > 1:
            notes.add(path, f"{raw_date!r} holds several dates, split into one entry per date")
        elif str(raw_date).strip() != found[0].isoformat():
            notes.add(path, f"date {raw_date!r} became {found[0].isoformat()}")
        for d in found:
            days.setdefault(d.isoformat(), {"date": d.isoformat(),
                                            "open": _time_value(o, path + ".open", notes),
                                            "close": _time_value(c, path + ".close", notes)})
    return [days[k] for k in sorted(days)]


# ---------------------------------------------------------------- venue

def repair_venue(value: Any, notes: Notes) -> dict:
    if isinstance(value, str):
        parsed = parse_address_text(value)
        notes.add("venue", "text address was split into fields; check it")
        value = parsed
    if not isinstance(value, dict):
        return {}
    v = {k: value[k] for k in model.VENUE_KEYS if k in value}
    for k in ("name", "address", "city"):
        if k in v:
            v[k] = _clean_text(v[k], f"venue.{k}", notes, SHORT_LIMIT * 2)
    if "region" in v and v["region"] is not None:
        code = region_code(v["region"])
        if code is None:
            notes.add("venue.region", f"{v['region']!r} is not a state or province, kept as written")
        else:
            if code != v["region"]:
                notes.add("venue.region", f"{v['region']!r} became {code}")
            v["region"] = code
    if "country" in v and v["country"] is not None:
        cc = country_code(v["country"])
        if cc is None:
            notes.add("venue.country", f"{v['country']!r} is not US or Canada, kept as written")
        else:
            if cc != v["country"]:
                notes.add("venue.country", f"{v['country']!r} became {cc}")
            v["country"] = cc
    if not v.get("country") and v.get("region") in REGION_COUNTRY:
        v["country"] = REGION_COUNTRY[v["region"]]
        notes.add("venue.country", f"filled in {v['country']} from region {v['region']}")
    if "postal" in v:
        v["postal"] = norm_postal(v["postal"])
    for k in ("lat", "lon"):
        if k in v and v[k] is not None:
            try:
                v[k] = float(v[k])
            except (TypeError, ValueError):
                notes.add(f"venue.{k}", f"{v[k]!r} is not a number, dropped")
                v[k] = None
    lat, lon = v.get("lat"), v.get("lon")
    if lat is not None and lon is not None and abs(lat) > 90 and abs(lon) <= 90:
        v["lat"], v["lon"] = lon, lat
        notes.add("venue", "latitude and longitude were swapped, fixed")
    if (v.get("lat") is None) != (v.get("lon") is None):
        v["lat"] = v["lon"] = None
        v.pop("geo_precision", None)
        notes.add("venue", "only one of lat and lon was given, both dropped")
    if v.get("geo_precision") is not None and v["geo_precision"] not in model.GEO_PRECISIONS:
        notes.add("venue.geo_precision", f"{v['geo_precision']!r} is not a precision, dropped")
        v["geo_precision"] = None
    if v.get("lat") is not None and not v.get("geo_precision"):
        v["geo_precision"] = "address" if v.get("address") else "venue"
        notes.add("venue.geo_precision", f"coordinates came without a precision, set to {v['geo_precision']}")
    return v


# ---------------------------------------------------------------- sells

def repair_sells(value: Any, vocab: Vocab, notes: Notes) -> dict:
    out = {g: [] for g in SELLS_GROUPS}
    tokens: list[str] = []
    if isinstance(value, dict):
        for g, items in value.items():
            if isinstance(items, str):
                items = [t for t in items.replace(";", ",").split(",")]
            for t in items or []:
                tokens.append(str(t))
    elif isinstance(value, list):
        tokens = [str(t) for t in value]
    elif isinstance(value, str):
        tokens = [t for t in value.replace(";", ",").split(",")]
    for tok in tokens:
        ids = vocab.resolve("sells", tok)
        if not ids:
            if tok.strip():
                notes.add("sells", f"{tok.strip()!r} is not in the vocabulary, dropped")
            continue
        if ids != [tok]:
            notes.add("sells", f"{tok.strip()!r} became {', '.join(ids)}")
        for i in ids:
            g = vocab.sells_ids[i]
            if i not in out[g]:
                out[g].append(i)
    return out


# ---------------------------------------------------------------- money sections

def _price_and_currency(value: Any, currency: Any, country: str | None, path: str, notes: Notes):
    amount, cur_in_text = parse_money(value)
    cur = norm_currency(currency) or cur_in_text
    if currency and norm_currency(currency) is None:
        notes.add(path, f"currency {currency!r} is not USD or CAD, dropped")
    return amount, cur


def repair_admission(value: Any, country: str | None, notes: Notes) -> dict:
    if isinstance(value, (str, int, float)) and not isinstance(value, bool):
        amount, cur = parse_money(value)
        text = str(value)
        if amount is None:
            value = {"notes": text}
        else:
            value = {"free": True if amount == 0 else None, "adult": amount, "currency": cur}
        notes.add("admission", f"text {text!r} was read as an entry price")
    if not isinstance(value, dict):
        return {}
    a = {k: value[k] for k in model.ADMISSION_KEYS if k in value}
    cur = norm_currency(a.get("currency"))
    if a.get("currency") and not cur:
        notes.add("admission.currency", f"{a['currency']!r} is not USD or CAD, dropped")
    for k in ("adult", "child"):
        if k in a and a[k] is not None:
            amount, cur_t = parse_money(a[k])
            a[k] = amount
            cur = cur or cur_t
    if "free" in a and a["free"] is not None and not isinstance(a["free"], bool):
        b = parse_bool(a["free"])
        a["free"] = b
    if a.get("free") is None and a.get("adult") is not None:
        a["free"] = a["adult"] == 0
    has_price = any(a.get(k) not in (None, 0) for k in ("adult", "child"))
    if cur is None and has_price and country in ("US", "CA"):
        cur = "USD" if country == "US" else "CAD"
        notes.add("admission.currency", f"no currency given, assumed {cur} from the venue's country")
    if cur:
        a["currency"] = cur
    elif "currency" in a:
        a["currency"] = None
    if "notes" in a:
        a["notes"] = _clean_text(a["notes"], "admission.notes", notes)
    return a


def repair_vendor(value: Any, vocab: Vocab, country: str | None, today: date | None, notes: Notes) -> dict:
    if not isinstance(value, dict):
        return {}
    v = {k: value[k] for k in model.VENDOR_KEYS if k in value}
    if "tables" in v:
        tables = []
        raw = v["tables"] if isinstance(v["tables"], list) else ([v["tables"]] if v["tables"] else [])
        for i, t in enumerate(raw):
            path = f"vendor.tables[{i}]"
            if isinstance(t, str):
                amount, cur = parse_money(t)
                t = {"label": t, "price": amount, "currency": cur}
                notes.add(path, "text was read as a table entry; check the label and price")
            if not isinstance(t, dict):
                notes.add(path, "not a table entry, dropped")
                continue
            amount, cur = _price_and_currency(t.get("price"), t.get("currency"), country, path, notes)
            if amount is not None and cur is None and country in ("US", "CA"):
                cur = "USD" if country == "US" else "CAD"
                notes.add(path + ".currency", f"no currency given, assumed {cur} from the venue's country")
            entry = {"label": _clean_text(t.get("label"), path + ".label", notes, SHORT_LIMIT),
                     "price": amount, "currency": cur,
                     "notes": _clean_text(t.get("notes"), path + ".notes", notes)}
            if entry["label"] is None and entry["price"] is None:
                continue
            tables.append(entry)
        v["tables"] = tables
    if "application_url" in v and v["application_url"] is not None:
        u = norm_url(v["application_url"])
        if u is None:
            notes.add("vendor.application_url", f"{v['application_url']!r} is not a web address, dropped")
        v["application_url"] = u
    for k in ("opens", "deadline"):
        if k in v:
            v[k] = _date_value(v[k], f"vendor.{k}", notes, today)
    if "setup" in v:
        v["setup"] = _time_value(v["setup"], "vendor.setup", notes)
    if "status" in v and v["status"] is not None:
        sid = vocab.resolve_one("vendor_status", v["status"])
        if sid is None:
            notes.add("vendor.status", f"{v['status']!r} is not a vendor status, dropped")
        elif sid != v["status"]:
            notes.add("vendor.status", f"{v['status']!r} became {sid}")
        v["status"] = sid
    for k, lim in (("electricity", SHORT_LIMIT), ("contact", SHORT_LIMIT * 2), ("notes", NOTE_LIMIT)):
        if k in v:
            v[k] = _clean_text(v[k], f"vendor.{k}", notes, lim)
    return v


def repair_size(value: Any, notes: Notes) -> dict:
    if not isinstance(value, dict):
        return {}
    s = {k: value[k] for k in model.SIZE_KEYS if k in value}
    for k in ("tables", "booths", "venue_sqft", "players", "first_year", "edition"):
        if k in s and s[k] is not None:
            n = parse_int(s[k])
            if n is None:
                notes.add(f"size.{k}", f"{s[k]!r} is not a number, dropped")
            elif n != s[k]:
                notes.add(f"size.{k}", f"{s[k]!r} became {n}")
            s[k] = n
    ra = s.get("reported_attendance")
    if ra is not None:
        if not isinstance(ra, dict):
            ra = {"value": ra, "year": None, "source_url": None}
        value_n = parse_int(ra.get("value"))
        if value_n is None:
            notes.add("size.reported_attendance", "no usable number, dropped")
            ra = None
        else:
            url = norm_url(ra.get("source_url")) if ra.get("source_url") else None
            ra = {"value": value_n, "year": parse_int(ra.get("year")), "source_url": url}
        s["reported_attendance"] = ra
    return s


def repair_links(value: Any, path: str, notes: Notes, keys: list[str]) -> dict:
    if not isinstance(value, dict):
        return {}
    out = {}
    for k in keys:
        if k not in value:
            continue
        raw = value[k]
        if raw is None or raw == "":
            out[k] = None
            continue
        u = norm_url(raw)
        if u is None:
            notes.add(f"{path}.{k}", f"{raw!r} is not a web address, dropped")
        elif u != raw:
            notes.add(f"{path}.{k}", f"address cleaned to {u}")
        out[k] = u
    return out


# ---------------------------------------------------------------- the whole record

def repair_edition(rec: dict, vocab: Vocab, today: date | None = None) -> tuple[dict, list[str]]:
    """Return (repaired copy, notes). The input is not changed."""
    notes = Notes()
    src = copy.deepcopy(rec)
    out: dict[str, Any] = {}

    if "name" in src:
        out["name"] = _clean_text(src["name"], "name", notes, SHORT_LIMIT * 2)
    if src.get("event_type") is not None:
        et = vocab.resolve_one("event_type", src["event_type"])
        if et is None:
            notes.add("event_type", f"{src['event_type']!r} is not an event type")
            out["event_type"] = src["event_type"]  # left as written so validation can reject it
        else:
            if et != src["event_type"]:
                notes.add("event_type", f"{src['event_type']!r} became {et}")
            out["event_type"] = et
    if src.get("status") is not None:
        st = vocab.resolve_one("status", src["status"])
        if st is None:
            notes.add("status", f"{src['status']!r} is not a status, dropped")
        else:
            if st != src["status"]:
                notes.add("status", f"{src['status']!r} became {st}")
            out["status"] = st
    if "days" in src:
        out["days"] = repair_days(src["days"], notes, today)
    if src.get("timezone"):
        out["timezone"] = str(src["timezone"]).strip()
    if "venue" in src:
        out["venue"] = repair_venue(src["venue"], notes)
    country = (out.get("venue") or {}).get("country")
    if "sells" in src:
        out["sells"] = repair_sells(src["sells"], vocab, notes)
        if src.get("mix") in ("tcg", "sports", "mixed", "unknown"):
            out["mix"] = src["mix"]
    elif src.get("mix") in ("tcg", "sports", "mixed", "unknown"):
        out["mix"] = src["mix"]
    if "admission" in src:
        out["admission"] = repair_admission(src["admission"], country, notes)
    if "size" in src:
        out["size"] = repair_size(src["size"], notes)
    if "vendor" in src:
        out["vendor"] = repair_vendor(src["vendor"], vocab, country, today, notes)
    if isinstance(src.get("organizer"), dict):
        org = {k: src["organizer"][k] for k in model.ORGANIZER_KEYS if k in src["organizer"]}
        if "name" in org:
            org["name"] = _clean_text(org["name"], "organizer.name", notes, SHORT_LIMIT * 2)
        if org.get("url"):
            org["url"] = repair_links({"url": org["url"]}, "organizer", notes, ["url"]).get("url")
        out["organizer"] = org
    if "links" in src:
        out["links"] = repair_links(src["links"], "links", notes, model.LINK_KEYS)
    if src.get("verification") is not None:
        ver = vocab.resolve_one("verification", src["verification"])
        if ver is None:
            notes.add("verification", f"{src['verification']!r} is not a verification level, dropped")
        else:
            out["verification"] = ver
    if "summary" in src:
        out["summary"] = _clean_text(src["summary"], "summary", notes)
    for k in ("first_seen", "last_checked"):
        if k in src:
            out[k] = _date_value(src[k], k, notes, today)
    if isinstance(src.get("sources"), list):
        cleaned = []
        for i, s in enumerate(src["sources"]):
            if not isinstance(s, dict) or not s.get("source"):
                continue
            entry = {"source": str(s["source"]), "url": norm_url(s.get("url")) if s.get("url") else None,
                     "retrieved": _date_value(s.get("retrieved"), f"sources[{i}].retrieved", notes, today),
                     "fields": [str(f) for f in (s.get("fields") or [])]}
            cleaned.append(entry)
        out["sources"] = cleaned
    # Fields that belong to the importers, kept as they are.
    for k, v in src.items():
        if k in ("estimate",) or k in out or k in model.SHOW_KEY_ORDER:
            continue
        out[k] = v
    return out, list(notes)


def promoter_id_for(name: str | None) -> str | None:
    return slugify(name) or None
