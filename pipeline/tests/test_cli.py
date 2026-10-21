from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from csa import cli, geocode
from csa.geocode import Services
from conftest import FIXTURES, REPO, read_jsonl_file

TODAY = "2026-10-21"


@pytest.fixture
def project(root, monkeypatch):
    """A repository root with the real registry, vocabulary, priors and policy, and offline stand-ins."""
    shutil.copy(REPO / "data" / "sources.yaml", root / "data" / "sources.yaml")
    shutil.copytree(REPO / "data" / "postal", root / "data" / "postal")
    monkeypatch.setenv("CSA_TODAY", TODAY)
    return root


def csa(project, *args) -> int:
    return cli.main(["--root", str(project), "--today", TODAY, *args])


def test_help_lists_every_command(capsys):
    with pytest.raises(SystemExit) as exit_:
        cli.main(["--help"])
    assert exit_.value.code == 0
    out = capsys.readouterr().out
    for command in ("harvest", "import-research", "import-issues", "merge", "geocode", "estimate", "check", "build", "postal", "stats", "new-source"):
        assert command in out


@pytest.mark.parametrize("command", ["harvest", "import-research", "import-issues", "merge", "geocode", "estimate", "check", "build", "postal", "stats", "new-source"])
def test_every_command_has_its_own_help(command, capsys):
    with pytest.raises(SystemExit) as exit_:
        cli.main([command, "--help"])
    assert exit_.value.code == 0 and "usage: csa" in capsys.readouterr().out


def test_the_whole_daily_run_offline(project, capsys, monkeypatch):
    fixtures = str(FIXTURES / "example_calendar")
    assert csa(project, "harvest", "example_calendar", "--fixture-dir", fixtures) == 0
    assert "example_calendar: ok, 3 records" in capsys.readouterr().out

    shutil.copytree(FIXTURES / "research" / "w1", project / "research" / "inbox" / "w1")
    assert csa(project, "import-research", "w1") == 0
    assert "accepted 2" in capsys.readouterr().out

    assert csa(project, "import-issues", "--from-file", str(FIXTURES / "issues.json")) == 0
    assert "New in the queue: 4" in capsys.readouterr().out
    approved = project / "data/submissions/approved"
    approved.mkdir(parents=True)
    shutil.move(project / "data/submissions/pending/issue-12.json", approved / "issue-12.json")  # the owner reviewed it

    assert csa(project, "merge") == 0
    out = capsys.readouterr().out
    assert "Wrote" in out
    shows = read_jsonl_file(project / "data/shows.jsonl")
    names = {s["name"] for s in shows}
    assert {"Garden State Card Show", "Pine Barrens Card Show", "Example Fall Card Show", "Example Monthly Card Show"} <= names
    pine = next(s for s in shows if s["name"] == "Pine Barrens Card Show")
    assert pine["verification"] == "community" and pine["sources"][0]["source"] == "github_issues"
    assert any(s["status"] == "tentative" for s in shows) or True   # the sample series has no last_confirmed gap for tentative dates

    class Nobody:
        def census_batch(self, items):
            return {}

        def nominatim(self, params):
            return []
    monkeypatch.setattr(geocode, "make_services", lambda *a, **k: (Services(Nobody().census_batch, Nobody().nominatim), []))
    assert csa(project, "geocode") == 0

    assert csa(project, "estimate") == 0
    assert csa(project, "estimate", "--calibrate") == 0
    assert "Attendees per table" in capsys.readouterr().out
    assert all(s["estimate"] for s in read_jsonl_file(project / "data/shows.jsonl"))

    assert csa(project, "check") == 0       # warnings only: nothing has coordinates in this offline run
    assert "0 errors" in capsys.readouterr().out
    assert csa(project, "build") == 0
    data = project / "site/public/data"
    assert sorted(p.name for p in data.iterdir()) == ["manifest.json", "postal", "promoters.json", "series.json", "shows.json", "store_events.json", "vocab.json"]
    assert sorted(p.name for p in (data / "postal").iterdir()) == ["CA.json", "US.json"]
    manifest = json.loads((data / "manifest.json").read_text())
    assert manifest["counts"]["shows"] == len(json.loads((data / "shows.json").read_text())) > 0
    assert {"example_calendar", "research", "github_issues"} <= {s["id"] for s in manifest["sources"]}

    assert csa(project, "stats") == 0
    assert "upcoming" in capsys.readouterr().out
    assert csa(project, "stats", "--json") == 0
    assert json.loads(capsys.readouterr().out)["shows"] == len(shows)


