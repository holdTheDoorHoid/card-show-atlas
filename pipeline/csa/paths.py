"""Where things live in the repository.

Everything is derived from one root directory so tests can point the whole pipeline at a
temporary folder. The root is found, in order, from the --root option, the CSA_ROOT
environment variable, the nearest parent of the current directory that holds
docs/DATA_MODEL.md, and finally the folder this package was installed from.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def find_root(explicit: str | os.PathLike | None = None) -> Path:
    if explicit:
        return Path(explicit).resolve()
    env = os.environ.get("CSA_ROOT")
    if env:
        return Path(env).resolve()
    here = Path.cwd().resolve()
    for candidate in [here, *here.parents]:
        if (candidate / "docs" / "DATA_MODEL.md").exists():
            return candidate
    return Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Paths:
    root: Path

    @property
    def data(self) -> Path:
        return self.root / "data"

    # Inputs
    @property
    def sources_yaml(self) -> Path:
        return self.data / "sources.yaml"

    @property
    def corrections_yaml(self) -> Path:
        return self.data / "corrections.yaml"

    @property
    def vocab(self) -> Path:
        return self.data / "vocab.json"

    @property
    def priors(self) -> Path:
        return self.data / "model" / "priors.json"

    @property
    def raw(self) -> Path:
        return self.data / "raw"

    @property
    def harvest(self) -> Path:
        return self.data / "harvest"

    @property
    def research(self) -> Path:
        return self.data / "research"

    @property
    def research_leads(self) -> Path:
        return self.data / "research" / "leads"

    @property
    def inbox(self) -> Path:
        return self.root / "research" / "inbox"

    @property
    def submissions(self) -> Path:
        return self.data / "submissions"

    @property
    def pending(self) -> Path:
        return self.submissions / "pending"

    @property
    def approved(self) -> Path:
        return self.submissions / "approved"

    @property
    def rejected(self) -> Path:
        return self.submissions / "rejected"

    @property
    def issue_templates(self) -> Path:
        return self.root / ".github" / "ISSUE_TEMPLATE"

    # Outputs
    @property
    def registry(self) -> Path:
        return self.data / "registry.jsonl"

    @property
    def shows(self) -> Path:
        return self.data / "shows.jsonl"

    @property
    def series(self) -> Path:
        return self.data / "series.jsonl"

    @property
    def promoters(self) -> Path:
        return self.data / "promoters.jsonl"

    @property
    def store_events(self) -> Path:
        return self.data / "store_events.jsonl"

    @property
    def store_dir(self) -> Path:
        """Store events from the scripted sources, one file per source. Not committed: see csa/store.py."""
        return self.data / "store"

    @property
    def review(self) -> Path:
        return self.data / "review"

    @property
    def possible_duplicates(self) -> Path:
        return self.review / "possible_duplicates.jsonl"

    @property
    def geocache(self) -> Path:
        return self.data / "geocache.json"

    @property
    def site_data(self) -> Path:
        return self.root / "site" / "public" / "data"

    @property
    def postal_dir(self) -> Path:
        """GeoNames postal code maps, committed. `csa build` copies them into the site data folder."""
        return self.data / "postal"

    @property
    def site_postal_dir(self) -> Path:
        return self.site_data / "postal"
