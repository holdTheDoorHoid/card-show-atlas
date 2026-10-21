from __future__ import annotations

import httpx
import pytest

from csa import USER_AGENT
from csa.http import (BotChallenge, FetchError, FixtureTransport, HttpClient, HttpStatusError,
                      RobotsDisallowed, detect_challenge)
from csa.robots import Robots


def client(site, fake_time, raw=None, **kw):
    return HttpClient("t", raw, transport=site.transport(), sleep=fake_time.sleep, clock=fake_time.clock,
                      now=fake_time.now, jitter=lambda: 0.0, **kw)


# ---------------------------------------------------------------- robots parser

def test_robots_longest_match_and_allow_wins_ties():
    r = Robots("User-agent: *\nDisallow: /private/\nAllow: /private/open/\nDisallow: /*.pdf$\n")
    assert r.allowed("CardShowAtlas", "/shows")
    assert not r.allowed("CardShowAtlas", "/private/x")
    assert r.allowed("CardShowAtlas", "/private/open/x")
    assert not r.allowed("CardShowAtlas", "/a/b.pdf")
    assert r.allowed("CardShowAtlas", "/a/b.pdf?x=1")  # $ anchors the end of the path


def test_robots_specific_group_beats_star():
    r = Robots("User-agent: *\nDisallow: /\n\nUser-agent: CardShowAtlas\nDisallow: /admin\n")
    assert r.allowed("CardShowAtlas", "/shows")
    assert not r.allowed("CardShowAtlas", "/admin/x")
    assert not r.allowed("SomeoneElse", "/shows")


def test_robots_empty_disallow_and_crawl_delay():
    r = Robots("User-agent: *\nDisallow:\nCrawl-delay: 5\n")
    assert r.allowed("CardShowAtlas", "/anything")
    assert r.crawl_delay("CardShowAtlas") == 5.0


# ---------------------------------------------------------------- client

def test_sends_user_agent_and_checks_robots_first(make_site, fake_time):
    site = make_site({"/shows": "<html>hi</html>"})
    with client(site, fake_time) as c:
        resp = c.get("https://example.test/shows")
    assert resp.text == "<html>hi</html>"
    assert site.log[0] == "/robots.txt"
    assert site.log[1] == "/shows"
    assert all(h["user-agent"] == USER_AGENT for h in site.headers_seen)
    assert USER_AGENT == "CardShowAtlas/0.1 (+https://github.com/holdTheDoorHoid/card-show-atlas)"


def test_refuses_disallowed_path_without_fetching_it(make_site, fake_time):
    site = make_site({"/members": "secret", "/shows": "ok"}, robots="User-agent: *\nDisallow: /members\n")
    with client(site, fake_time) as c:
        with pytest.raises(RobotsDisallowed):
            c.get("https://example.test/members/list")
        assert c.get("https://example.test/shows").text == "ok"
        assert c.stats.refused and "robots.txt" in c.stats.refused[0]
    assert "/members/list" not in site.log


def test_robots_checked_once_per_host_but_every_path(make_site, fake_time):
    site = make_site({"/a": "a", "/b": "b"}, robots="User-agent: *\nDisallow: /b\n")
    with client(site, fake_time) as c:
        c.get("https://example.test/a")
        with pytest.raises(RobotsDisallowed):
            c.get("https://example.test/b")
    assert site.log.count("/robots.txt") == 1


def test_missing_robots_allows_everything(make_site, fake_time):
    site = make_site({"/a": "a"}, robots=None)
    with client(site, fake_time) as c:
        assert c.get("https://example.test/a").text == "a"


def test_unreachable_robots_means_no_fetching(make_site, fake_time):
    site = make_site({"/a": "a", "/robots.txt": (500, "oops")}, robots=None)
    with client(site, fake_time, max_retries=0) as c:
        with pytest.raises(RobotsDisallowed):
            c.get("https://example.test/a")
    assert "/a" not in site.log


def test_rate_limit_one_request_per_second_per_host(make_site, fake_time):
    site = make_site({"/a": "a", "/b": "b"})
    with client(site, fake_time) as c:
        c.get("https://example.test/a")
        before = fake_time.t
        c.get("https://example.test/b")
    assert fake_time.t - before >= 1.0
    assert any(abs(s - 1.0) < 0.01 for s in fake_time.sleeps)


def test_rate_limit_is_per_host(make_site, fake_time):
    site = make_site({"/a": "a"})
    with client(site, fake_time) as c:
        c.get("https://one.test/a")
        fake_time.sleeps.clear()
        c.get("https://two.test/a")
    # Only the pause between robots.txt and the page on the new host; one.test's clock did not apply.
    assert fake_time.sleeps == [1.0]


def test_crawl_delay_from_robots_slows_us_down(make_site, fake_time):
    site = make_site({"/a": "a", "/b": "b"}, robots="User-agent: *\nCrawl-delay: 4\n")
    with client(site, fake_time) as c:
        c.get("https://example.test/a")
        fake_time.sleeps.clear()
        c.get("https://example.test/b")
    assert max(fake_time.sleeps) >= 3.9


def test_cache_means_no_second_request(make_site, fake_time, tmp_path):
    site = make_site({"/a": "first"})
    with client(site, fake_time, raw=tmp_path) as c:
        c.get("https://example.test/a")
        again = c.get("https://example.test/a")
        assert again.from_cache and again.text == "first"
        assert c.stats.cache_hits == 1
    assert site.log.count("/a") == 1
    assert list((tmp_path / "t").glob("*.body"))


