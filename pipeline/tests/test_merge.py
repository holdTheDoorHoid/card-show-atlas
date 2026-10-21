from __future__ import annotations

import json
from datetime import date

import pytest

from csa import merge
from csa.paths import Paths
from csa.vocab import Vocab
from conftest import read_jsonl_file, show, write_jsonl_file

TODAY = date(2026, 10, 21)


@pytest.fixture
def vocab(merge_root):
    return Vocab.load(merge_root / "data" / "vocab.json")


def run(root, vocab, today=TODAY):
    return merge.run_merge(Paths(root), vocab, today)


def shows_of(root):
    return read_jsonl_file(root / "data" / "shows.jsonl")


def test_same_edition_from_two_listings_becomes_one_show_with_both_sources(merge_root, vocab):
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", [show(source="list_a", admission={"free": False, "adult": 5, "currency": "USD"})])
    write_jsonl_file(merge_root / "data/harvest/list_b.jsonl", [show(name="Garden State Sports Card Show", source="list_b",
                                                                      sells={"tcg": ["pokemon"], "sports": [], "other": []})])
    rep = run(merge_root, vocab)
    out = shows_of(merge_root)
    assert len(out) == 1 and rep.shows == 1
    s = out[0]
    assert s["name"] == "Garden State Card Show"  # list_a has the smaller priority number, so it wins
    assert {x["source"] for x in s["sources"]} == {"list_a", "list_b"}
    assert s["sells"]["tcg"] == ["pokemon"]  # list_b fills what list_a lacked
    assert s["admission"]["adult"] == 5
    assert s["id"] == "garden-state-card-show-edison-nj-2026-11-14"
    assert s["series_id"] == "garden-state-card-show-edison-nj"
    assert s["estimate"] is None


def test_precedence_corrections_organizer_promoter_listing_research_community(merge_root, vocab):
    base = dict(day="2026-11-14")
    rows = {
        "list_a": show(name="Garden State Card Show", source="list_a", **base),
        "promo": show(name="Garden State Collectors Show", source="promo", verification="organizer_confirmed", **base),
    }
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", [rows["list_a"]])
    write_jsonl_file(merge_root / "data/harvest/promo.jsonl", [rows["promo"]])
    research = {"kind": "edition", "research_id": "w/a/0", **show(name="Garden State Card Expo", source="research", verification="listed", day="2026-11-14")}
    write_jsonl_file(merge_root / "data/research/w.jsonl", [research])
    run(merge_root, vocab)
    assert shows_of(merge_root)[0]["name"] == "Garden State Collectors Show"
    assert shows_of(merge_root)[0]["verification"] == "organizer_confirmed"

    # an organizer confirmed research record outranks the promoter feed
    research["verification"] = "organizer_confirmed"
    research["name"] = "Garden State Sports Show"
    write_jsonl_file(merge_root / "data/research/w.jsonl", [research])
    run(merge_root, vocab)
    assert shows_of(merge_root)[0]["name"] == "Garden State Sports Show"

    # the id was fixed when the first run named the show, and the name change did not move it
    sid = shows_of(merge_root)[0]["id"]
    assert sid == "garden-state-collectors-show-edison-nj-2026-11-14"
    # corrections win over everything, and are applied last
    (merge_root / "data/corrections.yaml").write_text(
        f"{sid}:\n  set:\n    name: Corrected Name\n    vendor.deadline: 2026-11-01\n")
    rep = run(merge_root, vocab)
    s = shows_of(merge_root)[0]
    assert s["name"] == "Corrected Name" and s["vendor"]["deadline"] == "2026-11-01"
    assert rep.corrections_applied == 2


