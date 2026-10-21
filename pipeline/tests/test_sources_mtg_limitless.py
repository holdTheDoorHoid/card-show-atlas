"""Offline tests for mtg_premier and limitless_results, and for how their records line up with the others in a merge.

The saved pages are real responses from 2026-10-21. For the wiki pages everything that names a player
was taken out of the fixtures; the limitless pages have no winner column.
"""

from __future__ import annotations

import json
from datetime import date

import httpx

from csa import estimate, merge
from csa.paths import Paths
from csa.sources import limitless_results as lim
from csa.sources import mtg_premier as mtg
from csa.vocab import Vocab
from conftest import FIXTURES, read_jsonl_file
from source_helpers import TODAY, Router, file_response, fixture_site, replace_in, run

WIKI = "https://mtg.wiki/page/"

# ---------------------------------------------------------------- MTG Wiki


def test_mtg_premier_reads_regionals_pro_tours_and_magiccons(sroot):
    site = fixture_site("mtg_premier")
    res, rows = run(sroot, "mtg_premier", site)
    assert res.status == "ok" and res.skipped == 0
    names = {r["name"]: r for r in rows}
    # a Regional Championship that has been held carries its attendance, the year and the page it came from
    baltimore = names["Magic Regional Championship Baltimore"]
    assert baltimore["venue"] == {"city": "Baltimore", "region": "MD", "country": "US"}
    assert [d["date"] for d in baltimore["days"]] == ["2026-09-11", "2026-09-12", "2026-09-13"]
    assert baltimore["size"]["reported_attendance"] == {
        "value": 1486, "year": 2026, "source_url": WIKI + "2026%E2%80%9327_Premier_Play_Season"}
    assert names["Magic Regional Championship Ottawa"]["size"]["reported_attendance"]["value"] == 450
    assert names["Magic Regional Championship Ottawa"]["venue"]["country"] == "CA"
    # one that is still to come has none
    assert "size" not in names["Magic Regional Championship St. Louis"]
    assert names["Magic Regional Championship Vancouver"]["venue"]["region"] == "BC"
    # Pro Tours at a MagicCon, the Limited Championship and last season's World Championship
    denver = names["MagicCon Denver: Pro Tour Nauctis"]
    assert [d["date"] for d in denver["days"]] == ["2027-02-26", "2027-02-27", "2027-02-28"] and denver["venue"]["region"] == "CO"
    assert names["MagicCon Las Vegas: Magic Pro Tour"]["days"][0]["date"] == "2027-08-27"
    assert names["Magic Limited Championship"]["venue"] == {"city": "Minneapolis", "region": "MN", "country": "US"}
    assert names["MagicCon Atlanta: Magic World Championship"]["days"][0]["date"] == "2026-11-13"
    # a Pro Tour that is over and has no attendance figure says nothing about size, so it is not kept
    assert not any("Strixhaven" in k for k in names)
    # Mexico, Asia, Europe, Arena Championships and the closed Pro Tour in Richmond are not here
    assert not any(k for k in names if any(w in k for w in ("Mexico", "Taipei", "Amsterdam", "Tokyo", "Arena", "Richmond")))
    assert all(r["venue"]["country"] in ("US", "CA") for r in rows)
    assert all(r["sources"][0]["url"].startswith(WIKI) for r in rows)
    # no player names anywhere in what was kept
    assert "Ingram" not in json.dumps(rows) and "Yuchen" not in json.dumps(rows)


def test_mtg_premier_uses_the_previous_season_for_past_attendance(sroot):
    _, rows = run(sroot, "mtg_premier", fixture_site("mtg_premier"))
    past = [r for r in rows if r.get("size", {}).get("reported_attendance", {}).get("year") == 2025]
    cities = {r["venue"]["city"]: r["size"]["reported_attendance"]["value"] for r in past}
    assert cities == {"Houston": 1045, "Calgary": 373, "Las Vegas": 1396}


def test_mtg_season_page_names_follow_the_calendar():
    assert mtg.season_titles(date(2026, 10, 21))[0] == "2026–27 Premier Play Season"
    assert mtg.season_titles(date(2027, 3, 1))[0] == "2026–27 Premier Play Season"
    assert mtg.season_titles(date(2027, 8, 1))[0] == "2027–28 Premier Play Season"
    assert mtg.page_url("2026–27 Premier Play Season") == WIKI + "2026%E2%80%9327_Premier_Play_Season"


