"""Reading data/sources.yaml."""

from __future__ import annotations

from pathlib import Path

import yaml

KINDS = {"aggregator", "promoter", "publisher", "platform", "venue", "community", "submission"}
METHODS = {"script", "research", "manual"}
REQUIRED = ("id", "name", "kind", "method")
RESERVED_IDS = {"fixture"}  # the website uses this id for its sample data and refuses to build with it


class RegistryError(ValueError):
    pass


def load_sources(path: Path) -> list[dict]:
    """The sources in file order, each with defaults filled in and a stable rank."""
    path = Path(path)
    if not path.exists():
        return []
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or []
    if not isinstance(data, list):
        raise RegistryError(f"{path} must be a list of sources")
    seen: set[str] = set()
    out = []
    for i, entry in enumerate(data):
        if not isinstance(entry, dict):
            raise RegistryError(f"{path} entry {i + 1} is not a mapping")
        for key in REQUIRED:
            if not entry.get(key):
                raise RegistryError(f"{path} entry {i + 1} ({entry.get('id', '?')}) is missing {key!r}")
        if entry["id"] in RESERVED_IDS:
            raise RegistryError(f"{path}: the source id {entry['id']!r} is reserved for the website's sample data")
        if entry["id"] in seen:
            raise RegistryError(f"{path} lists the source {entry['id']!r} twice")
        seen.add(entry["id"])
        if entry["kind"] not in KINDS:
            raise RegistryError(f"source {entry['id']}: kind {entry['kind']!r} must be one of {sorted(KINDS)}")
        if entry["method"] not in METHODS:
            raise RegistryError(f"source {entry['id']}: method {entry['method']!r} must be one of {sorted(METHODS)}")
        e = dict(entry)
        e.setdefault("enabled", True)
        e.setdefault("fields", [])
        e["priority"] = e.get("priority", 100 + i)
        e["_order"] = i
        if e.get("checked") is not None:
            e["checked"] = str(e["checked"])
        out.append(e)
    return out


def by_id(path: Path) -> dict[str, dict]:
    return {s["id"]: s for s in load_sources(path)}