def test_research_beats_community_and_listing_beats_research(merge_root, vocab):
    write_jsonl_file(merge_root / "data/research/w.jsonl", [{"kind": "edition", "research_id": "w/a/0",
                     **show(name="Garden State Card Show", source="research", admission={"free": True, "adult": 0, "currency": "USD"})}])
    approved = {"kind": "add-show", "issue": 1, "records": [show(name="Garden State Card Expo", source="github_issues", verification="community",
                admission={"free": False, "adult": 9, "currency": "USD"}, links={"official": "https://community.example/x"})]}
    (merge_root / "data/submissions/approved").mkdir(parents=True)
    (merge_root / "data/submissions/approved/issue-1.json").write_text(json.dumps(approved))
    run(merge_root, vocab)
    s = shows_of(merge_root)[0]
    assert s["name"] == "Garden State Card Show" and s["admission"]["adult"] == 0
    assert s["links"]["official"] == "https://community.example/x"  # only the community record had a link
    assert s["verification"] == "listed"
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", [show(name="Garden State Collectors Show", source="list_a")])
    run(merge_root, vocab)
    assert shows_of(merge_root)[0]["name"] == "Garden State Collectors Show"


def test_hours_are_filled_from_other_sources_day_by_day(merge_root, vocab):
    a = show(source="list_a")
    a["days"] = [{"date": "2026-11-14", "open": None, "close": None}]
    b = show(source="list_b")
    b["days"] = [{"date": "2026-11-14", "open": "09:00", "close": "15:00"}]
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", [a])
    write_jsonl_file(merge_root / "data/harvest/list_b.jsonl", [b])
    run(merge_root, vocab)
    assert shows_of(merge_root)[0]["days"] == [{"date": "2026-11-14", "open": "09:00", "close": "15:00"}]


def test_venues_within_a_kilometre_and_a_half_match_even_with_different_names(merge_root, vocab):
    a = show(source="list_a", venue="Expo Hall")
    a["venue"].update(lat=40.5000, lon=-74.3000, geo_precision="address")
    b = show(source="list_b", venue="Edison Convention Complex", address="1 Other Way")
    b["venue"].update(lat=40.5050, lon=-74.3000, geo_precision="address")  # about 0.55 km away
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", [a])
    write_jsonl_file(merge_root / "data/harvest/list_b.jsonl", [b])
    run(merge_root, vocab)
    assert len(shows_of(merge_root)) == 1


def test_far_apart_venues_with_different_names_stay_separate(merge_root, vocab):
    a = show(source="list_a", venue="Expo Hall")
    a["venue"].update(lat=40.5, lon=-74.3, geo_precision="address")
    b = show(source="list_b", venue="Other Hall", address="9 Far St")
    b["venue"].update(lat=40.6, lon=-74.3, geo_precision="address")  # 11 km
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", [a])
    write_jsonl_file(merge_root / "data/harvest/list_b.jsonl", [b])
    run(merge_root, vocab)
    assert len(shows_of(merge_root)) == 2


def test_same_venue_name_after_normalizing_matches(merge_root, vocab):
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", [show(source="list_a", venue="The Expo Centre", address=None)])
    write_jsonl_file(merge_root / "data/harvest/list_b.jsonl", [show(source="list_b", venue="Expo Center", address="97 Sunfield Avenue")])
    run(merge_root, vocab)
    assert len(shows_of(merge_root)) == 1


def test_near_misses_are_listed_not_merged(merge_root, vocab):
    # same date and venue, names only partly alike
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", [show(name="Philly Card Show", source="list_a", city="Philadelphia", region="PA")])
    write_jsonl_file(merge_root / "data/harvest/list_b.jsonl", [show(name="Philadelphia Sports Card Show", source="list_b", city="Philadelphia", region="PA")])
    # same name and date but a different venue in the same city
    write_jsonl_file(merge_root / "data/harvest/promo.jsonl", [
        show(name="Maple Card Fest", day="2026-12-05", source="promo", venue="North Hall", address="1 North St", city="Erie", region="PA"),
        show(name="Maple Card Fest", day="2026-12-05", source="promo", venue="South Hall", address="2 South St", city="Erie", region="PA")])
    rep = run(merge_root, vocab)
    assert len(shows_of(merge_root)) == 4
    dups = read_jsonl_file(merge_root / "data/review/possible_duplicates.jsonl")
    reasons = sorted(d["reason"] for d in dups)
    assert reasons == ["same name and date, venues differ", "same venue and date, names differ"]
    assert rep.near_misses == 2