def test_mtg_premier_reports_a_city_it_does_not_know(sroot, tmp_path):
    edit = lambda f: replace_in(f / "page/2026–27_Premier_Play_Season.html", "RC Canada (Ottawa)", "RC Canada (Xyzzyville)")
    res, rows = run(sroot, "mtg_premier", fixture_site("mtg_premier", tmp_path, edit))
    assert res.status == "ok"
    assert any("Xyzzyville" in n and "places list" in n for n in res.notes)
    assert not any(r["venue"]["city"] == "Xyzzyville" for r in rows)


def test_mtg_premier_stops_when_the_regional_boxes_are_gone(sroot, tmp_path):
    def edit(f):
        for page in (f / "page").glob("*.html"):
            page.write_text(page.read_text(encoding="utf-8").replace("<b>Attendance:</b>", "<b>Turnout:</b>"), encoding="utf-8")
    res, rows = run(sroot, "mtg_premier", fixture_site("mtg_premier", tmp_path, edit))
    assert res.status == "error" and "Regional Championship boxes" in res.message and not rows


def test_mtg_premier_stops_when_the_season_page_is_missing(sroot, tmp_path):
    def edit(f):
        for page in (f / "page").glob("*.html"):
            page.unlink()
    res, _ = run(sroot, "mtg_premier", fixture_site("mtg_premier", tmp_path, edit))
    assert res.status == "error" and "season page" in res.message


# ---------------------------------------------------------------- Limitless results

