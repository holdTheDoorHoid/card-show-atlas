"""The polite HTTP client every harvester uses.

What it does for you:

* sends the Card Show Atlas user agent on every request;
* reads robots.txt for each host before fetching and refuses paths it disallows;
* waits at least one second between requests to the same host (more if robots.txt asks);
* keeps a copy of every response under data/raw/<source>/ and reuses it for a few hours;
* retries server errors and rate limit replies a few times, with growing waits;
* stops dead on a bot challenge (Cloudflare and similar). It never retries, never tries a
  different way in, and raises BotChallenge so the harvest report says so.
"""

from __future__ import annotations

import hashlib
import json
import random
import re
import time
from dataclasses import dataclass, field
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlencode, urljoin, urlsplit

import httpx

from . import ROBOTS_TOKEN, USER_AGENT
from .robots import Robots

RETRY_STATUSES = {429, 500, 502, 503, 504}


class FetchError(Exception):
    """A request failed in a way the caller should know about."""


class HttpStatusError(FetchError):
    def __init__(self, url: str, status: int):
        super().__init__(f"{url} answered HTTP {status}")
        self.url = url
        self.status = status


class RobotsDisallowed(FetchError):
    pass


class RobotsUnreachable(FetchError):
    pass


class BotChallenge(FetchError):
    """The site asked us to prove we are a person. This is a hard stop for the whole source."""

    def __init__(self, url: str, reason: str):
        super().__init__(f"bot challenge at {url}: {reason}. Stopping this source. Nothing was bypassed.")
        self.url = url
        self.reason = reason


# ---------------------------------------------------------------- challenge detection

_ALWAYS = [
    (re.compile(r"<title>\s*just a moment\.\.\.\s*</title>", re.I), "Cloudflare challenge page"),
    (re.compile(r"cf_chl_opt|cf-browser-verification|cf_chl_prog", re.I), "Cloudflare challenge page"),
    (re.compile(r"attention required!\s*\|\s*cloudflare", re.I), "Cloudflare block page"),
    (re.compile(r"_Incapsula_Resource|Incapsula incident", re.I), "Imperva challenge page"),
    (re.compile(r"px-captcha|perimeterx", re.I), "PerimeterX challenge page"),
    (re.compile(r"captcha-delivery\.com|datadome", re.I), "DataDome challenge page"),
]
_ON_ERROR = [
    (re.compile(r"challenge-platform", re.I), "Cloudflare challenge page"),
    (re.compile(r"checking your browser", re.I), "browser check page"),
    (re.compile(r"g-recaptcha|h-captcha|hcaptcha|turnstile", re.I), "captcha page"),
    (re.compile(r"enable javascript and cookies to continue", re.I), "browser check page"),
    (re.compile(r"access denied.{0,200}(akamai|edgesuite)|errors\.edgesuite\.net", re.I | re.S), "Akamai block page"),
    (re.compile(r"sucuri website firewall", re.I), "Sucuri firewall page"),
]


def detect_challenge(status: int, headers: dict[str, str], body: bytes) -> str | None:
    """Return a short reason when the response is a bot challenge, else None."""
    if headers.get("cf-mitigated", "").lower() == "challenge":
        return "Cloudflare challenge (cf-mitigated header)"
    sample = body[:65536].decode("utf-8", errors="ignore")
    for rx, reason in _ALWAYS:
        if rx.search(sample):
            return reason
    if status >= 400:
        for rx, reason in _ON_ERROR:
            if rx.search(sample):
                return reason
    return None


# ---------------------------------------------------------------- response

@dataclass
class Response:
    url: str
    status: int
    headers: dict[str, str]
    content: bytes
    from_cache: bool = False
    fetched_at: str = ""

    @property
    def text(self) -> str:
        m = re.search(r"charset=([\w-]+)", self.headers.get("content-type", ""), re.I)
        enc = m.group(1) if m else "utf-8"
        try:
            return self.content.decode(enc, errors="replace")
        except LookupError:
            return self.content.decode("utf-8", errors="replace")

    def json(self) -> Any:
        return json.loads(self.content.decode("utf-8-sig"))


@dataclass
class Stats:
    network_requests: int = 0
    cache_hits: int = 0
    robots_fetches: int = 0
    retries: int = 0
    refused: list[str] = field(default_factory=list)


# ---------------------------------------------------------------- client