def test_overlapping_dates_with_different_start_day_is_a_near_miss(merge_root, vocab):
    a = show(source="list_a")
    a["days"] = [{"date": "2026-11-14"}, {"date": "2026-11-15"}]
    b = show(source="list_b", day="2026-11-15")
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", [a])
    write_jsonl_file(merge_root / "data/harvest/list_b.jsonl", [b])
    run(merge_root, vocab)
    dups = read_jsonl_file(merge_root / "data/review/possible_duplicates.jsonl")
    assert [d["reason"] for d in dups] == ["overlapping dates, different start day"]


def test_different_countries_never_match(merge_root, vocab):
    a = show(source="list_a", city="Windsor", region="ON", venue="Hall", address=None)
    a["venue"]["country"] = "CA"
    b = show(source="list_b", city="Detroit", region="MI", venue="Hall", address=None)
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", [a])
    write_jsonl_file(merge_root / "data/harvest/list_b.jsonl", [b])
    run(merge_root, vocab)
    assert len(shows_of(merge_root)) == 2


def test_ids_stay_stable_when_the_name_is_corrected_later(merge_root, vocab):
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", [show(name="Garden State Card Show", source="list_a")])
    run(merge_root, vocab)
    first = shows_of(merge_root)[0]["id"]
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", [show(name="Garden State Card Show and Expo", source="list_a")])
    run(merge_root, vocab)
    again = shows_of(merge_root)
    assert [s["id"] for s in again] == [first]
    assert again[0]["name"] == "Garden State Card Show and Expo"
    reg = read_jsonl_file(merge_root / "data/registry.jsonl")
    assert len(reg) == 1 and reg[0]["id"] == first


def test_ids_survive_a_venue_rename_through_the_street_address(merge_root, vocab):
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", [show(source="list_a", venue="Example Expo Hall")])
    run(merge_root, vocab)
    first = shows_of(merge_root)[0]["id"]
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", [show(source="list_a", venue="Renamed Arena")])
    run(merge_root, vocab)
    assert [s["id"] for s in shows_of(merge_root)] == [first]


def test_monthly_show_makes_one_series_with_one_id_per_edition(merge_root, vocab):
    rows = [show(name="Media Monthly Card Show", day=d, source="list_a", venue="VFW Post 123", city="Media", region="PA", address="1 Main St")
            for d in ("2026-11-08", "2026-12-13", "2027-01-10")]
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", rows)
    run(merge_root, vocab)
    out = shows_of(merge_root)
    assert [s["id"] for s in out] == ["media-monthly-card-show-media-pa-2026-11-08", "media-monthly-card-show-media-pa-2026-12-13",
                                      "media-monthly-card-show-media-pa-2027-01-10"]
    series = read_jsonl_file(merge_root / "data/series.jsonl")
    assert len(series) == 1 and series[0]["id"] == "media-monthly-card-show-media-pa"
    assert series[0]["editions"] == [s["id"] for s in out]
    assert series[0]["cadence"] == "Second Sunday of most months"


def test_two_unrelated_shows_with_the_same_name_in_one_town_get_different_series(merge_root, vocab):
    rows = [show(name="Card Show", day="2026-11-08", source="list_a", venue="North Hall", city="Erie", region="PA", address="1 N St"),
            show(name="Card Show", day="2026-11-15", source="list_a", venue="South Hall", city="Erie", region="PA", address="2 S St")]
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", rows)
    run(merge_root, vocab)
    ids = {s["series_id"] for s in shows_of(merge_root)}
    assert len(ids) == 2


def test_past_and_vanished_shows_are_carried_forward(merge_root, vocab):
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", [
        show(name="Old Show", day="2026-09-01", source="list_a", city="Erie", region="PA", venue="Hall", address="1 St"),
        show(name="Soon Show", day="2026-11-14", source="list_a")])
    run(merge_root, vocab)
    # the source forgets the past show and the upcoming one
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", [show(name="New Show", day="2026-12-01", source="list_a", city="Newark", region="NJ", venue="Arena", address="5 Ave")])
    rep = run(merge_root, vocab)
    names = sorted(s["name"] for s in shows_of(merge_root))
    assert names == ["New Show", "Old Show", "Soon Show"]
    assert rep.carried_forward == 2


