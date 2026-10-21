from __future__ import annotations

import json
import shutil
from pathlib import Path

import httpx
import pytest

from csa.paths import Paths

REPO = Path(__file__).resolve().parents[2]
FIXTURES = Path(__file__).parent / "fixtures"


class FakeTime:
    """A clock whose sleep() moves it forward, so rate limits can be tested instantly."""

    def __init__(self):
        self.t = 1000.0
        self.sleeps: list[float] = []

    def clock(self) -> float:
        return self.t

    def now(self) -> float:
        return self.t + 1_700_000_000

    def sleep(self, s: float) -> None:
        self.sleeps.append(s)
        self.t += s


@pytest.fixture
def fake_time():
    return FakeTime()


class Site:
    """A scripted website for MockTransport. routes maps a path to a response or a list of responses."""

    def __init__(self, routes: dict[str, object], robots: str | None = "User-agent: *\nDisallow:\n"):
        self.routes = dict(routes)
        if robots is not None:
            self.routes.setdefault("/robots.txt", robots)
        self.log: list[str] = []
        self.headers_seen: list[dict] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.log.append(path + (("?" + request.url.query.decode()) if request.url.query else ""))
        self.headers_seen.append(dict(request.headers))
        spec = self.routes.get(path)
        if spec is None:
            return httpx.Response(404, text="nope")
        if isinstance(spec, list):
            spec = spec.pop(0) if len(spec) > 1 else spec[0]
        if isinstance(spec, httpx.Response):
            return spec
        if isinstance(spec, tuple):
            status, body, *rest = spec
            return httpx.Response(status, text=body, headers=rest[0] if rest else None)
        return httpx.Response(200, text=str(spec))

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self)


@pytest.fixture
def make_site():
    return Site


@pytest.fixture
def root(tmp_path) -> Path:
    """A throwaway repository root with the real vocabulary, priors and sources registry copied in."""
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "DATA_MODEL.md").write_text("x")
    for rel in ("data/vocab.json", "data/model/priors.json", ".github/ISSUE_TEMPLATE"):
        src = REPO / rel
        dst = tmp_path / rel
        if src.is_dir():
            shutil.copytree(src, dst)
        elif src.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(src, dst)
    return tmp_path


@pytest.fixture
def paths(root) -> Paths:
    return Paths(root)


def write_jsonl_file(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in rows))