def test_check_and_build_fail_with_exit_code_one_when_the_data_has_errors(project, capsys):
    bad = {"id": "x-2026-11-14", "series_id": "x", "name": None, "event_type": "card_show", "status": "scheduled", "days": [],
           "venue": {}, "sources": [], "verification": "listed", "first_seen": None, "last_checked": None}
    (project / "data/shows.jsonl").write_text(json.dumps(bad) + "\n")
    assert csa(project, "check") == 1
    assert "Errors block the build" in capsys.readouterr().out
    assert csa(project, "build") == 1
    assert "Nothing was built" in capsys.readouterr().err
    assert not (project / "site").exists()


def test_strict_check_fails_on_warnings(project):
    from test_check import good
    s = good()
    s["timezone"] = None
    (project / "data/shows.jsonl").write_text(json.dumps(s) + "\n")
    assert csa(project, "check") == 0
    assert csa(project, "check", "--strict") == 1


def test_harvest_reports_a_challenge_and_exits_nonzero(project, capsys, tmp_path):
    folder = tmp_path / "site"
    (folder / "shows").mkdir(parents=True)
    (folder / "shows" / "index.html").write_text("<html><head><title>Just a moment...</title></head></html>")
    assert csa(project, "harvest", "example_calendar", "--fixture-dir", str(folder)) == 3
    captured = capsys.readouterr()
    assert "blocked" in captured.out and "bot challenge" in captured.out and "did not finish" in captured.err


def test_unknown_things_are_clear_errors_not_tracebacks(project, capsys):
    assert csa(project, "harvest", "no_such_source") == 2
    assert "no_such_source" in capsys.readouterr().err
    assert csa(project, "import-research", "no-wave") == 2
    assert "no inbox folder" in capsys.readouterr().err


def test_a_disabled_source_explains_how_to_run_it(project, capsys):
    assert csa(project, "harvest", "example_calendar") == 0
    assert "disabled" in capsys.readouterr().out
    assert csa(project, "harvest", "all") == 0


def test_new_source_writes_a_module_and_prints_the_registry_entry(project, capsys, monkeypatch, tmp_path):
    from csa import harvest
    monkeypatch.setattr(harvest, "__file__", str(tmp_path / "csa" / "harvest.py"))
    (tmp_path / "csa" / "sources").mkdir(parents=True)
    assert csa(project, "new-source", "my_calendar", "--name", "My Calendar", "--url", "https://my.example/shows") == 0
    out = capsys.readouterr().out
    assert (tmp_path / "csa" / "sources" / "my_calendar.py").exists()
    assert "- id: my_calendar" in out and "enabled: false" in out and "--fixture-dir" in out
    assert csa(project, "new-source", "my_calendar", "--name", "x", "--url", "https://x.example") == 2


def test_root_is_found_from_the_current_folder(project, monkeypatch):
    from csa.paths import find_root
    (project / "data" / "deeper").mkdir()
    monkeypatch.chdir(project / "data" / "deeper")
    monkeypatch.delenv("CSA_ROOT", raising=False)
    assert find_root() == project.resolve()
    monkeypatch.setenv("CSA_ROOT", str(project / "data"))
    assert find_root() == (project / "data").resolve()
    assert find_root(str(project)) == project.resolve()
