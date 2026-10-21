"""Disney Lorcana events from the Ravensburger Play Hub.

Credit: Ravensburger Play Hub. All of the rules, limits and the reasons for them are in _playhub.py.
Big events become tournaments; weekly play within the next 21 days becomes the store events layer (data/store, not committed).
"""

from __future__ import annotations

from typing import Iterable

from ._playhub import Game, harvest_game

GAME = Game(
    source="lorcana_playhub", label="Lorcana", sells_id="lorcana",
    api="https://api.cloudflare.ravensburgerplay.com/hydraproxy/api/v2", game_slug="disney-lorcana",
    page="https://tcg.ravensburgerplay.com/events/{id}",
)


def harvest(ctx) -> Iterable[dict]:
    yield from harvest_game(ctx, GAME)
