from __future__ import annotations

import io
import json
import zipfile
from datetime import date

import pytest

from csa import build, postal, stats
from csa.check import ERROR
from csa.model import complete_show
from csa.paths import Paths
from csa.vocab import Vocab
from conftest import read_jsonl_file, write_jsonl_file
from test_check import good

TODAY = date(2026, 10, 21)


@pytest.fixture
def vocab(root):
    return Vocab.load(root / "data" / "vocab.json")


def show(sid, day, series=None, **over):
    s = good()
    s["id"] = f"{sid}-{day}"
    s["series_id"] = series or sid
    s["days"] = [{"date": day, "open": "09:00", "close": "15:00"}]
    s["vendor"].update(deadline=None, opens=None)
    s.update(over)
    return s


@pytest.fixture
def built_root(root, monkeypatch):
    monkeypatch.setenv("CSA_TODAY", "2026-10-21")   # makes the manifest's build time repeatable
    (root / "data" / "sources.yaml").write_text(
        "- {id: example_calendar, name: Example Calendar, url: 'https://calendar.example.org', kind: aggregator, method: script, credit: Listed by Example Calendar}\n"
        "- {id: research, name: Research, kind: community, method: research, credit: Found by research}\n"
        "- {id: unused, name: Unused, kind: aggregator, method: script, credit: nobody}\n")
    shows = [
        show("old-show", "2026-08-01"),                       # 81 days ago: outside the window
        show("recent-show", "2026-09-25"),                    # 26 days ago: inside
        show("soon-show", "2026-11-14"),
        show("far-show", "2028-10-20"),                       # just inside 24 months
        show("too-far-show", "2028-11-20"),                   # outside
    ]
    shows[2]["sources"].append({"source": "research", "url": "https://example.com/x", "retrieved": "2026-10-21", "fields": ["days"]})
    shows[3]["venue"].update(country="CA", region="ON", lat=43.65, lon=-79.38, city="Toronto")
    shows[3]["admission"]["currency"] = "CAD"
    shows[3]["vendor"]["tables"][0]["currency"] = "CAD"
    shows[3]["timezone"] = "America/Toronto"
    event = show("fnm", "2026-10-23", event_type="store_event", series="fnm")
    event["estimate"] = {"attendance": {"low": 1, "mid": 2, "high": 3}, "basis": "type_default", "confidence": "rough",
                         "size_class": "small", "traffic_per_table": None, "explain": "x"}
    series = [{"id": s["series_id"], "name": "x", "editions": [s["id"]], "history": []} for s in shows]
    series[2]["editions"] = [shows[2]["id"], "ghost-2020-01-01"]
    series[2]["editions"] = [shows[2]["id"]]
    promoters = [{"id": "example-promotions", "name": "Example Promotions", "series": [s["series_id"] for s in shows]}]
    write_jsonl_file(root / "data/shows.jsonl", shows)
    write_jsonl_file(root / "data/store_events.jsonl", [event])
    write_jsonl_file(root / "data/series.jsonl", series)
    write_jsonl_file(root / "data/promoters.jsonl", promoters)
    return root


def site(root, name):
    return json.loads((root / "site/public/data" / name).read_text())


def test_build_writes_exactly_the_documented_files(built_root, vocab):
    (built_root / "data/postal").mkdir()
    (built_root / "data/postal/US.json").write_text('{"08837":[40.519,-74.352]}\n')
    (built_root / "data/postal/CA.json").write_text('{"M5V":[43.641,-79.393]}\n')
    rep = build.run_build(Paths(built_root), vocab, TODAY)
    base = built_root / "site/public/data"
    files = sorted(str(p.relative_to(base)) for p in base.rglob("*") if p.is_file())
    assert files == ["manifest.json", "postal/CA.json", "postal/US.json", "promoters.json", "series.json", "shows.json",
                     "store_events.json", "vocab.json"]
    assert sorted(rep.written) == files and rep.warnings == []
    assert (base / "postal/US.json").read_text() == (built_root / "data/postal/US.json").read_text()
    assert [p.name for p in (built_root / "site").iterdir()] == ["public"]  # nothing else in site/ was touched


def test_missing_postal_files_are_a_warning_not_a_failure(built_root, vocab):
    rep = build.run_build(Paths(built_root), vocab, TODAY)
    assert len(rep.warnings) == 2 and "csa postal" in rep.warnings[0] and not (built_root / "site/public/data/postal").exists()


def test_shows_json_covers_30_days_back_to_24_months_ahead(built_root, vocab):
    build.run_build(Paths(built_root), vocab, TODAY)
    shows = site(built_root, "shows.json")
    assert [s["id"] for s in shows] == ["recent-show-2026-09-25", "soon-show-2026-11-14", "far-show-2028-10-20"]
    assert shows[1]["venue"]["lat"] == 40.5187 and shows[1]["sources"][0]["source"] == "example_calendar"


