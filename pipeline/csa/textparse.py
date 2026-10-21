"""Turn the messy ways people write dates, times, money, addresses and links into clean values."""

from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from .regions import country_code, region_code
from .util import norm_text

MONTHS = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3, "apr": 4, "april": 4,
    "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7, "aug": 8, "august": 8, "sep": 9, "sept": 9,
    "september": 9, "oct": 10, "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
}
_MON = r"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
WEEKDAYS = {"mon": 0, "monday": 0, "tue": 1, "tues": 1, "tuesday": 1, "wed": 2, "weds": 2, "wednesday": 2,
            "thu": 3, "thur": 3, "thurs": 3, "thursday": 3, "fri": 4, "friday": 4, "sat": 4 + 1, "saturday": 5,
            "sun": 6, "sunday": 6}
WEEKDAY_CODES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
ORDINALS = {"first": 1, "1st": 1, "1": 1, "second": 2, "2nd": 2, "2": 2, "third": 3, "3rd": 3, "3": 3,
            "fourth": 4, "4th": 4, "4": 4, "last": -1, "-1": -1, "final": -1}


def weekday_code(value: Any) -> str | None:
    if value is None:
        return None
    n = WEEKDAYS.get(norm_text(str(value)))
    if n is None and isinstance(value, int) and 0 <= value <= 6:
        n = value
    return WEEKDAY_CODES[n] if n is not None else None


