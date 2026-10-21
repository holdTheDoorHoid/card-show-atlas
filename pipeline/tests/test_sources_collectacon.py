"""Offline tests for the Collect-A-Con source.

tests/fixtures/collectacon/ holds real responses from 2026-10-21: the home page, the four show pages as
wp-json returns them, the shop's product list and the four vendor pages. Guest lists, images, emails and
phone numbers were taken out. The fake website below answers by address and query, the way the real one does.
"""

from __future__ import annotations

import json
from datetime import date

import httpx

from csa.sources import collectacon as cac
from conftest import FIXTURES
from source_helpers import Router, file_response, json_response, run

F = FIXTURES / "collectacon"
EMAIL = "info" + "@" + "collectaconusa.com"  # built here so no mailbox is written into a test file


def collect_site(*, products=None, pages=None, vendor=None, home=None, product_status=200):
    """The fake collectaconusa.com. Each argument replaces one answer so a test can change one thing."""
    def answer(request: httpx.Request) -> httpx.Response:
        path = request.url.path.rstrip("/") or "/"
        q = request.url.params
        if path == "/":
            return httpx.Response(200, text=home) if home is not None else file_response(F / "index.html")
        if path == "/wp-json/wp/v2/pages":
            slug = q["slug"]
            if pages is not None and slug in pages:
                return json_response(pages[slug]) if pages[slug] is not None else httpx.Response(500)
            return file_response(F / "pages" / f"{slug}.json", "application/json")
        if path == "/wp-json/wc/store/v1/products":
            if product_status != 200:
                return httpx.Response(product_status, text="no")
            items = products if products is not None else json.loads((F / "products.json").read_text())
            n = int(q.get("page", "1"))
            return json_response(items[(n - 1) * 100: n * 100])
        slug = path.lstrip("/")
        if (F / "vendor_pages" / f"{slug}.html").exists():
            if vendor is not None:
                return httpx.Response(200, text=vendor)
            return file_response(F / "vendor_pages" / f"{slug}.html")
        return httpx.Response(404, text="not found")
    return Router(answer)


def test_collectacon_reads_the_four_upcoming_shows(sroot):
    site = collect_site()
    res, rows = run(sroot, "collectacon", site)
    assert res.status == "ok" and res.skipped == 0 and res.records == 4
    assert [r["name"] for r in rows] == ["Collect-A-Con Dallas", "Collect-A-Con Houston", "Collect-A-Con New Jersey", "Collect-A-Con Los Angeles"]
    dallas, houston, nj, la = rows
    assert dallas["event_type"] == "convention" and dallas["verification"] == "organizer_confirmed"
    assert dallas["days"] == [{"date": "2026-10-24", "open": "10:00", "close": "18:00"},
                              {"date": "2026-10-25", "open": "10:00", "close": "17:00"}]
    assert dallas["venue"] == {"name": "Kay Bailey Hutchison Convention Center", "address": "650 S Griffin St", "city": "Dallas",
                               "region": "TX", "postal": "75202", "country": "US"}
    assert nj["venue"]["city"] == "Edison" and nj["venue"]["region"] == "NJ"  # the New Jersey show is held in Edison
    assert houston["days"][0]["date"] == "2026-11-07" and la["days"][0]["date"] == "2026-12-19"
    # "900+ Vendor Tables" and "1000+ Vendor Tables"
    assert dallas["size"]["tables"] == 900 and la["size"]["tables"] == 1000
    assert dallas["admission"] == {"child": 0, "notes": "Free for children 7 and under."}
    assert dallas["organizer"] == {"name": "Collect-A-Con", "url": "https://collectaconusa.com/"}
    assert dallas["links"]["official"] == "https://collectaconusa.com/dallas/"
    assert dallas["links"]["tickets"].startswith("https://www.universe.com/events/collect-a-con-dallas")
    assert dallas["vendor"]["application_url"] == "https://collectaconusa.com/dfw-vendors"
    # the card games the page lists, by vocabulary id; things that are not card games stay out of the TCG list
    assert {"pokemon", "yugioh", "mtg", "one_piece", "lorcana", "metazoo"} <= set(dallas["sells"]["tcg"])
    assert "Guest" not in json.dumps(rows) and "Soulja" not in json.dumps(rows)
    assert "robots.txt" in " ".join(site.paths())


def test_collectacon_table_prices_come_in_dollars_and_every_show_is_sold_out(sroot):
    _, rows = run(sroot, "collectacon", collect_site())
    dallas = rows[0]
    assert [(t["label"], t["price"], t["currency"]) for t in dallas["vendor"]["tables"]] == [
        ("2 Tables", 750, "USD"), ("3 Tables", 975, "USD"), ("5 Tables (Half Section)", 1975, "USD"),
        ("10 Tables (Full Section)", 3895, "USD")]
    nj = rows[2]
    assert [t["price"] for t in nj["vendor"]["tables"]] == [750, 1200, 2250, 4250]  # New Jersey is dearer than the rest
    assert all(r["vendor"]["status"] == "sold_out" for r in rows)


def test_collectacon_does_not_call_a_show_sold_out_on_stock_alone(sroot):
    """The shop also shows 'out of stock' before tables go on sale, so the vendor page has to say SOLD OUT too."""
    page = ("<html><body><main><article><h1>Dallas Vendors</h1><p>Reserve a Vendor Table: ON SALE DATE NOVEMBER 1</p>"
            "</article></main></body></html>")
    res, rows = run(sroot, "collectacon", collect_site(vendor=page))
    assert all(r["vendor"]["status"] == "unknown" for r in rows)
    assert any("does not say SOLD OUT" in n for n in res.notes)


