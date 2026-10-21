"""csa postal: postal code centres from GeoNames (CC BY 4.0) as compact maps for the website.

Writes data/postal/US.json ({"08837": [40.52, -74.35]}) and CA.json (keyed by the first three
characters, the forward sortation area, averaged). Coordinates are rounded to 3 decimals. The files are
committed; `csa build` copies them into site/public/data/postal/ for the website.

GeoNames publishes these two files for download at fixed addresses and asks for credit under
CC BY 4.0. Its robots.txt turns crawlers away from the whole download server, but this is not
crawling: two named files, fetched on request, with the project's user agent. So robots.txt is not
applied here, and nothing else on that server is touched.
"""

from __future__ import annotations

import io
import json
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import httpx

from .http import HttpClient
from .paths import Paths
from .util import _atomic_write

URLS = {"US": "https://download.geonames.org/export/zip/US.zip", "CA": "https://download.geonames.org/export/zip/CA.zip"}


@dataclass
class PostalReport:
    counts: dict[str, int]
    sizes: dict[str, int]

    def lines(self) -> list[str]:
        return [f"{c}.json: {self.counts[c]:,} entries, {self.sizes[c]:,} bytes" for c in sorted(self.counts)] + \
               ["Postal code data from GeoNames, CC BY 4.0."]


def parse_geonames(country: str, zip_bytes: bytes) -> dict[str, list[float]]:
    """GeoNames tab separated rows: country, postal, place, ..., latitude (column 10), longitude (column 11)."""
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        name = f"{country}.txt"
        if name not in zf.namelist():
            raise ValueError(f"{name} is not in the {country} download")
        text = zf.read(name).decode("utf-8")
    sums: dict[str, list[float]] = {}
    for line in text.splitlines():
        cols = line.split("\t")
        if len(cols) < 11 or not cols[1].strip():
            continue
        try:
            lat, lon = float(cols[9]), float(cols[10])
        except ValueError:
            continue
        key = cols[1].strip().upper()
        if country == "CA":
            key = key.replace(" ", "")[:3]
        elif country == "US":
            key = key[:5]
        acc = sums.setdefault(key, [0.0, 0.0, 0])
        acc[0] += lat
        acc[1] += lon
        acc[2] += 1
    return {k: [round(v[0] / v[2], 3), round(v[1] / v[2], 3)] for k, v in sorted(sums.items())}


def run_postal(paths: Paths, transport: httpx.BaseTransport | None = None, refresh: bool = False,
               fetch: Callable[[str], bytes] | None = None, **http_options) -> PostalReport:
    client = None
    if fetch is None:
        client = HttpClient("geonames", paths.raw, respect_robots=False, transport=transport,
                            cache_ttl_hours=0.0 if refresh else 12.0, **http_options)
        fetch = lambda url: client.get(url).content  # noqa: E731
    counts, sizes = {}, {}
    try:
        for country, url in URLS.items():
            table = parse_geonames(country, fetch(url))
            text = json.dumps(table, separators=(",", ":")) + "\n"
            _atomic_write(paths.postal_dir / f"{country}.json", text)
            counts[country], sizes[country] = len(table), len(text.encode())
    finally:
        if client:
            client.close()
    return PostalReport(counts, sizes)
