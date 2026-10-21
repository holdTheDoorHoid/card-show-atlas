"""Riftbound events from the Riftbound Gaming Network locator.

Credit: Riftbound Gaming Network (Riot Games). This is the same event platform as the Ravensburger Play
Hub, so it uses the same client and the same rules; see _playhub.py. Many events listed as upcoming have no
start time yet and are skipped.
"""

from __future__ import annotations

from typing import Iterable

from ._playhub import Game, harvest_game

GAME = Game(
    source="riftbound_locator", label="Riftbound", sells_id="riftbound",
    api="https://api.cloudflare.riftbound.uvsgames.com/hydraproxy/api/v2", game_slug="riftbound",
    page="https://locator.riftbound.uvsgames.com/events/{id}",
)


def harvest(ctx) -> Iterable[dict]:
    yield from harvest_game(ctx, GAME)
