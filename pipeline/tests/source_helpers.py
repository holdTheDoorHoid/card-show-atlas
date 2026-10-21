"""Shared pieces for the tests of the scripted sources (csa/sources/*.py). Nothing here touches the network."""

from __future__ import annotations

import json
import shutil
from datetime import date
from pathlib import Path

import httpx

from csa import harvest
from csa.http import FixtureTransport
from csa.paths import Paths
from csa.vocab import Vocab
from conftest import FIXTURES, read_jsonl_file

TODAY = date(2026, 10, 21)
NO_SLEEP = {"sleep": lambda s: None}


def run(root: Path, source_id: str, transport: httpx.BaseTransport, today: date = TODAY, **kw):
    """Run one source against a fake website and return (result, every record it wrote).

    That is the harvest file followed by the store events file (data/store, which is not committed)."""
    vocab = Vocab.load(root / "data" / "vocab.json")
    res = harvest.run_source(Paths(root), source_id, vocab, today=today, transport=transport,
                             http_options={**NO_SLEEP, **kw.pop("http_options", {})}, **kw)
    return res, harvest_rows(root, source_id) + store_rows(root, source_id)


def harvest_rows(root: Path, source_id: str) -> list[dict]:
    return read_jsonl_file(root / "data" / "harvest" / f"{source_id}.jsonl")


def store_rows(root: Path, source_id: str) -> list[dict]:
    return read_jsonl_file(root / "data" / "store" / f"{source_id}.jsonl")


def fixture_site(name: str, tmp_path: Path | None = None, edit=None) -> FixtureTransport:
    """The saved pages of one source as a website. `edit(folder)` may change the copy first (to break a page)."""
    if edit is None:
        return FixtureTransport(FIXTURES / name)
    folder = tmp_path / f"site_{name}"
    shutil.copytree(FIXTURES / name, folder)
    edit(folder)
    return FixtureTransport(folder)


def replace_in(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    assert old in text, f"{old!r} is not in {path}"
    path.write_text(text.replace(old, new), encoding="utf-8")


class Router(httpx.BaseTransport):
    """A website that answers by a function of (host, path, query). Records every request it gets."""

    def __init__(self, answer):
        self.answer = answer
        self.requests: list[httpx.Request] = []

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.path == "/robots.txt":
            return self.robots(request)
        return self.answer(request)

    def robots(self, request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, text="no robots.txt")

    def paths(self, host: str | None = None) -> list[str]:
        return [r.url.path for r in self.requests if host is None or r.url.host == host]


def json_response(obj) -> httpx.Response:
    return httpx.Response(200, content=json.dumps(obj).encode(), headers={"content-type": "application/json"})


def file_response(path: Path, ctype: str = "text/html; charset=utf-8") -> httpx.Response:
    return httpx.Response(200, content=path.read_bytes(), headers={"content-type": ctype})