def nth_value(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value in (1, 2, 3, 4, -1) else None
    return ORDINALS.get(norm_text(str(value)).replace(" ", "")) or ORDINALS.get(str(value).strip().lower())


# ---------------------------------------------------------------- dates

_ISO = re.compile(r"(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)")
_SLASH_YMD = re.compile(r"(?<!\d)(\d{4})/(\d{1,2})/(\d{1,2})(?!\d)")
_NUM = re.compile(r"(?<![\d/])(\d{1,2})[/-](\d{1,2})(?:[/-](\d{4}|\d{2}))?(?![\d/])")
_MDY = re.compile(
    _MON + r"\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?!\d)"
    r"(?:\s*(-|to|through|thru|&|and)\s*(?:" + _MON + r"\.?\s+)?(\d{1,2})(?:st|nd|rd|th)?(?!\d))?"
    r"(?:,?\s*(\d{4})(?!\d))?", re.I)
_DMY = re.compile(r"(?<!\d)(\d{1,2})(?:st|nd|rd|th)?\s+" + _MON + r"\.?(?:,?\s*(\d{4})(?!\d))?", re.I)


def _mk(y: int, m: int, d: int) -> date | None:
    try:
        return date(y, m, d)
    except ValueError:
        return None


def _infer_year(m: int, d: int, today: date | None) -> date | None:
    if today is None:
        return None
    cand = _mk(today.year, m, d)
    if cand is None:
        return None
    if cand < today - timedelta(days=45):
        cand = _mk(today.year + 1, m, d)
    return cand


def find_dates(text: str, today: date | None = None, default_year: int | None = None) -> list[date]:
    """Every calendar date in free text, in the order written. Ranges like 'Nov 14-15, 2026' give each day.

    A date written without a year takes default_year, or else the next such date counting from today.
    Dates that cannot be placed in a year are skipped.
    """
    if not text:
        return []
    found: list[tuple[int, date]] = []
    taken: list[tuple[int, int]] = []

    def free(span):
        return all(span[1] <= a or span[0] >= b for a, b in taken)

    def add(span, dates):
        taken.append(span)
        for d in dates:
            if d:
                found.append((span[0], d))

    def year_or_infer(y, m, d):
        if y:
            return _mk(int(y), m, d)
        if default_year:
            return _mk(default_year, m, d)
        return _infer_year(m, d, today)

    for rx in (_ISO, _SLASH_YMD):
        for mt in rx.finditer(text):
            if free(mt.span()):
                add(mt.span(), [_mk(int(mt.group(1)), int(mt.group(2)), int(mt.group(3)))])
    for mt in _MDY.finditer(text):
        if not free(mt.span()):
            continue
        m1 = MONTHS[mt.group(1).lower()]
        d1 = int(mt.group(2))
        joiner, m2raw, d2raw, y = mt.group(3), mt.group(4), mt.group(5), mt.group(6)
        dates = [year_or_infer(y, m1, d1)]
        if joiner and d2raw:
            m2 = MONTHS[m2raw.lower()] if m2raw else m1
            d2 = int(d2raw)
            end = year_or_infer(y, m2, d2)
            if joiner.lower() in ("-", "to", "through", "thru") and dates[0] and end and 0 < (end - dates[0]).days <= 14:
                dates = [dates[0] + timedelta(days=i) for i in range((end - dates[0]).days + 1)]
            elif end:
                dates.append(end)
        add(mt.span(), dates)
    for mt in _DMY.finditer(text):
        if free(mt.span()):
            add(mt.span(), [year_or_infer(mt.group(3), MONTHS[mt.group(2).lower()], int(mt.group(1)))])
    for mt in _NUM.finditer(text):
        if not free(mt.span()):
            continue
        a, b, y = int(mt.group(1)), int(mt.group(2)), mt.group(3)
        month, day = (a, b) if a <= 12 else (b, a)  # month first unless the first number cannot be a month
        if month > 12:
            continue
        yy = None if y is None else (int(y) + 2000 if len(y) == 2 else int(y))
        add(mt.span(), [year_or_infer(yy, month, day)])
    found.sort(key=lambda t: t[0])
    seen, out = set(), []
    for _, d in found:
        if d not in seen:
            seen.add(d)
            out.append(d)
    return out


def parse_date_text(text: Any, today: date | None = None, default_year: int | None = None) -> date | None:
    """One date from text, or None when there is none or the text holds several."""
    if text is None:
        return None
    if isinstance(text, date):
        return text
    got = find_dates(str(text), today, default_year)
    return got[0] if len(got) == 1 else None


# ---------------------------------------------------------------- times

_TIME = re.compile(r"(?<![\d:])(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*([ap])\.?m?\.?(?![a-z])|(?<![\d:])(\d{1,2}):(\d{2})(?::\d{2})?(?![\d:])|\b(noon|midday|midnight)\b", re.I)


def _to_24(h: int, mnt: int, ampm: str | None) -> str | None:
    if ampm:
        if not 1 <= h <= 12:
            return None
        h = h % 12 + (12 if ampm.lower() == "p" else 0)
    if not (0 <= h <= 23 and 0 <= mnt <= 59):
        return None
    return f"{h:02d}:{mnt:02d}"


def find_times(text: str) -> list[str]:
    out = []
    for mt in _TIME.finditer(text or ""):
        if mt.group(6):
            out.append("12:00" if mt.group(6).lower() in ("noon", "midday") else "00:00")
        elif mt.group(1):
            t = _to_24(int(mt.group(1)), int(mt.group(2) or 0), mt.group(3))
            if t:
                out.append(t)
        else:
            t = _to_24(int(mt.group(4)), int(mt.group(5)), None)
            if t:
                out.append(t)
    return out


def parse_time_text(text: Any) -> str | None:
    if text is None:
        return None
    s = str(text).strip()
    if re.fullmatch(r"\d{4}", s):  # 0900, 1500
        return _to_24(int(s[:2]), int(s[2:]), None)
    got = find_times(s)
    return got[0] if len(got) == 1 else None


def parse_time_range(text: str) -> tuple[str | None, str | None]:
    """'9am to 3pm', '10-4', '9:00 - 15:00'. A close that looks earlier than the open is read as afternoon."""
    if not text:
        return None, None
    times = find_times(text)
    if len(times) == 2:
        return times[0], times[1]
    mt = re.search(r"(?<![\d:])(\d{1,2})(?::(\d{2}))?\s*(?:-|to|until|till)\s*(\d{1,2})(?::(\d{2}))?(?![\d:])", text, re.I)
    if mt:
        h1, m1, h2, m2 = int(mt.group(1)), int(mt.group(2) or 0), int(mt.group(3)), int(mt.group(4) or 0)
        if h2 < h1 and h2 <= 12:
            h2 += 12
        if h1 < 7 and h2 <= 12:  # '1-5' means afternoon
            h1, h2 = h1 + 12, h2 + 12 if h2 < 12 else h2
        a, b = _to_24(h1, m1, None), _to_24(h2, m2, None)
        return a, b
    return None, None


# ---------------------------------------------------------------- numbers and money

def parse_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value) if value == int(value) else None
    mt = re.search(r"(\d[\d,]*)", str(value))
    if not mt:
        return None
    try:
        return int(mt.group(1).replace(",", ""))
    except ValueError:
        return None


