"""A small robots.txt reader that follows RFC 9309.

Python's own parser ignores the * and $ wildcards that most real robots.txt files use, so
this one handles them: the longest matching rule wins, and Allow wins a tie.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass
class _Group:
    agents: list[str] = field(default_factory=list)
    rules: list[tuple[bool, str]] = field(default_factory=list)  # (allow, pattern)
    crawl_delay: float | None = None


def _compile(pattern: str) -> re.Pattern:
    anchored = pattern.endswith("$")
    body = pattern[:-1] if anchored else pattern
    rx = "".join(".*" if ch == "*" else re.escape(ch) for ch in body)
    return re.compile("^" + rx + ("$" if anchored else ""))


class Robots:
    def __init__(self, text: str = "", *, allow_all: bool = False, disallow_all: bool = False):
        self.allow_all = allow_all
        self.disallow_all = disallow_all
        self.groups: list[_Group] = []
        if text:
            self._parse(text)

    def _parse(self, text: str) -> None:
        current: _Group | None = None
        last_was_agent = False
        for raw in text.splitlines():
            line = raw.split("#", 1)[0].strip()
            if not line or ":" not in line:
                continue
            name, _, value = line.partition(":")
            name = name.strip().lower()
            value = value.strip()
            if name == "user-agent":
                if current is None or not last_was_agent:
                    current = _Group()
                    self.groups.append(current)
                current.agents.append(value.lower())
                last_was_agent = True
                continue
            last_was_agent = False
            if current is None:
                continue
            if name in ("allow", "disallow"):
                if value:  # an empty Disallow means nothing is disallowed
                    current.rules.append((name == "allow", value))
            elif name == "crawl-delay":
                try:
                    current.crawl_delay = float(value)
                except ValueError:
                    pass

    def _matching(self, token: str) -> list[_Group]:
        token = token.lower()
        specific = [g for g in self.groups if any(a.split("/")[0] == token for a in g.agents)]
        if specific:
            return specific
        return [g for g in self.groups if "*" in g.agents]

    def allowed(self, token: str, path_and_query: str) -> bool:
        if self.disallow_all:
            return False
        if self.allow_all:
            return True
        best_len = -1
        best_allow = True
        for g in self._matching(token):
            for allow, pattern in g.rules:
                if _compile(pattern).match(path_and_query):
                    n = len(pattern)
                    if n > best_len or (n == best_len and allow and not best_allow):
                        best_len, best_allow = n, allow
        return best_allow

    def crawl_delay(self, token: str) -> float | None:
        delays = [g.crawl_delay for g in self._matching(token) if g.crawl_delay is not None]
        return max(delays) if delays else None