def test_collectacon_open_when_a_table_product_is_in_stock(sroot):
    products = json.loads((F / "products.json").read_text())
    for p in products:
        if p["name"].startswith("Dallas") and "10 Tables" in p["name"] and "Zone" not in p["name"]:
            p["is_in_stock"] = True
    _, rows = run(sroot, "collectacon", collect_site(products=products))
    assert rows[0]["vendor"]["status"] == "open" and rows[1]["vendor"]["status"] == "sold_out"


def test_collectacon_keeps_the_shows_when_the_store_api_is_closed(sroot):
    res, rows = run(sroot, "collectacon", collect_site(product_status=403))
    assert res.status == "ok" and len(rows) == 4
    assert all(not r["vendor"].get("tables") and r["vendor"].get("status") in (None, "unknown") for r in rows)
    assert any("Store API could not be read" in n for n in res.notes)


def test_collectacon_skips_shows_that_are_over(sroot):
    res, rows = run(sroot, "collectacon", collect_site(), today=date(2026, 11, 10))
    assert [r["venue"]["city"] for r in rows] == ["Houston", "Edison", "Los Angeles"]  # Dallas ended on Oct 25
    res, rows = run(sroot, "collectacon", collect_site(), today=date(2026, 11, 20), refresh=True)
    assert [r["venue"]["city"] for r in rows] == ["Edison", "Los Angeles"]  # Houston ended on Nov 8, over a week before


def test_collectacon_shows_the_organizers_own_support_address_only():
    """parse_show_page keeps a mailbox only when it is on the organizer's own domain."""
    page = json.loads((F / "pages" / "dallas.json").read_text())[0]
    content = page["content"]["rendered"]
    own = cac.parse_show_page(content + f'<a href="mailto:{EMAIL}">{EMAIL}</a>', "Dallas", "https://collectaconusa.com/dallas/", None, print)
    other = cac.parse_show_page(content + '<a href="mailto:someone@gmail.example">someone@gmail.example</a>', "Dallas",
                                "https://collectaconusa.com/dallas/", None, print)
    assert own["vendor"]["contact"] == EMAIL
    assert "contact" not in other["vendor"]


def test_collectacon_product_rules():
    products = json.loads((F / "products.json").read_text())
    by_city = cac.parse_products([products])
    assert "dallas" in by_city and "houston" in by_city and "newjersey" in by_city
    # one product per table count, the newest wins, the 'Sports Card Zone' line and the shop's test product are not used
    assert [i["tables"] for i in by_city["dallas"]] == [2, 3, 5, 10]
    assert [i["tables"] for i in by_city["houston"]] == [2, 3, 5, 10]  # the old 1 and 4 table products have no year tag
    assert all(i["price"] > 0 for items in by_city.values() for i in items)
    assert not any("test" in i["label"].lower() or "zone" in i["label"].lower() for items in by_city.values() for i in items)
    assert cac.city_label("Los Angeles 2 2025") == "Los Angeles" and cac.city_label("Houston 2") == "Houston"
    assert cac.banner_dates("SHOW23-OCT-24-25-2026_DALLAS.png") == (date(2026, 10, 24), date(2026, 10, 25))
    assert cac.banner_dates("nothing.png") is None


def test_collectacon_uses_the_banner_date_when_the_start_element_is_gone(sroot):
    page = json.loads((F / "pages" / "dallas.json").read_text())
    page[0]["content"]["rendered"] = page[0]["content"]["rendered"].replace('id="eventstart"', 'id="soon"')
    res, rows = run(sroot, "collectacon", collect_site(pages={"dallas": page}))
    assert res.status == "ok" and rows[0]["days"][0]["date"] == "2026-10-24"
    assert any("banner file name" in n for n in res.notes)


def test_collectacon_skips_a_show_without_a_venue_block(sroot):
    page = json.loads((F / "pages" / "houston2.json").read_text())
    page[0]["content"]["rendered"] = page[0]["content"]["rendered"].replace(">Venue<", ">Where<")
    res, rows = run(sroot, "collectacon", collect_site(pages={"houston2": page}))
    assert res.status == "ok" and len(rows) == 3
    assert any("no venue block" in n for n in res.notes)


def test_collectacon_stops_when_the_home_page_loses_its_tour(sroot):
    run(sroot, "collectacon", collect_site())
    before = (sroot / "data/harvest/collectacon.jsonl").read_text()
    res, _ = run(sroot, "collectacon", collect_site(home="<html><body><div id='events'><p>Coming soon</p></div></body></html>"), refresh=True)
    assert res.status == "error" and "tour section" in res.message and "last good file" in res.message
    assert (sroot / "data/harvest/collectacon.jsonl").read_text() == before


def test_collectacon_stops_when_no_show_page_can_be_read(sroot):
    pages = {slug: [] for slug in ("dallas", "houston2", "new-jersey-2", "losangeles2")}
    res, rows = run(sroot, "collectacon", collect_site(pages=pages))
    assert res.status == "error" and "none of the 4 show pages" in res.message and not rows


def test_collectacon_stops_dead_when_the_shop_api_asks_for_a_bot_check(sroot):
    """A bot check on any request ends the run; it is not treated as 'the store API is just unavailable'."""
    inner = collect_site()

    def answer(request: httpx.Request) -> httpx.Response:
        if request.url.path.startswith("/wp-json/wc/"):
            return httpx.Response(403, text="<title>Just a moment...</title>", headers={"cf-mitigated": "challenge"})
        return inner.answer(request)
    site = Router(answer)
    res, rows = run(sroot, "collectacon", site)
    assert res.status == "blocked" and not rows
    assert not any(r.url.path.startswith("/wp-json/wp/") for r in site.requests)  # no show page was asked for afterwards