def norm_currency(text: Any) -> str | None:
    if text is None:
        return None
    s = str(text).strip().lower().replace(".", "")
    if s in ("usd", "us", "us$", "usd$", "us dollar", "us dollars"):
        return "USD"
    if s in ("cad", "ca", "c$", "ca$", "can$", "cdn", "cad$", "canadian", "canadian dollar", "canadian dollars"):
        return "CAD"
    return None


def parse_money(value: Any) -> tuple[int | float | None, str | None]:
    """(amount, currency or None). 'Free' is zero. '$1,200' is 1200."""
    if value is None or isinstance(value, bool):
        return None, None
    if isinstance(value, (int, float)):
        return (int(value) if value == int(value) else round(float(value), 2)), None
    s = str(value).strip()
    if not s:
        return None, None
    cur = None
    if re.search(r"\bcad\b|c\$|ca\$|can\$|canadian", s, re.I):
        cur = "CAD"
    elif re.search(r"\busd\b|us\$|\bu\.s\.", s, re.I):
        cur = "USD"
    mt = re.search(r"(\d[\d,]*(?:\.\d+)?)", s)
    if not mt:
        return (0, cur) if re.search(r"\bfree\b|\bno charge\b", s, re.I) else (None, cur)
    num = float(mt.group(1).replace(",", ""))
    return (int(num) if num == int(num) else round(num, 2)), cur


def parse_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if value is None:
        return None
    s = str(value).strip().lower()
    if s in ("true", "yes", "y", "free", "1"):
        return True
    if s in ("false", "no", "n", "0", "paid"):
        return False
    return None


# ---------------------------------------------------------------- phones, links

_LABEL = r"\b(?:call|text|phone|tel|cell|mobile)(?:\s+(?:us|me))?\s*(?:at|on)?\s*[:\-]?\s*"
PHONE_RX = re.compile(
    r"(?:" + _LABEL + r")?(?<![\w.])(?:tel:)?(?:"
    r"\(\d{3}\)\s*\d{3}[\s.\-]?\d{4}"               # (215) 555-1234
    r"|\d{3}[.\-]\d{3}[.\-]\d{4}"                      # 215-555-1234, 215.555.1234
    r"|\+?1[\s.\-]\d{3}[\s.\-]\d{3}[\s.\-]\d{4}"      # 1 215 555 1234
    r")(?!\d)"
    r"|" + _LABEL + r"\d{3}\s\d{3}\s\d{4}(?!\d)",       # call 215 555 1234
    re.I)
EMAIL_RX = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")


def scrub_phones(text: str) -> tuple[str, bool]:
    """Remove phone numbers. Returns the cleaned text and whether anything was removed."""
    cleaned, n = PHONE_RX.subn("", text)
    if not n:
        return text, False
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip(" ,;:-")
    cleaned = re.sub(r"^(?:or|and)\s+|\s+(?:or|and)$", "", cleaned, flags=re.I)
    return cleaned, True


_TRACKING = ("utm_", "fbclid", "gclid", "mc_cid", "mc_eid", "igshid")


