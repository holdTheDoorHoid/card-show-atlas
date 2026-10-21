"""Collect-A-Con tour dates, venues, vendor table prices and sold out flags, from collectaconusa.com.

Terms and robots checked 2026-10-21: robots.txt only turns away /wp-admin/ (and allows its ajax file),
and the owner of this project confirmed the WordPress REST API (wp-json) may be used. The site is the
organizer's own, so these records count as confirmed by the organizer. Facts only: dates, hours, venue,
table counts and prices, the organizer's own support email. Guest lists, photos and prose are not kept.

How it works:
  1. The home page lists the tour: one link per show (/dallas/, /houston2/, ...). Past shows are
     recognised from the date in the show banner's file name (SHOW23-OCT-24-25-2026_DALLAS.png) and skipped.
  2. Each show page comes from wp-json/wp/v2/pages?slug=... It holds the start date (a hidden countdown
     element), the opening hours per day, the "900+ Vendor Tables" figure, the venue and its street address,
     the ticket link, the vendor page link and the "Featuring" list.
  3. Table prices come from the shop's public Store API (wp-json/wc/store/v1/products), whose prices are
     in cents. Products are matched to a show by the city in the product name ("Dallas - 5 Tables (Half
     Section)"). When every table product for the show is out of stock the vendor page is read, and if it
     says SOLD OUT the show is marked sold out. Stock alone is not trusted: the shop also shows "out of
     stock" before tables go on sale.

If the home page has no tour links, or no show page can be read, the run stops with a message. If only the
Store API fails, the shows are kept without prices and a note says so.
"""

from __future__ import annotations

import html as htmllib
import re
from datetime import date, timedelta
from typing import Iterable
from urllib.parse import urljoin

from ..http import BotChallenge, FetchError
from ..regions import country_of_region, region_code
from ..textparse import find_dates, parse_int, parse_time_range
from ..util import norm_text
from ._common import LayoutChanged, clean, strip_comments, text_lines

HOME = "https://collectaconusa.com/"
PAGE_API = "https://collectaconusa.com/wp-json/wp/v2/pages"
PRODUCT_API = "https://collectaconusa.com/wp-json/wc/store/v1/products"
SITE_HOST = "collectaconusa.com"
TOUR_LINK = re.compile(r'<a\s+href="/?([a-z0-9\-]+)/?"[^>]*>\s*<img[^>]*?alt="([^"]*)"[^>]*?src\s*=\s*"([^"]*SHOW\d+[^"]*)"', re.S)
BANNER_DATE = re.compile(r"SHOW\d+-([A-Z]{3})-(\d{1,2})(?:-(\d{1,2}))?-(\d{4})", re.I)
WEEKDAY = re.compile(r"^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s*:\s*(.+)$", re.I)
VENUE_ADDRESS = re.compile(r"^(?P<street>.+?),\s*(?P<city>[^,]+),\s*(?P<region>[A-Z]{2})\s+(?P<postal>\d{5}(?:-\d{4})?)$")
TABLE_COUNT = re.compile(r"(\d+)\s+Tables?\b", re.I)
MAX_PRODUCT_PAGES = 6


def banner_dates(src: str) -> tuple[date, date] | None:
    """The first and last day written in a show banner file name, or None."""
    m = BANNER_DATE.search(src or "")
    if not m:
        return None
    mon, d1, d2, year = m.group(1), int(m.group(2)), int(m.group(3) or m.group(2)), int(m.group(4))
    found = find_dates(f"{mon} {d1}, {year}")
    if not found:
        return None
    start = found[0]
    return start, start + timedelta(days=max(d2 - d1, 0))


def tour_links(home_html: str) -> list[dict]:
    """(slug, label, banner dates) for each show linked from the home page's tour section."""
    html = strip_comments(home_html)
    start = html.find('id="events"')
    html = html[start:] if start >= 0 else html
    seen, out = set(), []
    for slug, alt, src in TOUR_LINK.findall(html):
        if slug in seen:
            continue
        seen.add(slug)
        out.append({"slug": slug, "alt": htmllib.unescape(alt), "banner": banner_dates(src)})
    return out


def city_label(title: str) -> str:
    """'Los Angeles 2 2025' becomes 'Los Angeles': the year and the 'second show of the year' number go."""
    t = htmllib.unescape(re.sub(r"<[^>]+>", "", title or "")).strip()
    t = re.sub(r"\s+20\d\d$", "", t)
    t = re.sub(r"\s+\d$", "", t)
    return t.strip()