def test_series_and_promoters_only_point_at_things_in_the_window(built_root, vocab):
    build.run_build(Paths(built_root), vocab, TODAY)
    series = site(built_root, "series.json")
    assert sorted(s["id"] for s in series) == ["far-show", "recent-show", "soon-show"]
    promoters = site(built_root, "promoters.json")
    assert promoters[0]["series"] == ["recent-show", "soon-show", "far-show"] or sorted(promoters[0]["series"]) == ["far-show", "recent-show", "soon-show"]


def test_store_events_are_a_separate_file_of_full_records(built_root, vocab):
    build.run_build(Paths(built_root), vocab, TODAY)
    ev = site(built_root, "store_events.json")
    assert [e["id"] for e in ev] == ["fnm-2026-10-23"]
    stored = read_jsonl_file(built_root / "data/store_events.jsonl")[0]
    assert ev[0] == stored                       # the site makes its own compact index from full records
    assert all(s["event_type"] != "store_event" for s in site(built_root, "shows.json"))


def test_manifest_has_counts_and_credit_text_for_the_sources_used(built_root, vocab):
    build.run_build(Paths(built_root), vocab, TODAY)
    m = site(built_root, "manifest.json")
    assert m["built"] == "2026-10-21T00:00:00Z" and m["fixture"] is False
    assert m["window"] == {"from": "2026-09-21", "to": "2028-10-21"}
    assert m["counts"]["shows"] == 3 and m["counts"]["store_events"] == 1
    assert m["counts"]["by_type"] == {"card_show": 3} and m["counts"]["by_country"] == {"CA": 1, "US": 2}
    ids = [s["id"] for s in m["sources"]]
    assert ids == ["example_calendar", "research"] and "unused" not in ids
    assert m["sources"][0] == {"id": "example_calendar", "name": "Example Calendar", "url": "https://calendar.example.org",
                               "kind": "aggregator", "credit": "Listed by Example Calendar"}
    assert m["counts"]["by_source"] == {"example_calendar": 4, "research": 1}   # three shows and the store event; one show
    assert any("GeoNames" in c["name"] and c["license"] == "CC BY 4.0" for c in m["credits"])


def test_vocab_has_the_three_groups_the_site_reads(built_root, vocab):
    build.run_build(Paths(built_root), vocab, TODAY)
    v = site(built_root, "vocab.json")
    assert list(v) == ["tcg", "sports", "other"]
    assert {"id": "pokemon", "name": "Pokémon", "label": "Pokémon"} in v["tcg"]
    assert {"id": "multi_sport", "name": "Sports cards (several sports)", "label": "Sports"} in v["sports"]
    assert all(set(e) == {"id", "name", "label"} for g in v.values() for e in g)
    assert [e["id"] for e in v["tcg"]] == vocab.group_ids("tcg")


def test_built_data_never_looks_like_the_sites_sample_data(built_root, vocab):
    build.run_build(Paths(built_root), vocab, TODAY)
    text = " ".join((built_root / "site/public/data" / n).read_text() for n in ("shows.json", "store_events.json", "manifest.json"))
    assert '"fixture":true' not in text.replace(" ", "") and "Sample" not in text


def test_unchanged_files_are_not_rewritten(built_root, vocab):
    build.run_build(Paths(built_root), vocab, TODAY)
    p = built_root / "site/public/data/shows.json"
    before = p.stat().st_mtime_ns
    rep = build.run_build(Paths(built_root), vocab, TODAY)
    assert p.stat().st_mtime_ns == before and "shows.json" in rep.unchanged and rep.written == []


def test_errors_block_the_build_and_write_nothing(built_root, vocab):
    rows = read_jsonl_file(built_root / "data/shows.jsonl")
    rows[2]["venue"]["lat"], rows[2]["venue"]["lon"] = 34.05, -118.24  # not in New Jersey
    write_jsonl_file(built_root / "data/shows.jsonl", rows)
    with pytest.raises(build.BuildBlocked) as err:
        build.run_build(Paths(built_root), vocab, TODAY)
    assert any(f.severity == ERROR and "outside NJ" in f.message for f in err.value.report.findings)
    assert not (built_root / "site").exists()


def test_warnings_do_not_block_the_build(built_root, vocab):
    rows = read_jsonl_file(built_root / "data/shows.jsonl")
    rows[2]["timezone"] = None
    write_jsonl_file(built_root / "data/shows.jsonl", rows)
    rep = build.run_build(Paths(built_root), vocab, TODAY)
    assert rep.check.warnings and "check warnings" in "\n".join(rep.lines())


def test_an_empty_dataset_still_builds(root, vocab):
    (root / "data" / "sources.yaml").write_text("[]\n")
    rep = build.run_build(Paths(root), vocab, TODAY)
    assert site(root, "shows.json") == [] and rep.counts["shows"] == 0


# ---------------------------------------------------------------- postal

def make_zip(country, rows):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(f"{country}.txt", "\n".join("\t".join(r) for r in rows) + "\n")
        zf.writestr("readme.txt", "ignore me")
    return buf.getvalue()


