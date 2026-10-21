"""Which web sites we may take facts from (data/never_use_domains.yaml)."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from .textparse import host_of

DEFAULT_LINK_ONLY = ("facebook.com", "fb.com", "fb.me", "instagram.com", "tiktok.com", "x.com", "twitter.com",
                     "t.co", "eventbrite.*", "meetup.com", "allevents.in", "reddit.com")


def _compile(pattern: str) -> re.Pattern:
    p = pattern.strip().lower().lstrip(".")
    if p.endswith(".*"):
        return re.compile(r"(^|\.)" + re.escape(p[:-2]) + r"\.[a-z]{2,}(\.[a-z]{2})?$")
    return re.compile(r"(^|\.)" + re.escape(p) + r"$")


@dataclass
class DomainPolicy:
    never_use: list[str] = field(default_factory=list)
    link_only: list[str] = field(default_factory=lambda: list(DEFAULT_LINK_ONLY))

    def __post_init__(self):
        self._never = [_compile(p) for p in self.never_use]
        self._link = [_compile(p) for p in self.link_only]

    @classmethod
    def load(cls, path: Path) -> "DomainPolicy":
        path = Path(path)
        if not path.exists():
            return cls()
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        return cls([str(x) for x in data.get("never_use_domains") or []],
                   [str(x) for x in data.get("link_only_domains") or DEFAULT_LINK_ONLY])

    def is_never_use(self, url_or_host: str | None) -> bool:
        host = host_of(url_or_host) if url_or_host and "/" in url_or_host else (url_or_host or "").lower()
        return bool(host) and any(rx.search(host) for rx in self._never)

    def is_link_only(self, url_or_host: str | None) -> bool:
        host = host_of(url_or_host) if url_or_host and "/" in url_or_host else (url_or_host or "").lower()
        return bool(host) and any(rx.search(host) for rx in self._link)