def norm_url(text: Any) -> str | None:
    """A clean http(s) address, or None when the text is not usable as one."""
    if not isinstance(text, str):
        return None
    s = text.strip().strip("<>").rstrip(".,;)")
    if not s or " " in s:
        return None
    if s.startswith("//"):
        s = "https:" + s
    if not re.match(r"^[a-z][a-z0-9+.\-]*://", s, re.I):
        if re.match(r"^(www\.)?[\w\-]+(\.[\w\-]+)+(/|$|\?)", s):
            s = "https://" + s
        else:
            return None
    parts = urlsplit(s)
    if parts.scheme.lower() not in ("http", "https") or "." not in parts.netloc or len(parts.netloc) < 4:
        return None
    query = urlencode([(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
                       if not k.lower().startswith(_TRACKING)])
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path, query, parts.fragment))


def host_of(url: str | None) -> str:
    if not url:
        return ""
    host = urlsplit(url).netloc.lower().split("@")[-1].split(":")[0]
    return host[4:] if host.startswith("www.") else host


def same_site(a: str | None, b: str | None) -> bool:
    ha, hb = host_of(a), host_of(b)
    return bool(ha and hb and (ha == hb or ha.endswith("." + hb) or hb.endswith("." + ha)))


# ---------------------------------------------------------------- addresses

_US_POSTAL = re.compile(r"(?<!\d)(\d{5})(?:-(\d{4}))?(?!\d)")
_CA_POSTAL = re.compile(r"(?<![A-Za-z0-9])([ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z])[ -]?(\d[ABCEGHJ-NPRSTV-Z]\d)(?![A-Za-z0-9])", re.I)


def norm_postal(value: Any) -> str | None:
    if value is None:
        return None
    s = str(value).strip().upper()
    mt = _CA_POSTAL.fullmatch(s)
    if mt:
        return f"{mt.group(1)} {mt.group(2)}"
    mt = _US_POSTAL.fullmatch(s)
    if mt:
        return mt.group(1) + (f"-{mt.group(2)}" if mt.group(2) else "")
    if re.fullmatch(r"\d{4}", s):  # a ZIP that lost its leading zero
        return "0" + s
    return s or None


def parse_address_text(text: str) -> dict:
    """Best effort split of 'Venue, 12 Main St, Town, ST 12345' into venue fields. Missing parts are left out."""
    out: dict[str, Any] = {}
    if not text:
        return out
    flat = re.sub(r"\s+", " ", text.replace("\n", ", ")).strip(" ,")
    ca = _CA_POSTAL.search(flat)
    us = _US_POSTAL.search(flat)
    work = flat
    if ca:
        out["postal"] = f"{ca.group(1).upper()} {ca.group(2).upper()}"
        work = (flat[:ca.start()] + flat[ca.end():]).strip(" ,")
        out["country"] = "CA"
    elif us:
        out["postal"] = us.group(1) + (f"-{us.group(2)}" if us.group(2) else "")
        work = (flat[:us.start()] + flat[us.end():]).strip(" ,")
    parts = [p.strip() for p in work.split(",") if p.strip()]
    # region: the last part that is, or ends with, a state or province
    region = None
    for i in range(len(parts) - 1, -1, -1):
        tokens = parts[i].split()
        for take in (3, 2, 1):
            if len(tokens) >= take:
                code = region_code(" ".join(tokens[-take:]))
                if code:
                    region = code
                    rest = " ".join(tokens[:-take])
                    parts[i] = rest
                    break
        if region:
            break
    parts = [p for p in parts if p and country_code(p) is None]
    if region:
        out["region"] = region
        out.setdefault("country", "CA" if region in ("AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT") else "US")
    if parts:
        # city: the part just before the region; address: the part that starts with a number
        street = next((p for p in parts if re.match(r"^\d+\b", p)), None)
        if street:
            out["address"] = street
            idx = parts.index(street)
            before, after = parts[:idx], parts[idx + 1:]
            if after:
                out["city"] = after[-1]
                if len(after) > 1:
                    pass
            elif region and before:
                pass
            if before:
                out["name"] = before[0]
        else:
            if len(parts) >= 2:
                out["name"] = parts[0]
                out["city"] = parts[-1]
            else:
                out["city"] = parts[0]
        if "city" not in out and region and street and len(parts) >= 2:
            out["city"] = parts[-1] if parts[-1] != street else None
            if out["city"] is None:
                del out["city"]
    return out
