from __future__ import annotations

import json
import subprocess
from datetime import date

import httpx
import pytest

from csa import issues
from csa.paths import Paths
from csa.vocab import Vocab
from conftest import FIXTURES, read_jsonl_file, write_jsonl_file

TODAY = date(2026, 10, 21)
ALL = json.loads((FIXTURES / "issues.json").read_text())


class FakeFetcher:
    def __init__(self, data=ALL):
        self.data = data
        self.calls = []

    def get(self, path):
        self.calls.append(path)
        label = path.split("labels=")[1].split("&")[0]
        return [i for i in self.data if any(l["name"] == label for l in i["labels"])]


@pytest.fixture
def vocab(root):
    return Vocab.load(root / "data" / "vocab.json")


def pending(root, n):
    return json.loads((root / f"data/submissions/pending/issue-{n}.json").read_text())


def run(root, vocab, fetcher=None, issues_list=None):
    return issues.import_issues(Paths(root), vocab, fetcher or FakeFetcher(), today=TODAY, issues=issues_list)


def test_forms_are_read_from_the_repository_templates(root):
    specs = issues.load_forms(root / ".github" / "ISSUE_TEMPLATE")
    assert sorted(s.labels[0] for s in specs) == ["add-show", "fix-show", "organizer", "removal"]
    add = next(s for s in specs if s.labels == ["add-show"])
    assert [f.id for f in add.fields][:3] == ["name", "dates", "hours"]
    assert next(f for f in add.fields if f.id == "sells").type == "checkboxes"


def test_every_label_is_asked_for_and_pull_requests_are_ignored(root, vocab):
    f = FakeFetcher()
    rep = run(root, vocab, f)
    assert [c.split("labels=")[1].split("&")[0] for c in f.calls] == ["add-show", "fix-show", "organizer", "removal"]
    assert all("state=open" in c for c in f.calls)
    assert rep.fetched == 4 and rep.written == 4  # issue 16 is a pull request
    assert not (root / "data/submissions/pending/issue-16.json").exists()


def test_add_show_becomes_one_record_per_date_run(root, vocab):
    run(root, vocab)
    item = pending(root, 12)
    assert item["kind"] == "add-show" and item["status"] == "pending" and item["issue"] == 12
    assert item["issue_url"] == "https://github.com/holdTheDoorHoid/card-show-atlas/issues/12"
    assert len(item["records"]) == 2
    first = item["records"][0]
    assert first["name"] == "Pine Barrens Card Show"
    assert first["days"] == [{"date": "2026-11-22", "open": "10:00", "close": "16:00"}]
    assert first["venue"] == {"name": "Browns Mills Fire Hall", "address": "12 Pemberton Rd", "city": "Browns Mills",
                              "region": "NJ", "postal": "08015", "country": "US"}
    assert first["sells"] == {"tcg": ["pokemon", "mtg"], "sports": ["multi_sport"], "other": []}
    assert first["admission"]["adult"] == 3 and first["size"]["tables"] == 40
    assert first["links"] == {"facebook": "https://www.facebook.com/pinebarrenscards/posts/123"}
    assert first["vendor"] == {"application_url": "https://pinebarrens.example.com/vendors", "deadline": "2026-11-10"}
    assert first["verification"] == "community"
    assert first["sources"][0]["source"] == "github_issues"
    assert item["records"][1]["days"][0]["date"] == "2026-12-20"
    assert any("prices seen" in n and "60" in n for n in item["review_notes"])


def test_privacy_no_usernames_no_handles_no_phone_numbers(root, vocab):
    run(root, vocab)
    for f in (root / "data/submissions/pending").glob("*.json"):
        text = f.read_text()
        assert "somebody-private" not in text
        assert "609-555-0142" not in text and "555-0142" not in text
    assert "[handle removed]" in pending(root, 12)["raw"]["vendor"]


def test_fix_show_points_at_the_show_and_waits_for_a_patch(root, vocab):
    write_jsonl_file(root / "data/shows.jsonl", [{"id": "garden-state-card-show-edison-nj-2026-11-14"}])
    run(root, vocab)
    item = pending(root, 13)
    assert item["kind"] == "fix-show"
    assert item["target"] == {"page": "https://holdthedoorhoid.github.io/card-show-atlas/shows/garden-state-card-show-edison-nj-2026-11-14/",
                              "id": "garden-state-card-show-edison-nj-2026-11-14", "found": True}
    assert item["change_request"] == "It closes at 2 pm, not 3 pm." and item["patch"] == {}
    assert item["evidence"] == ["https://example.com/show"]
    assert not any("did not match" in n for n in item["review_notes"])


def test_unknown_show_page_is_flagged(root, vocab):
    run(root, vocab)
    assert any("did not match" in n for n in pending(root, 13)["review_notes"])
    assert pending(root, 13)["target"]["found"] is False


def test_organizer_issue_makes_records_with_their_own_venues(root, vocab):
    run(root, vocab)
    item = pending(root, 14)
    assert item["kind"] == "organizer" and len(item["records"]) == 2
    r = item["records"][0]
    assert r["name"] == "Example Monthly Card Show" and r["links"]["official"] == "https://example.com"
    assert r["venue"]["name"] == "VFW Post 123" and r["venue"]["city"] == "Media" and r["venue"]["postal"] == "19063"
    assert r["verification"] == "community"  # the reviewer upgrades it after checking the page
    assert r["size"]["reported_attendance"]["value"] == 800
    assert any("organizer_confirmed" in n for n in item["review_notes"])