def test_cache_keeps_different_pages_on_one_host_apart(make_site, fake_time, tmp_path):
    site = make_site({"/a": "page a", "/b": "page b"})
    with client(site, fake_time, raw=tmp_path) as c:
        c.get("https://calendar.example.org/a")
        c.get("https://calendar.example.org/b")
        assert c.get("https://calendar.example.org/a").text == "page a"
        assert c.get("https://calendar.example.org/b").text == "page b"
        assert c.get("https://calendar.example.org/a", params={"page": 2}).from_cache is False


def test_cache_expires_and_refresh_bypasses_it(make_site, fake_time, tmp_path):
    site = make_site({"/a": "x"})
    with client(site, fake_time, raw=tmp_path, cache_ttl_hours=1) as c:
        c.get("https://example.test/a")
        fake_time.t += 7200
        assert not c.get("https://example.test/a").from_cache
        assert not c.get("https://example.test/a", refresh=True).from_cache


def test_retries_server_errors_then_succeeds(make_site, fake_time):
    site = make_site({"/a": [(503, "busy"), (503, "busy"), (200, "fine")]})
    with client(site, fake_time) as c:
        assert c.get("https://example.test/a").text == "fine"
        assert c.stats.retries == 2
    assert fake_time.sleeps.count(2.0) >= 1 and 4.0 in fake_time.sleeps  # growing waits


def test_gives_up_after_the_retry_limit(make_site, fake_time):
    site = make_site({"/a": (500, "broken")})
    with client(site, fake_time, max_retries=2) as c:
        with pytest.raises(HttpStatusError) as err:
            c.get("https://example.test/a")
    assert err.value.status == 500
    assert site.log.count("/a") == 3


def test_retry_after_is_honoured_but_capped(make_site, fake_time):
    site = make_site({"/a": [(429, "slow down", {"retry-after": "10"}), (200, "ok")],
                      "/b": (429, "later", {"retry-after": "3600"})})
    with client(site, fake_time) as c:
        assert c.get("https://example.test/a").text == "ok"
        assert 10.0 in fake_time.sleeps
        with pytest.raises(FetchError, match="giving up"):
            c.get("https://example.test/b")


def test_plain_404_and_403_are_errors_not_retried(make_site, fake_time):
    site = make_site({"/gone": (404, "no"), "/nope": (403, "forbidden")})
    with client(site, fake_time) as c:
        with pytest.raises(HttpStatusError):
            c.get("https://example.test/gone")
        assert c.get("https://example.test/gone", allow_status=(404,)).status == 404
        with pytest.raises(HttpStatusError):
            c.get("https://example.test/nope")
    assert site.log.count("/nope") == 1


CF = "<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>"


def test_cloudflare_challenge_is_a_hard_stop(make_site, fake_time):
    site = make_site({"/a": (403, CF, {"cf-mitigated": "challenge"}), "/b": "fine"})
    with client(site, fake_time) as c:
        with pytest.raises(BotChallenge) as err:
            c.get("https://example.test/a")
        assert "Cloudflare" in err.value.reason
    assert site.log.count("/a") == 1  # never retried, never tried another way


def test_challenge_on_a_503_is_not_retried(make_site, fake_time):
    site = make_site({"/a": (503, CF)})
    with client(site, fake_time) as c:
        with pytest.raises(BotChallenge):
            c.get("https://example.test/a")
    assert site.log.count("/a") == 1


def test_challenge_on_robots_txt_stops_too(make_site, fake_time):
    site = make_site({"/robots.txt": (403, CF), "/a": "x"}, robots=None)
    with client(site, fake_time) as c:
        with pytest.raises(BotChallenge):
            c.get("https://example.test/a")
    assert "/a" not in site.log


def test_challenge_detection_does_not_flag_normal_pages():
    page = b"<html><script src='/cdn-cgi/challenge-platform/scripts/jsd/main.js'></script><form class='g-recaptcha'></form></html>"
    assert detect_challenge(200, {}, page) is None
    assert detect_challenge(403, {}, page) is not None
    assert detect_challenge(200, {"cf-mitigated": "challenge"}, b"") is not None


def test_redirects_are_followed_and_checked(make_site, fake_time):
    site = make_site({"/old": (301, "", {"location": "/new"}), "/new": "moved here",
                      "/hop": (302, "", {"location": "/private/x"}), "/private/x": "secret"},
                     robots="User-agent: *\nDisallow: /private\n")
    with client(site, fake_time) as c:
        assert c.get("https://example.test/old").text == "moved here"
        with pytest.raises(RobotsDisallowed):
            c.get("https://example.test/hop")
    assert "/private/x" not in site.log


def test_non_web_addresses_are_refused(make_site, fake_time):
    with client(make_site({}), fake_time) as c:
        with pytest.raises(FetchError):
            c.get("file:///etc/passwd")


def test_fixture_transport_serves_files(tmp_path):
    (tmp_path / "shows").mkdir()
    (tmp_path / "shows" / "list.html").write_text("<p>hi</p>")
    t = FixtureTransport(tmp_path)
    with httpx.Client(transport=t) as c:
        assert c.get("https://x.test/shows/list?page=2").text == "<p>hi</p>"
        assert c.get("https://x.test/robots.txt").status_code == 404
        assert c.get("https://x.test/../etc/passwd").status_code == 404