def test_store_events_go_to_their_own_file_and_not_into_series(merge_root, vocab):
    rows = [show(name="Friday Night Magic", day="2026-10-23", source="list_a", city="Erie", region="PA", venue="Game Haven", address="3 Way", event_type="store_event"),
            show(source="list_a")]
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", rows)
    rep = run(merge_root, vocab)
    assert [s["event_type"] for s in shows_of(merge_root)] == ["card_show"]
    ev = read_jsonl_file(merge_root / "data/store_events.jsonl")
    assert [e["name"] for e in ev] == ["Friday Night Magic"]
    assert all("friday" not in s["id"] for s in read_jsonl_file(merge_root / "data/series.jsonl"))
    assert rep.store_events == 1


def test_estimate_from_a_source_is_ignored(merge_root, vocab):
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", [show(source="list_a", estimate={"attendance": {"low": 1, "mid": 2, "high": 3}})])
    run(merge_root, vocab)
    assert shows_of(merge_root)[0]["estimate"] is None


def test_records_without_usable_dates_are_set_aside(merge_root, vocab):
    bad = show(source="list_a")
    bad["days"] = []
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", [bad, show(name="Fine Show", source="list_a", city="Erie", region="PA", venue="H", address="1 A St")])
    rep = run(merge_root, vocab)
    assert len(shows_of(merge_root)) == 1 and rep.unplaced == 1
    assert read_jsonl_file(merge_root / "data/review/unplaced.jsonl")[0]["reason"] == "no usable date"


def test_output_is_identical_on_a_second_run(merge_root, vocab):
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", [show(source="list_a"), show(name="Other", day="2026-12-01", source="list_a", city="Erie", region="PA", venue="H", address="1 A St")])
    write_jsonl_file(merge_root / "data/harvest/list_b.jsonl", [show(source="list_b")])
    run(merge_root, vocab)
    files = ["shows.jsonl", "series.jsonl", "promoters.jsonl", "registry.jsonl", "store_events.jsonl"]
    first = {f: (merge_root / "data" / f).read_text() for f in files}
    run(merge_root, vocab)
    assert first == {f: (merge_root / "data" / f).read_text() for f in files}


def test_approved_fix_patches_a_show_and_corrections_still_win(merge_root, vocab):
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", [show(source="list_a")])
    run(merge_root, vocab)
    sid = shows_of(merge_root)[0]["id"]
    (merge_root / "data/submissions/approved").mkdir(parents=True)
    (merge_root / "data/submissions/approved/issue-5.json").write_text(json.dumps(
        {"kind": "fix-show", "issue": 5, "target": {"id": sid}, "patch": {"days": [{"date": "2026-11-14", "open": "10:00", "close": "14:00"}], "venue.city": "Metuchen"}}))
    rep = run(merge_root, vocab)
    s = shows_of(merge_root)[0]
    assert s["days"][0]["close"] == "14:00" and s["venue"]["city"] == "Metuchen" and rep.patches_applied == 2
    (merge_root / "data/corrections.yaml").write_text(f"{sid}:\n  set:\n    venue.city: Edison\n")
    run(merge_root, vocab)
    assert shows_of(merge_root)[0]["venue"]["city"] == "Edison"


def test_removal_request_removes_the_show_for_good(merge_root, vocab):
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", [show(source="list_a"), show(name="Other", day="2026-12-01", source="list_a", city="Erie", region="PA", venue="H", address="1 A St")])
    run(merge_root, vocab)
    sid = "garden-state-card-show-edison-nj-2026-11-14"
    (merge_root / "data/submissions/approved").mkdir(parents=True)
    (merge_root / "data/submissions/approved/issue-6.json").write_text(json.dumps({"kind": "removal", "issue": 6, "target": {"id": sid}, "suppress": True}))
    rep = run(merge_root, vocab)
    assert sid not in [s["id"] for s in shows_of(merge_root)] and len(shows_of(merge_root)) == 1
    run(merge_root, vocab)  # the source still lists it, and it must not come back
    assert sid not in [s["id"] for s in shows_of(merge_root)]


