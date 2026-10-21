"""Vocabulary: the ids a show may use, and the synonym map the importers use to repair text."""

from __future__ import annotations

from functools import cached_property
from pathlib import Path
from typing import Any

from .util import norm_text, read_json

SELLS_GROUPS = ("tcg", "sports", "other")


def _key(text: str) -> str:
    return norm_text(text)


class Vocab:
    def __init__(self, data: dict):
        self.data = data

    @classmethod
    def load(cls, path: Path) -> "Vocab":
        data = read_json(path)
        if not isinstance(data, dict):
            raise FileNotFoundError(f"vocabulary file not found or empty: {path}")
        return cls(data)

    # ---------------------------------------------------------------- ids
    def group_ids(self, group: str) -> list[str]:
        return [e["id"] for e in self.data["groups"][group]]

    @cached_property
    def sells_ids(self) -> dict[str, str]:
        """id -> group"""
        out = {}
        for g in SELLS_GROUPS:
            for i in self.group_ids(g):
                out[i] = g
        return out

    def ids(self, name: str) -> list[str]:
        """Ids for event_types, statuses, vendor_statuses, verifications, size_classes."""
        return [e["id"] for e in self.data[name]]

    @property
    def event_types(self) -> list[str]:
        return self.ids("event_types")

    @property
    def statuses(self) -> list[str]:
        return self.ids("statuses")

    @property
    def vendor_statuses(self) -> list[str]:
        return self.ids("vendor_statuses")

    @property
    def verifications(self) -> list[str]:
        return self.ids("verifications")

    def display(self, group_or_list: str, ident: str) -> str:
        if group_or_list in self.data["groups"]:
            entries = self.data["groups"][group_or_list]
        else:
            entries = self.data[group_or_list]
        for e in entries:
            if e["id"] == ident:
                return e["name"]
        return ident

    # ---------------------------------------------------------------- synonyms
    @cached_property
    def _syn(self) -> dict[str, dict[str, Any]]:
        out: dict[str, dict[str, Any]] = {}
        for kind, table in self.data.get("synonyms", {}).items():
            norm: dict[str, Any] = {}
            for k, v in table.items():
                norm[_key(k)] = v
                norm[_key(k).replace(" ", "")] = v
            out[kind] = norm
        return out

    def resolve(self, kind: str, token: Any) -> list[str]:
        """Map free text to ids. Returns [] when nothing matches.

        kind is one of sells, event_type, status, vendor_status, verification, agent_confidence.
        """
        if token is None:
            return []
        text = str(token).strip()
        if not text:
            return []
        table = self._syn.get(kind, {})
        k = _key(text)
        hit = table.get(k)
        if hit is None:
            hit = table.get(k.replace(" ", ""))
        if hit is None and kind == "sells" and text in self.sells_ids:
            return [text]
        if hit is None:
            # An exact id also counts (for example "one_piece" normalizes to "one piece").
            raw = text.lower().strip()
            valid = {
                "sells": self.sells_ids,
                "event_type": self.event_types,
                "status": self.statuses,
                "vendor_status": self.vendor_statuses,
                "verification": self.verifications,
            }.get(kind)
            if valid is not None and raw in valid:
                return [raw]
            return []
        return list(hit) if isinstance(hit, list) else [hit]

    def resolve_one(self, kind: str, token: Any) -> str | None:
        got = self.resolve(kind, token)
        return got[0] if got else None