class HttpClient:
    def __init__(
        self,
        source_id: str,
        raw_root: Path | None = None,
        *,
        user_agent: str = USER_AGENT,
        min_interval: float = 1.0,
        respect_robots: bool = True,
        transport: httpx.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
        now: Callable[[], float] = time.time,
        jitter: Callable[[], float] | None = None,
        cache_ttl_hours: float = 12.0,
        max_retries: int = 3,
        backoff_base: float = 2.0,
        max_backoff: float = 60.0,
        timeout: float = 30.0,
        max_bytes: int = 10_000_000,
        max_redirects: int = 5,
    ):
        self.source_id = source_id
        self.raw_dir = Path(raw_root) / source_id if raw_root else None
        self.user_agent = user_agent
        self.min_interval = min_interval
        self.respect_robots = respect_robots
        self._sleep = sleep
        self._clock = clock
        self._now = now
        self._jitter = jitter if jitter is not None else (lambda: random.uniform(0, 0.5))
        self.cache_ttl = cache_ttl_hours * 3600
        self.max_retries = max_retries
        self.backoff_base = backoff_base
        self.max_backoff = max_backoff
        self.max_bytes = max_bytes
        self.max_redirects = max_redirects
        self._client = httpx.Client(
            transport=transport, timeout=timeout, follow_redirects=False,
            headers={"User-Agent": user_agent, "Accept": "text/html,application/json;q=0.9,*/*;q=0.5"},
        )
        self._last_request: dict[str, float] = {}
        self._robots: dict[str, Robots] = {}
        self._robots_delay: dict[str, float] = {}
        self.stats = Stats()

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "HttpClient":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # ---------------------------------------------------------------- cache
    def _cache_paths(self, url: str) -> tuple[Path, Path] | None:
        if self.raw_dir is None:
            return None
        host = urlsplit(url).netloc.replace(":", "_")
        digest = hashlib.sha1(url.encode()).hexdigest()[:16]
        name = f"{host}__{digest}"
        return self.raw_dir / (name + ".body"), self.raw_dir / (name + ".json")

    def _cache_read(self, url: str) -> Response | None:
        paths = self._cache_paths(url)
        if not paths or not paths[0].exists() or not paths[1].exists():
            return None
        try:
            meta = json.loads(paths[1].read_text())
            if self._now() - meta["fetched_epoch"] > self.cache_ttl:
                return None
            return Response(url, meta["status"], meta["headers"], paths[0].read_bytes(), True, meta["fetched_at"])
        except (OSError, ValueError, KeyError):
            return None

    def _cache_write(self, key: str, resp: Response) -> None:
        paths = self._cache_paths(key)
        if not paths:
            return
        paths[0].parent.mkdir(parents=True, exist_ok=True)
        paths[0].write_bytes(resp.content)
        keep = {k: v for k, v in resp.headers.items() if k in ("content-type", "etag", "last-modified", "date")}
        meta = {"url": resp.url, "status": resp.status, "headers": keep,
                "fetched_epoch": self._now(), "fetched_at": resp.fetched_at}
        paths[1].write_text(json.dumps(meta, indent=1))

    # ---------------------------------------------------------------- robots
    def _fetch_robots(self, origin: str) -> Robots:
        self.stats.robots_fetches += 1
        url = origin + "/robots.txt"
        try:
            resp = self._send("GET", url, None, None, check_robots=False, max_retries=1)
        except BotChallenge:
            raise
        except FetchError as exc:
            self.stats.refused.append(f"{origin}: robots.txt unreachable ({exc})")
            return Robots(disallow_all=True)
        if resp.status == 200:
            if self.raw_dir:
                self.raw_dir.mkdir(parents=True, exist_ok=True)
                (self.raw_dir / f"robots__{urlsplit(origin).netloc.replace(':', '_')}.txt").write_bytes(resp.content)
            robots = Robots(resp.text)
            delay = robots.crawl_delay(ROBOTS_TOKEN)
            if delay:
                self._robots_delay[origin] = delay
            return robots
        if 400 <= resp.status < 500:
            return Robots(allow_all=True)  # RFC 9309: a missing robots.txt means no limits
        self.stats.refused.append(f"{origin}: robots.txt answered HTTP {resp.status}")
        return Robots(disallow_all=True)

    def robots_allows(self, url: str) -> bool:
        parts = urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        if origin not in self._robots:
            self._robots[origin] = self._fetch_robots(origin)
        path = parts.path or "/"
        if parts.query:
            path += "?" + parts.query
        return self._robots[origin].allowed(ROBOTS_TOKEN, path)

    # ---------------------------------------------------------------- sending
    def _interval(self, origin: str) -> float:
        return max(self.min_interval, self._robots_delay.get(origin, 0.0))

    def _throttle(self, origin: str) -> None:
        last = self._last_request.get(origin)
        if last is not None:
            wait = self._interval(origin) - (self._clock() - last)
            if wait > 0:
                self._sleep(wait)

    def _retry_wait(self, attempt: int, resp: httpx.Response | None) -> float:
        wait = self.backoff_base * (2 ** attempt) + self._jitter()
        if resp is not None and "retry-after" in resp.headers:
            ra = resp.headers["retry-after"].strip()
            try:
                wait = max(wait, float(ra))
            except ValueError:
                try:
                    wait = max(wait, parsedate_to_datetime(ra).timestamp() - self._now())
                except (TypeError, ValueError):
                    pass
        return wait

    def _send(self, method: str, url: str, params: dict | None, data: Any, *, check_robots: bool = True,
              max_retries: int | None = None, files: Any = None, headers: dict | None = None) -> Response:
        if params:
            url = url + ("&" if "?" in url else "?") + urlencode(params, doseq=True)
        retries = self.max_retries if max_retries is None else max_retries
        hops = 0
        while True:
            parts = urlsplit(url)
            if parts.scheme not in ("http", "https") or not parts.netloc:
                raise FetchError(f"not a web address: {url}")
            origin = f"{parts.scheme}://{parts.netloc}"
            if check_robots and self.respect_robots and not self.robots_allows(url):
                self.stats.refused.append(f"{url}: disallowed by robots.txt")
                raise RobotsDisallowed(f"robots.txt for {parts.netloc} does not allow {parts.path or '/'}. Not fetched.")
            attempt = 0
            while True:
                self._throttle(origin)
                try:
                    self.stats.network_requests += 1
                    raw = self._client.request(method, url, data=data if method == "POST" else None,
                                               files=files, headers=headers)
                    transport_error = None
                except httpx.TransportError as exc:
                    raw, transport_error = None, exc
                finally:
                    self._last_request[origin] = self._clock()
                if raw is not None:
                    body = raw.content[: self.max_bytes + 1]
                    if len(body) > self.max_bytes:
                        raise FetchError(f"{url} is larger than {self.max_bytes} bytes. Not stored.")
                    hdrs = {k.lower(): v for k, v in raw.headers.items()}
                    reason = detect_challenge(raw.status_code, hdrs, body)
                    if reason:
                        self.stats.refused.append(f"{url}: {reason}")
                        raise BotChallenge(url, reason)
                    if raw.status_code not in RETRY_STATUSES:
                        break
                if attempt >= retries:
                    if raw is not None:
                        raise HttpStatusError(url, raw.status_code)
                    raise FetchError(f"{url} could not be reached ({type(transport_error).__name__})")
                wait = self._retry_wait(attempt, raw)
                if wait > self.max_backoff:
                    raise FetchError(f"{url} asked us to wait {wait:.0f} seconds; giving up for now.")
                self.stats.retries += 1
                self._sleep(wait)
                attempt += 1
            if raw.status_code in (301, 302, 303, 307, 308) and "location" in raw.headers:
                hops += 1
                if hops > self.max_redirects:
                    raise FetchError(f"too many redirects from {url}")
                url = urljoin(url, raw.headers["location"])
                continue
            stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self._now()))
            return Response(url, raw.status_code, hdrs, body, False, stamp)

    def get(self, url: str, params: dict | None = None, *, refresh: bool = False,
            allow_status: tuple[int, ...] = (), headers: dict | None = None) -> Response:
        """GET a page. Raises HttpStatusError for any error status not listed in allow_status."""
        full = url + (("&" if "?" in url else "?") + urlencode(params, doseq=True) if params else "")
        if not refresh:
            cached = self._cache_read(full)
            if cached is not None:
                self.stats.cache_hits += 1
                return cached
        resp = self._send("GET", full, None, None, headers=headers)
        if resp.status >= 400 and resp.status not in allow_status:
            raise HttpStatusError(full, resp.status)
        if resp.status < 400:
            self._cache_write(full, resp)
        return resp

    def post(self, url: str, *, data: dict | None = None, files: dict | None = None,
             check_robots: bool = True) -> Response:
        """POST (never cached). Used only for documented public APIs such as the Census batch geocoder."""
        resp = self._send("POST", url, None, data, files=files, check_robots=check_robots)
        if resp.status >= 400:
            raise HttpStatusError(url, resp.status)
        return resp