def test_drop_in_corrections_removes_a_show(merge_root, vocab):
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", [show(source="list_a")])
    (merge_root / "data/corrections.yaml").write_text("garden-state-card-show-edison-nj-2026-11-14:\n  drop: true\n")
    run(merge_root, vocab)
    assert shows_of(merge_root) == []


def test_corrections_for_unknown_ids_are_warned_about(merge_root, vocab):
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", [show(source="list_a")])
    (merge_root / "data/corrections.yaml").write_text("no-such-show:\n  set:\n    name: x\n")
    rep = run(merge_root, vocab)
    assert any("no-such-show" in w for w in rep.warnings)


def test_series_and_promoter_corrections(merge_root, vocab):
    rows = [show(name="Media Monthly Card Show", day=d, source="list_a", venue="VFW", city="Media", region="PA", address="1 Main St",
                 organizer={"name": "Example Promotions", "url": "https://example.com"}, vendor={"contact": "vendors@example.com"})
            for d in ("2026-11-08", "2026-12-13")]
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", rows)
    (merge_root / "data/corrections.yaml").write_text(
        "series:media-monthly-card-show-media-pa:\n  set:\n    cadence: Second Sunday, not July or August\n")
    run(merge_root, vocab)
    series = read_jsonl_file(merge_root / "data/series.jsonl")[0]
    assert series["cadence"] == "Second Sunday, not July or August" and series["promoter_id"] == "example-promotions"
    prom = read_jsonl_file(merge_root / "data/promoters.jsonl")
    assert prom[0]["id"] == "example-promotions" and prom[0]["series"] == ["media-monthly-card-show-media-pa"]
    assert prom[0]["public_contact"] == "vendors@example.com" and prom[0]["url"] == "https://example.com"
    assert prom[0]["links"]["website"] == "https://example.com"


def test_series_history_collects_attendance_and_tables(merge_root, vocab):
    rows = [show(name="Big Show", day="2025-11-08", source="list_a", size={"tables": 100, "reported_attendance": {"value": 2500, "year": 2025, "source_url": None}}),
            show(name="Big Show", day="2026-11-14", source="list_a", size={"tables": 120})]
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", rows)
    run(merge_root, vocab)
    series = read_jsonl_file(merge_root / "data/series.jsonl")[0]
    assert series["history"] == [{"date": "2025-11-08", "attendance": 2500, "tables": 100}, {"date": "2026-11-14", "attendance": None, "tables": 120}]


def test_mix_is_derived_from_sells(merge_root, vocab):
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", [show(source="list_a", sells={"tcg": ["pokemon"], "sports": ["baseball"], "other": []})])
    run(merge_root, vocab)
    assert shows_of(merge_root)[0]["mix"] == "mixed"


def test_cadence_inference_helper():
    from datetime import date as d
    assert merge.infer_cadence([d(2026, 11, 29), d(2026, 12, 27), d(2027, 1, 31)]) == "Last Sunday of most months"
    assert merge.infer_cadence([d(2026, 11, 7), d(2026, 11, 14), d(2026, 11, 21), d(2026, 11, 28)]) == "Every Saturday"
    assert merge.infer_cadence([d(2026, 11, 7)]) is None
    assert merge.infer_cadence([d(2026, 11, 7), d(2026, 12, 16), d(2027, 2, 3)]) is None
    # fifth Saturdays are always the last Saturday of their month (this once crashed)
    assert merge.infer_cadence([d(2026, 10, 31), d(2027, 1, 30), d(2027, 5, 29)]) == "Last Saturday of most months"


def snapshot(root):
    return {f: (root / "data" / f).read_text() for f in ("shows.jsonl", "series.jsonl", "registry.jsonl", "possible_duplicates.jsonl".replace("possible_duplicates.jsonl", "series.jsonl"))}