def limitless_site():
    def answer(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/tournaments"
        f = "tournaments.html" if request.url.host == "limitlesstcg.com" else "onepiece_tournaments.html"
        assert request.url.params["region"] == "na"
        return file_response(FIXTURES / "limitless_results" / f)
    return Router(answer)


def test_limitless_writes_past_editions_with_player_counts(sroot):
    site = limitless_site()
    res, rows = run(sroot, "limitless_results", site)
    assert res.status == "ok" and res.skipped == 0
    pk = [r for r in rows if r["sells"]["tcg"] == ["pokemon"]]
    op = [r for r in rows if r["sells"]["tcg"] == ["one_piece"]]
    assert len(pk) > 25 and len(op) > 30
    baltimore = next(r for r in pk if r["venue"]["city"] == "Baltimore" and r["days"][0]["date"] == "2026-09-19")
    assert baltimore["name"] == "Baltimore Pokémon Regional Championships"
    assert baltimore["size"] == {"players": 3122} and baltimore["venue"] == {"city": "Baltimore", "region": "MD", "country": "US"}
    assert baltimore["event_type"] == "tournament" and baltimore["verification"] == "listed"
    assert baltimore["sources"][0]["url"] == "https://limitlesstcg.com/tournaments/577"
    toronto = next(r for r in pk if r["venue"]["city"] == "Toronto" and r["days"][0]["date"] == "2026-01-17")
    assert (toronto["venue"]["region"], toronto["venue"]["country"], toronto["size"]["players"]) == ("ON", "CA", 2270)
    peoria = next(r for r in op if r["days"][0]["date"] == "2026-06-20")
    assert peoria["name"] == "One Piece Regional Peoria" and peoria["size"]["players"] == 1117
    assert any(r["name"].startswith("One Piece Championship Finals") for r in op)
    # everything is in the past, in person, in the US or Canada and a premier event
    assert all(r["days"][0]["date"] < "2026-10-21" and r["venue"]["country"] in ("US", "CA") for r in rows)
    text = json.dumps(rows)
    for left_out in ("World Championships", "Treasure Cup", "Online", "Puerto Rico", "San Juan", "Winner"):
        assert left_out not in text
    assert not any("2018" in r["days"][0]["date"] or "2022" in r["days"][0]["date"] for r in rows)  # only the last three years
    # two sites, a few requests
    assert {r.url.host for r in site.requests} == {"limitlesstcg.com", "onepiece.limitlesstcg.com"}
    assert len(site.requests) <= 6


def test_limitless_names_match_the_upcoming_event_of_the_same_city(sroot):
    """The merge puts editions in one series when city and name agree, so the two modules must name them alike."""
    run(sroot, "pokemon_championships", fixture_site("pokemon_championships"))
    run(sroot, "limitless_results", limitless_site())
    upcoming = {r["venue"]["city"]: r["name"] for r in read_jsonl_file(sroot / "data/harvest/pokemon_championships.jsonl")}
    past = {r["venue"]["city"]: r["name"] for r in read_jsonl_file(sroot / "data/harvest/limitless_results.jsonl") if r["sells"]["tcg"] == ["pokemon"]}
    shared = set(upcoming) & set(past)
    assert {"Toronto", "Seattle", "Las Vegas", "Milwaukee", "San Antonio", "Atlanta"} <= shared
    for city in shared:
        assert upcoming[city] == past[city]


def test_the_next_edition_starts_from_last_years_player_count(sroot):
    """End to end: harvest both, merge, estimate. Toronto 2027 has no count of its own, Toronto 2026 does."""
    run(sroot, "pokemon_championships", fixture_site("pokemon_championships"))
    run(sroot, "limitless_results", limitless_site())
    paths = Paths(sroot)
    vocab = Vocab.load(sroot / "data/vocab.json")
    merge.run_merge(paths, vocab, today=TODAY)
    estimate.run_estimate(paths)
    shows = read_jsonl_file(paths.shows)
    toronto = sorted((s for s in shows if s["venue"]["city"] == "Toronto" and s["event_type"] == "tournament"
                      and "Pokémon" in s["name"]), key=lambda s: s["days"][0]["date"])
    assert len({s["series_id"] for s in toronto}) == 1 and len(toronto) >= 3
    upcoming = next(s for s in toronto if s["days"][0]["date"] == "2027-04-02")
    assert upcoming["size"]["players"] is None
    assert upcoming["estimate"]["basis"] == "history" and "2,270 players" in upcoming["estimate"]["explain"]


def test_limitless_reports_a_city_it_does_not_know(sroot, tmp_path):
    def edit(f):
        replace_in(f / "tournaments.html", 'data-name="Regional Baltimore, MD"', 'data-name="Regional Xyzzyville"')
    site = fixture_site("limitless_results", tmp_path, edit)
    # one host only is needed for this check
    router = Router(lambda r: file_response(site.folder / ("tournaments.html" if r.url.host == "limitlesstcg.com" else "onepiece_tournaments.html")))
    res, rows = run(sroot, "limitless_results", router)
    assert res.status == "ok" and any("Xyzzyville" in n for n in res.notes)
    assert not any(r["venue"]["city"] == "Xyzzyville" for r in rows)


def test_limitless_stops_when_the_results_table_changes(sroot):
    run(sroot, "limitless_results", limitless_site())
    before = (sroot / "data/harvest/limitless_results.jsonl").read_text()
    pokemon = (FIXTURES / "limitless_results/tournaments.html").read_text(encoding="utf-8")
    onepiece = (FIXTURES / "limitless_results/onepiece_tournaments.html").read_text(encoding="utf-8")
    # the column of player counts is renamed: every row is read but none has a count
    renamed = Router(lambda r: httpx.Response(200, text=pokemon.replace("data-players", "data-entrants") if r.url.host == "limitlesstcg.com" else onepiece))
    res, _ = run(sroot, "limitless_results", renamed, refresh=True)
    assert res.status == "error" and "none usable" in res.message
    # the table is gone altogether
    empty = Router(lambda r: httpx.Response(200, text="<html><body><table class='data-table'></table></body></html>"))
    res, _ = run(sroot, "limitless_results", empty, refresh=True)
    assert res.status == "error" and "results table" in res.message
    assert (sroot / "data/harvest/limitless_results.jsonl").read_text() == before


def test_limitless_row_reader_ignores_players_and_winners_it_does_not_need():
    html = ('<table><tr data-date="2026-10-10" data-country="US"\n data-name="Regional Louisville, KY" data-format="standard"\n'
            ' data-players="2927" data-winner="XX-Somebody"><td><a href="/tournaments/581">x</a></td></tr></table>')
    row = lim.parse_rows(html)[0]
    assert row == {"date": "2026-10-10", "country": "US", "name": "Regional Louisville, KY", "players": 2927, "path": "/tournaments/581"}
    assert "Somebody" not in json.dumps(row)