# ---------------------------------------------------------------- offline replay

class FixtureTransport(httpx.BaseTransport):
    """Serve files from a folder as if it were the website. Used for tests and for developing a source.

    A request for https://site.example/shows/list?page=2 is answered from <folder>/shows/list,
    <folder>/shows/list.html or <folder>/shows/list.json (the host and query string are ignored). A path ending in / reads index.html. A missing
    robots.txt answers 404, which means everything is allowed.
    """

    TYPES = {".html": "text/html; charset=utf-8", ".json": "application/json", ".xml": "application/xml",
             ".txt": "text/plain; charset=utf-8", ".csv": "text/csv", ".ics": "text/calendar"}

    def __init__(self, folder: Path):
        self.folder = Path(folder)
        self.requests: list[str] = []

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(str(request.url))
        rel = request.url.path.lstrip("/")
        if not rel or rel.endswith("/"):
            rel += "index.html"
        target = (self.folder / rel).resolve()
        if self.folder.resolve() not in target.parents and target != self.folder.resolve():
            return httpx.Response(404)
        if not target.is_file():
            for ext in (".html", ".json"):  # /shows/list may be stored as list.html
                if target.with_name(target.name + ext).is_file():
                    target = target.with_name(target.name + ext)
                    break
        if not target.is_file():
            return httpx.Response(404, text="not found")
        ctype = self.TYPES.get(target.suffix.lower(), "application/octet-stream")
        return httpx.Response(200, content=target.read_bytes(), headers={"content-type": ctype})