def test_ids_do_not_swap_between_runs_when_two_editions_share_a_venue_and_date(merge_root, vocab):
    """Two shows at one venue on one day look alike to the registry. Each must keep its own id."""
    rows = [show(name="Philly Card Show", source="list_a", city="Philadelphia", region="PA"),
            show(name="Philadelphia Sports Card Show", source="list_a", city="Philadelphia", region="PA", address="2 Other Entrance")]
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", rows)
    run(merge_root, vocab)
    first = {s["name"]: s["id"] for s in shows_of(merge_root)}
    assert len(first) == 2
    for _ in range(3):
        run(merge_root, vocab)
        assert {s["name"]: s["id"] for s in shows_of(merge_root)} == first
    assert len(read_jsonl_file(merge_root / "data/registry.jsonl")) == 2


def test_two_sources_can_bridge_two_old_editions_into_one(merge_root, vocab):
    a = show(name="Garden State Card Show", source="list_a", venue="Hall One", address="1 First St")
    b = show(name="Garden State Sports Show", source="list_b", venue="Hall Two", address="2 Second St")
    b["venue"]["name"] = "Hall Two"
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", [a])
    write_jsonl_file(merge_root / "data/harvest/list_b.jsonl", [b])
    run(merge_root, vocab)
    assert len(shows_of(merge_root)) == 2
    # list_b now gives the same venue and address as list_a: the two records are one edition
    b2 = show(name="Garden State Sports Show", source="list_b", venue="Hall One", address="1 First St")
    write_jsonl_file(merge_root / "data/harvest/list_b.jsonl", [b2])
    run(merge_root, vocab)
    out = shows_of(merge_root)
    assert len(out) == 1  # the entry that no longer has a record of its own is not kept as a stale twin
    run(merge_root, vocab)
    assert [s["id"] for s in shows_of(merge_root)] == [out[0]["id"]]


def test_a_crowded_random_dataset_gives_the_same_answer_every_time(merge_root, vocab):
    import random
    rnd = random.Random(7)
    rows = []
    for i in range(400):
        city = rnd.choice(["Erie", "Media", "Edison"])
        rows.append(show(name=f"{city} {rnd.choice(['Card Show', 'Sports Expo', 'Trade Day', 'Pokemon Day'])} {rnd.randint(1, 3)}",
                         day=f"2026-11-{rnd.randint(1, 6):02d}", venue=f"Hall {rnd.randint(1, 3)}", city=city,
                         region="PA" if city != "Edison" else "NJ", address=f"{rnd.randint(1, 4)} Main St", source="list_a"))
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", rows)
    run(merge_root, vocab)
    first = {f: (merge_root / "data" / f).read_text() for f in ("shows.jsonl", "series.jsonl", "registry.jsonl")}
    for _ in range(2):
        rep = run(merge_root, vocab)
        assert rep.carried_forward == 0
        assert first == {f: (merge_root / "data" / f).read_text() for f in first}


# ---------------------------------------------------------------- series are of one kind

def regional(name, day, game, city="Baltimore", region="MD", **extra):
    rec = show(name=name, day=day, source="list_a", venue=None, address=None, city=city, region=region, event_type="tournament",
               sells={"tcg": [game], "sports": [], "other": []}, **extra)
    rec["venue"] = {"city": city, "region": region, "country": "US"}
    return rec


def test_two_card_games_in_one_town_never_share_a_series(merge_root, vocab):
    """The names share the town and the word Regional, so they look alike to the name matcher; the game decides."""
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", [
        regional("Baltimore Pokémon Regional Championships", "2026-09-18", "pokemon"),
        regional("Magic Regional Championship Baltimore", "2026-09-11", "mtg", size={"reported_attendance": {"value": 1486, "year": 2026, "source_url": "https://mtg.example/p"}}),
        regional("Baltimore Pokémon Regional Championships", "2027-09-17", "pokemon")])
    run(merge_root, vocab)
    out = {s["name"] + s["days"][0]["date"]: s for s in shows_of(merge_root)}
    pokemon_a, magic, pokemon_b = (out["Baltimore Pokémon Regional Championships2026-09-18"], out["Magic Regional Championship Baltimore2026-09-11"],
                                   out["Baltimore Pokémon Regional Championships2027-09-17"])
    assert pokemon_a["series_id"] == pokemon_b["series_id"] != magic["series_id"]