US_ROWS = [
    ["US", "08837", "Edison", "New Jersey", "NJ", "Middlesex", "023", "", "", "40.5187", "-74.3518", "4"],
    ["US", "00501", "Holtsville", "New York", "NY", "Suffolk", "103", "", "", "40.8154", "-73.0451", "4"],
    ["US", "99999", "Nowhere", "", "", "", "", "", "", "", "", ""],          # no coordinates: skipped
]
CA_ROWS = [
    ["CA", "M5V", "Toronto", "Ontario", "ON", "", "", "", "", "43.6400", "-79.4000", "6"],
    ["CA", "M5V 2W6", "Toronto", "Ontario", "ON", "", "", "", "", "43.6420", "-79.3860", "6"],   # same first three characters
    ["CA", "H2X", "Montreal", "Quebec", "QC", "", "", "", "", "45.5088", "-73.5878", "6"],
]


def test_postal_files_are_compact_maps_with_three_decimals(root):
    zips = {"https://download.geonames.org/export/zip/US.zip": make_zip("US", US_ROWS),
            "https://download.geonames.org/export/zip/CA.zip": make_zip("CA", CA_ROWS)}
    rep = postal.run_postal(Paths(root), fetch=lambda url: zips[url])
    us = json.loads((root / "data/postal/US.json").read_text())
    ca = json.loads((root / "data/postal/CA.json").read_text())
    assert us == {"00501": [40.815, -73.045], "08837": [40.519, -74.352]}
    assert ca == {"H2X": [45.509, -73.588], "M5V": [43.641, -79.393]}   # M5V is averaged
    text = (root / "data/postal/US.json").read_text()
    assert not (root / "site").exists()          # the committed copy is under data/; build copies it into the site
    assert " " not in text.strip() and text.startswith('{"00501":[40.815,-73.045]')
    assert rep.counts == {"US": 2, "CA": 2} and "GeoNames" in rep.lines()[-1]


def test_postal_downloads_politely_and_uses_the_cache(root):
    from conftest import Site
    zips = {"/export/zip/US.zip": httpx_response(make_zip("US", US_ROWS)), "/export/zip/CA.zip": httpx_response(make_zip("CA", CA_ROWS))}
    site_ = Site(zips, robots="User-agent: *\nDisallow: /\n")  # GeoNames turns crawlers away; this is a named download
    postal.run_postal(Paths(root), transport=site_.transport(), sleep=lambda s: None)
    assert "/export/zip/US.zip" in site_.log and "/robots.txt" not in site_.log
    assert all("CardShowAtlas" in h["user-agent"] for h in site_.headers_seen)
    n = len(site_.log)
    postal.run_postal(Paths(root), transport=site_.transport(), sleep=lambda s: None)
    assert len(site_.log) == n  # second run came from the cache


def httpx_response(content):
    import httpx
    return httpx.Response(200, content=content, headers={"content-type": "application/zip"})


def test_postal_rejects_a_download_without_the_expected_file(root):
    with pytest.raises(ValueError, match="US.txt"):
        postal.run_postal(Paths(root), fetch=lambda url: make_zip("XX", US_ROWS))


# ---------------------------------------------------------------- stats

def test_stats_counts_and_gaps(built_root):
    shows = read_jsonl_file(built_root / "data/shows.jsonl")
    bare = show("bare", "2026-12-01")
    bare.update(vendor={**bare["vendor"], "tables": [], "application_url": None, "status": "unknown"}, size={"tables": None})
    bare["days"] = [{"date": "2026-12-01", "open": None, "close": None}]
    bare["venue"].update(lat=None, lon=None, geo_precision=None)
    bare["verification"] = "community"
    postal_only = show("coarse", "2026-12-02")
    postal_only["venue"]["geo_precision"] = "postal"
    write_jsonl_file(built_root / "data/shows.jsonl", shows + [bare, postal_only])
    s = stats.run_stats(Paths(built_root), TODAY)
    assert s["shows"] == 7 and s["store_events"] == 1
    assert s["upcoming"] == 5   # soon, far, too-far, bare, coarse
    assert s["by_type"] == {"card_show": 7, "store_event": 1}
    assert s["by_country"] == {"US": 7, "CA": 1}
    assert s["by_verification"]["community"] == 1 and s["by_verification"]["listed"] == 7
    assert s["by_source"] == {"example_calendar": 8, "research": 1}
    m = s["upcoming_missing"]
    assert m == {"coordinates": 1, "hours": 1, "vendor_info": 1, "size_signal": 1, "coarse_location": 1}
    text = "\n".join(stats.render(s))
    assert "5 upcoming" in text and "opening hours" in text and "vendor information" in text and "By source" in text


def test_stats_on_empty_data(root):
    s = stats.run_stats(Paths(root), TODAY)
    assert s["shows"] == 0 and s["upcoming_missing"]["coordinates"] == 0
    assert "0 shows" in "\n".join(stats.render(s))