def parse_show_page(content: str, title: str, link: str, banner: tuple[date, date] | None, note) -> dict | None:
    html = strip_comments(content)
    start = None
    m = re.search(r'id="eventstart"[^>]*>\s*([^<]+?)\s*<', html)
    if m:
        found = find_dates(m.group(1))
        start = found[0] if found else None
    if start is None and banner:
        start = banner[0]
        note(f"{link}: no start date element, used the date in the banner file name")
    if start is None:
        note(f"{link}: no start date, skipped")
        return None

    # hours: 'Saturday: 10am - 6pm' lines in the heading under the banner
    hours = re.search(r'class="[^"]*city-datetime[^"]*">(.*?)</h3>', html, re.S)
    lines = text_lines(hours.group(1)) if hours else []
    days = []
    for i, line in enumerate(lines):
        mm = WEEKDAY.match(line)
        if not mm:
            continue
        d = start + timedelta(days=len(days))
        if d.strftime("%A").lower() != mm.group(1).lower():
            note(f"{link}: the hours list {mm.group(1)} but day {len(days) + 1} is a {d.strftime('%A')}; hours ignored")
            days = []
            break
        o, c = parse_time_range(mm.group(2))
        days.append({"date": d.isoformat(), "open": o, "close": c})
    if not days:
        n = (banner[1] - banner[0]).days + 1 if banner and banner[0] == start else 1
        days = [{"date": (start + timedelta(days=i)).isoformat(), "open": None, "close": None} for i in range(n)]

    # venue: the paragraph under the 'Venue' heading: name, hall, street address (a link)
    venue = None
    vm = re.search(r">\s*Venue\s*</h3>(.*?)</p>", html, re.S)
    if vm:
        p = re.search(r"<p[^>]*>(.*)$", vm.group(1), re.S)
        vlines = text_lines(p.group(1) + "</p>") if p else []
        addr = next((VENUE_ADDRESS.match(x) for x in reversed(vlines) if VENUE_ADDRESS.match(x)), None)
        if addr and vlines:
            region = region_code(addr.group("region"))
            if region:
                venue = {"name": vlines[0], "address": addr.group("street"), "city": addr.group("city"),
                         "region": region, "postal": addr.group("postal"), "country": country_of_region(region)}
    if venue is None:
        note(f"{link}: no venue block with a street address, skipped")
        return None

    tables = None
    tm = re.search(r"(\d[\d,]*)\+?\s*Vendor Tables", html)
    if tm:
        tables = parse_int(tm.group(1))

    featuring = re.search(r'id="featuring"[^>]*>(.*?)</ul>', html, re.S)
    sells = [clean(li) for li in re.findall(r"<li>(.*?)</li>", featuring.group(1), re.S)] if featuring else []
    sells = [s for s in sells if "vendor table" not in s.lower()]

    tickets = next((h for h in re.findall(r'href="(https://www\.universe\.com/[^"]+)"', html)), None)
    vendor_href = re.search(r'<a[^>]*href="([^"]+)"[^>]*>\s*(?:Reserve a Table|Vendor\s*/\s*Exhibitor Info)', html)
    vendor_url = urljoin(HOME, vendor_href.group(1)) if vendor_href else None
    email = next((e for e in re.findall(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}", html) if e.lower().endswith("@" + SITE_HOST)), None)

    free = re.search(r"FREE Admission for (?:Children|Kids)\s+(\d+)\s+and under", clean(html), re.I)
    label = city_label(title)
    rec: dict = {
        "name": f"Collect-A-Con {label}",
        "event_type": "convention",
        "days": days,
        "venue": venue,
        "sells": {"tcg": [], "sports": [], "other": []},
        "organizer": {"name": "Collect-A-Con", "url": HOME},
        "links": {"official": link, "tickets": tickets},
        "vendor": {"application_url": vendor_url},
        "source_url": link,
        "_sells_text": sells,
        "_city_key": norm_text(label).replace(" ", ""),
    }
    if tables:
        rec["size"] = {"tables": tables}
    if free:
        rec["admission"] = {"child": 0, "notes": f"Free for children {free.group(1)} and under."}
    if email:
        rec["vendor"]["contact"] = email
    return rec


def parse_products(pages: list[list[dict]]) -> dict[str, list[dict]]:
    """Current table products by city key: [{'label', 'price', 'in_stock'}], one per table count, newest product wins.

    Products for a 'Sports Card Zone' or 'Sports Zone' section, products without a year tag and the shop's
    test product are ignored: they are older lines the show pages no longer sell."""
    best: dict[tuple[str, int], dict] = {}
    for page in pages:
        for p in page:
            name = htmllib.unescape(p.get("name") or "")
            sku = p.get("sku") or ""
            if "-TABL-" not in sku.upper() and not TABLE_COUNT.search(name):
                continue
            parts = [x.strip() for x in re.split(r"\s[–—-]\s", name)]
            if len(parts) < 2 or any("zone" in x.lower() for x in parts) or "test" in name.lower():
                continue
            if not any(re.fullmatch(r"20\d\d", (c.get("name") or "")) for c in p.get("categories") or []):
                continue
            m = TABLE_COUNT.search(parts[-1])
            if not m:
                continue
            prices = p.get("prices") or {}
            try:
                cents = int(prices.get("price"))
            except (TypeError, ValueError):
                continue
            minor = int(prices.get("currency_minor_unit", 2))
            price = cents / (10 ** minor)
            key = (norm_text(parts[0]).replace(" ", ""), int(m.group(1)))
            if key not in best or p["id"] > best[key]["id"]:
                best[key] = {"id": p["id"], "label": parts[-1], "price": int(price) if price == int(price) else price,
                             "currency": prices.get("currency_code") or "USD", "in_stock": bool(p.get("is_in_stock")),
                             "tables": int(m.group(1))}
    out: dict[str, list[dict]] = {}
    for (city, _), item in best.items():
        out.setdefault(city, []).append(item)
    for items in out.values():
        items.sort(key=lambda i: i["tables"])
    return out


def harvest(ctx) -> Iterable[dict]:
    home = ctx.http.get(HOME).text
    tour = tour_links(home)
    if not tour:
        raise LayoutChanged("collectacon", HOME, "a tour section (id=events) with a link and a show banner for each show", "no show links")
    upcoming = [t for t in tour if not (t["banner"] and t["banner"][1] < ctx.today - timedelta(days=7))]

    products: dict[str, list[dict]] = {}
    try:
        pages = []
        for n in range(1, MAX_PRODUCT_PAGES + 1):
            batch = ctx.http.get(PRODUCT_API, params={"per_page": 100, "page": n}).json()
            pages.append(batch)
            if len(batch) < 100:
                break
        products = parse_products(pages)
        if not products:
            ctx.log("the shop's Store API answered but lists no table products; shows are kept without prices")
    except BotChallenge:
        raise
    except (FetchError, ValueError) as exc:
        ctx.log(f"the shop's Store API could not be read ({exc}); shows are kept without prices")

    read = 0
    for t in upcoming:
        try:
            batch = ctx.http.get(PAGE_API, params={"slug": t["slug"], "_fields": "id,slug,link,title,content"}).json()
        except BotChallenge:
            raise
        except (FetchError, ValueError) as exc:
            ctx.log(f"{t['slug']}: the page could not be read ({exc}), skipped")
            continue
        if not batch:
            ctx.log(f"{t['slug']}: no such page in wp-json, skipped")
            continue
        page = batch[0]
        rec = parse_show_page(page["content"]["rendered"], page["title"]["rendered"], page["link"], t["banner"], ctx.log)
        if rec is None:
            continue
        read += 1
        if date.fromisoformat(rec["days"][-1]["date"]) < ctx.today - timedelta(days=7):
            continue  # already over
        rec["sells"] = rec.pop("_sells_text")
        key = rec.pop("_city_key")
        items = products.get(key) or []
        if items:
            rec["vendor"]["tables"] = [{"label": i["label"], "price": i["price"], "currency": i["currency"]} for i in items]
            if any(i["in_stock"] for i in items):
                rec["vendor"]["status"] = "open"
            else:
                rec["vendor"]["status"] = _closed_status(ctx, rec["vendor"].get("application_url"))
        yield rec
    if read == 0:
        raise LayoutChanged("collectacon", HOME, "show pages in wp-json with a start date, hours and a Venue block",
                            f"none of the {len(upcoming)} show pages could be read")


def _closed_status(ctx, vendor_url: str | None) -> str:
    """Every table product is out of stock: sold out if the vendor page says so, otherwise unknown."""
    if not vendor_url:
        return "sold_out"
    try:
        text = clean(strip_comments(ctx.http.get(vendor_url).text))
    except BotChallenge:
        raise
    except FetchError as exc:
        ctx.log(f"{vendor_url}: could not be read ({exc}); went by the shop's stock alone")
        return "sold_out"
    if re.search(r"sold\s*out", text, re.I):
        return "sold_out"
    ctx.log(f"{vendor_url}: all table products are out of stock but the page does not say SOLD OUT; status left unknown")
    return "unknown"