def test_a_tournament_does_not_join_the_series_of_a_card_show_in_the_same_town(merge_root, vocab):
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", [
        show(name="Baltimore Show", day="2026-11-08", source="list_a", city="Baltimore", region="MD", venue="Hall", address="1 St"),
        regional("Baltimore Pokémon Regional Championships", "2026-09-18", "pokemon")])
    run(merge_root, vocab)
    assert len({s["series_id"] for s in shows_of(merge_root)}) == 2


def test_series_from_before_the_kind_was_recorded_learn_it_from_the_last_output(merge_root, vocab):
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", [regional("Baltimore Pokémon Regional Championships", "2026-09-18", "pokemon")])
    run(merge_root, vocab)
    # an older registry has no tcg or event_type on its entries
    reg = read_jsonl_file(merge_root / "data/registry.jsonl")
    for e in reg:
        e.pop("tcg", None)
        e.pop("event_type", None)
    write_jsonl_file(merge_root / "data/registry.jsonl", reg)
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", [
        regional("Magic Regional Championship Baltimore", "2026-10-09", "mtg"),
        regional("Baltimore Pokémon Regional Championships", "2026-09-18", "pokemon")])
    run(merge_root, vocab)
    assert len({s["series_id"] for s in shows_of(merge_root)}) == 2
    assert all(e.get("tcg") is not None and e.get("event_type") == "tournament" for e in read_jsonl_file(merge_root / "data/registry.jsonl"))


# ---------------------------------------------------------------- store events do not pile up

def store(name, day, venue="Game Haven", **extra):
    return show(name=name, day=day, source="list_a", city="Erie", region="PA", venue=venue, address="3 Way", event_type="store_event", **extra)


def test_store_events_that_ended_a_week_ago_are_forgotten_with_their_registry_entries(merge_root, vocab):
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", [store("Weekly Play", "2026-10-14"), store("Weekly Play Two", "2026-10-15", venue="Other Shop"),
                                                                 store("Weekly Play Three", "2026-10-30", venue="Third Shop")])
    run(merge_root, vocab, today=date(2026, 10, 14))
    assert len(read_jsonl_file(merge_root / "data/store_events.jsonl")) == 3 and len(read_jsonl_file(merge_root / "data/registry.jsonl")) == 3
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", [store("Weekly Play Four", "2026-11-05", venue="Fourth Shop")])  # the source forgot all the others
    rep = run(merge_root, vocab, today=date(2026, 10, 22))
    names = sorted(e["name"] for e in read_jsonl_file(merge_root / "data/store_events.jsonl"))
    assert names == ["Weekly Play Four", "Weekly Play Three", "Weekly Play Two"]  # Oct 14 ended 8 days ago and goes; Oct 15 stays
    assert rep.carried_forward == 2
    run(merge_root, vocab, today=date(2026, 10, 23))
    assert sorted(e["name"] for e in read_jsonl_file(merge_root / "data/store_events.jsonl")) == ["Weekly Play Four", "Weekly Play Three"]
    assert len(read_jsonl_file(merge_root / "data/registry.jsonl")) == 2  # the entries of the forgotten events are gone too


def test_a_past_show_is_still_kept_for_ever_while_a_past_store_event_is_not(merge_root, vocab):
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", [store("Weekly Play", "2026-10-14"), show(name="Old Show", day="2026-09-01", source="list_a")])
    run(merge_root, vocab, today=date(2026, 10, 14))
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", [])
    run(merge_root, vocab, today=date(2026, 12, 1))
    assert [s["name"] for s in shows_of(merge_root)] == ["Old Show"]
    assert read_jsonl_file(merge_root / "data/store_events.jsonl") == []


def test_two_events_at_one_shop_on_one_day_are_not_listed_as_possible_duplicates(merge_root, vocab):
    write_jsonl_file(merge_root / "data/harvest/list_a.jsonl", [store("Hyperia Prerelease Sealed", "2026-10-25"), store("Casual Play Night Core", "2026-10-25")])
    run(merge_root, vocab)
    assert len(read_jsonl_file(merge_root / "data/store_events.jsonl")) == 2
    assert read_jsonl_file(merge_root / "data/review/possible_duplicates.jsonl") == []
