from __future__ import annotations

import re

import pytest

from csa import harvest
from csa.paths import Paths
from csa.sourcesreg import RegistryError, load_sources
from csa.vocab import Vocab
from conftest import REPO


def data_model_ids() -> dict[str, list[str]]:
    """The ids DATA_MODEL.md section 3 lists, read from the document itself."""
    text = (REPO / "docs" / "DATA_MODEL.md").read_text(encoding="utf-8")
    section = text.split("## 3. Vocabulary", 1)[1].split("\n## ", 1)[0]
    out = {}
    for group in ("tcg", "sports", "other"):
        m = re.search(r"\* `" + group + r"`:(.*?)(?=\n\* `|\n\n|\Z)", section, re.S)
        out[group] = re.findall(r"`([a-z_]+)`", m.group(1))
    return out


def test_vocab_has_every_id_in_the_data_model_with_a_name_and_a_label():
    vocab = Vocab.load(REPO / "data" / "vocab.json")
    wanted = data_model_ids()
    assert all(len(v) > 5 for v in wanted.values())
    for group, ids in wanted.items():
        assert vocab.group_ids(group) == ids, group
        for entry in vocab.data["groups"][group]:
            assert entry["name"].strip() and entry["label"].strip() and len(entry["label"]) <= 20


def test_synonyms_only_point_at_real_ids():
    vocab = Vocab.load(REPO / "data" / "vocab.json")
    valid = {"sells": set(vocab.sells_ids), "event_type": set(vocab.event_types), "status": set(vocab.statuses),
             "vendor_status": set(vocab.vendor_statuses), "verification": set(vocab.verifications),
             "agent_confidence": {"high", "medium", "low"}}
    for kind, table in vocab.data["synonyms"].items():
        for word, target in table.items():
            for t in (target if isinstance(target, list) else [target]):
                assert t in valid[kind], f"{kind}: {word!r} points at {t!r}"


@pytest.mark.parametrize("text, expect", [
    ("Pokemon TCG", ["pokemon"]), ("MTG", ["mtg"]), ("Magic: The Gathering", ["mtg"]), ("Yu-Gi-Oh!", ["yugioh"]),
    ("YGO", ["yugioh"]), ("one piece card game", ["one_piece"]), ("Flesh & Blood", ["fab"]), ("sports cards", ["multi_sport"]),
    ("Comics, toys or other collectibles", ["comics", "toys", "memorabilia"]), ("  POKÉMON ", ["pokemon"]), ("one_piece", ["one_piece"]),
    ("nonsense", []), ("", []), (None, []),
])
def test_sells_synonyms(text, expect):
    assert Vocab.load(REPO / "data" / "vocab.json").resolve("sells", text) == expect


def test_other_synonym_tables():
    v = Vocab.load(REPO / "data" / "vocab.json")
    assert v.resolve_one("event_type", "Regional Championship") == "tournament"
    assert v.resolve_one("event_type", "comic con") == "pop_culture_con"
    assert v.resolve_one("status", "canceled") == "cancelled" and v.resolve_one("status", "TBD") == "tentative"
    assert v.resolve_one("vendor_status", "sold out") == "sold_out" and v.resolve_one("vendor_status", "waitlist") == "waitlist"
    assert v.resolve_one("agent_confidence", "High") == "high"


def test_the_source_id_fixture_is_reserved_for_the_websites_sample_data(tmp_path, root):
    reg = tmp_path / "sources.yaml"
    reg.write_text("- {id: fixture, name: Sample, kind: aggregator, method: script}\n")
    with pytest.raises(RegistryError, match="reserved"):
        load_sources(reg)
    with pytest.raises(ValueError, match="reserved"):
        harvest.scaffold_source(Paths(root), "fixture", "x", "https://x.example", __import__("datetime").date(2026, 10, 21))


def test_registry_problems_are_reported_in_plain_words(tmp_path):
    cases = {
        "- {id: a, name: A, kind: aggregator}\n": "missing 'method'",
        "- {id: a, name: A, kind: weird, method: script}\n": "kind",
        "- {id: a, name: A, kind: aggregator, method: script}\n- {id: a, name: B, kind: aggregator, method: script}\n": "twice",
        "just text\n": "list of sources",
    }
    for text, expect in cases.items():
        p = tmp_path / "s.yaml"
        p.write_text(text)
        with pytest.raises(RegistryError, match=expect):
            load_sources(p)


def test_the_shipped_registry_loads_and_orders_by_priority():
    sources = load_sources(REPO / "data" / "sources.yaml")
    assert {s["id"] for s in sources} >= {"research", "github_issues", "example_calendar"}
    assert all(isinstance(s["priority"], (int, float)) for s in sources)
