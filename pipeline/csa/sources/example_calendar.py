"""Example source: a pretend card show calendar, used by the tests and as a template.

It reads schema.org Event data from two pages (to show how paging works) using the polite
client in ctx.http. Try it offline with the saved pages in the tests folder:

    csa harvest example_calendar --fixture-dir pipeline/tests/fixtures/example_calendar

Copy this file to start a real source (or run `csa new-source <id>`).
"""

from __future__ import annotations

from typing import Iterable

from ..htmlutil import event_to_show, find_links, jsonld_events

START = "https://calendar.example.org/shows/"


def harvest(ctx) -> Iterable[dict]:
    url = START
    for _ in range(5):  # never follow more than five pages
        page = ctx.http.get(url)
        for ev in jsonld_events(page.text):
            rec = event_to_show(ev, url)
            if rec:
                rec.setdefault("source_url", url)
                yield rec
        nxt = [u for u, text in find_links(page.text, url) if text.lower() == "next"]
        if not nxt:
            return
        url = nxt[0]