def test_removal_issue_defaults_to_doing_nothing_until_reviewed(root, vocab):
    run(root, vocab)
    item = pending(root, 15)
    assert item["kind"] == "removal" and item["suppress"] is False and item["patch"] == {}
    assert item["request"] == "Please remove my phone number."


def test_dates_that_cannot_be_read_are_flagged_for_the_reviewer(root, vocab):
    issue = json.loads(json.dumps(ALL[0]))
    issue["body"] = issue["body"].replace("November 22, 2026 and December 20, 2026", "second Sunday of every month")
    run(root, vocab, issues_list=[issue])
    item = pending(root, 12)
    assert item["records"][0]["days"] == []
    assert any("no calendar date found" in n for n in item["review_notes"])


def test_rerunning_changes_nothing_and_edits_update_the_file(root, vocab):
    run(root, vocab)
    again = run(root, vocab)
    assert (again.written, again.updated, again.unchanged) == (0, 0, 4)
    edited = json.loads(json.dumps(ALL))
    edited[1]["body"] = edited[1]["body"].replace("2 pm, not 3 pm", "1 pm")
    rep = run(root, vocab, issues_list=edited)
    assert rep.updated == 1 and "1 pm" in pending(root, 13)["change_request"]


def test_reviewed_issues_do_not_come_back(root, vocab):
    run(root, vocab)
    pend = root / "data/submissions/pending"
    (root / "data/submissions/approved").mkdir(parents=True)
    (root / "data/submissions/rejected").mkdir(parents=True)
    (pend / "issue-12.json").rename(root / "data/submissions/approved/issue-12.json")
    (pend / "issue-15.json").rename(root / "data/submissions/rejected/issue-15.json")
    rep = run(root, vocab)
    assert rep.already_reviewed == 2 and rep.written == 0
    assert not (pend / "issue-12.json").exists() and not (pend / "issue-15.json").exists()


def test_an_issue_edited_after_approval_returns_with_a_warning(root, vocab):
    run(root, vocab)
    (root / "data/submissions/approved").mkdir(parents=True)
    (root / "data/submissions/pending/issue-12.json").rename(root / "data/submissions/approved/issue-12.json")
    edited = json.loads(json.dumps(ALL))
    edited[0]["body"] += "\n\n(edited)"
    run(root, vocab, issues_list=edited)
    assert "edited after an earlier review" in pending(root, 12)["review_notes"][0]


def test_pending_files_for_closed_issues_are_reported(root, vocab):
    run(root, vocab)
    rep = run(root, vocab, issues_list=[ALL[0]])
    assert sorted(rep.closed_but_pending) == ["issue-13.json", "issue-14.json", "issue-15.json"]


def test_an_issue_that_is_not_a_form_is_kept_for_a_human(root, vocab):
    odd = {"number": 40, "labels": [{"name": "add-show"}], "created_at": "2026-10-21T00:00:00Z", "body": "please add my show!! call 215-555-9999"}
    run(root, vocab, issues_list=[odd])
    item = pending(root, 40)
    assert "could not be read" in item["review_notes"][0] and "555-9999" not in json.dumps(item)


def test_the_gh_fetcher_calls_gh_api_and_the_rest_fetcher_uses_github(monkeypatch):
    seen = {}

    def fake_run(cmd, **kw):
        seen["cmd"] = cmd
        return subprocess.CompletedProcess(cmd, 0, stdout='[{"number": 1}]', stderr="")
    assert issues.GhCliFetcher(fake_run).get("repos/o/r/issues?state=open") == [{"number": 1}]
    assert seen["cmd"][:3] == ["gh", "api", "repos/o/r/issues?state=open"]
    with pytest.raises(RuntimeError):
        issues.GhCliFetcher(lambda cmd, **kw: subprocess.CompletedProcess(cmd, 1, stdout="", stderr="bad")).get("x")

    requests = []

    def handler(request: httpx.Request):
        requests.append(request)
        return httpx.Response(200, json=[{"number": 2}])
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("GH_TOKEN", raising=False)
    got = issues.RestFetcher(httpx.MockTransport(handler)).get("repos/o/r/issues?state=open")
    assert got == [{"number": 2}]
    assert str(requests[0].url) == "https://api.github.com/repos/o/r/issues?state=open"
    assert "authorization" not in requests[0].headers  # no token is needed for a public repository


def test_paging_continues_until_a_short_page(root):
    class Pages:
        def __init__(self):
            self.n = 0

        def get(self, path):
            self.n += 1
            if "labels=add-show" in path and path.endswith("&page=1"):
                return [{"number": i, "labels": [{"name": "add-show"}]} for i in range(1, 101)]
            if "labels=add-show" in path and path.endswith("&page=2"):
                return [{"number": 101, "labels": [{"name": "add-show"}]}]
            return []
    got = issues.fetch_open_issues(Pages(), "o/r")
    assert len(got) == 101
