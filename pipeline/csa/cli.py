"""The csa command line."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from . import __version__
from .paths import Paths, find_root
from .vocab import Vocab

DESCRIPTION = """Card Show Atlas data pipeline.

Normal order of a daily run:
  csa harvest all, csa import-issues, csa merge, csa geocode, csa estimate, csa check, csa build
"""


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="csa", description=DESCRIPTION, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--root", help="repository root (default: found from the current folder, or CSA_ROOT)")
    p.add_argument("--today", help="pretend today is this date, YYYY-MM-DD (for repeatable runs)")
    p.add_argument("--version", action="version", version=f"csa {__version__}")
    sub = p.add_subparsers(dest="command", metavar="command", required=True)

    h = sub.add_parser("harvest", help="run scripted sources and write data/harvest/<source>.jsonl",
                       description="Run a scripted source (or all enabled ones). Output is only replaced when the run finishes well.")
    h.add_argument("source", nargs="?", help="a source id from data/sources.yaml, or 'all'")
    h.add_argument("--store", action="store_true",
                   help="only the store events (data/store, not committed) of the sources that list them, and only if "
                        "that was not already done today. Without a source it means 'all'.")
    h.add_argument("--refresh", action="store_true", help="ignore cached pages and fetch again")
    h.add_argument("--fixture-dir", help="serve pages from this folder instead of the network (for developing a source)")

    r = sub.add_parser("import-research", help="validate research agent files and file the good records",
                       description="Reads research/inbox/<wave>/*.json, repairs small mistakes, writes data/research/<wave>.jsonl "
                                   "and research/inbox/<wave>/_rejected.jsonl.")
    r.add_argument("wave")

    i = sub.add_parser("import-issues", help="turn open GitHub issues into a review queue",
                       description="Reads open issues labeled add-show, fix-show, organizer and removal, and writes "
                                   "data/submissions/pending/*.json. Move a file to data/submissions/approved/ to publish it.")
    i.add_argument("--repo", default="holdTheDoorHoid/card-show-atlas")
    i.add_argument("--from-file", help="read issues from a JSON file instead of GitHub (for offline work)")

    sub.add_parser("merge", help="dedupe and combine all sources into shows, series, promoters and store events")

    g = sub.add_parser("geocode", help="fill coordinates, precision and time zone",
                       description="US Census batch geocoder, then Nominatim (1 request per second), then postal and town centres. "
                                   "Answers are cached in data/geocache.json.")
    g.add_argument("--limit", type=int, help="ask Nominatim at most this many times in one run")

    e = sub.add_parser("estimate", help="write the crowd estimate on every show",
                       description="The crowd model of DESIGN section 4, using data/model/priors.json.")
    e.add_argument("--calibrate", action="store_true", help="print the attendees per table fitted from the data, and change nothing")

    c = sub.add_parser("check", help="run the data rules; errors block the build")
    c.add_argument("--strict", action="store_true", help="treat warnings as errors")
    c.add_argument("--quiet", action="store_true", help="only print errors and the summary")

    sub.add_parser("build", help="write the site data files into site/public/data/ (stops if csa check finds errors)")

    po = sub.add_parser("postal", help="download GeoNames postal codes and write data/postal/US.json and CA.json")
    po.add_argument("--refresh", action="store_true", help="ignore the cached download")

    st = sub.add_parser("stats", help="counts, and what upcoming shows are missing")
    st.add_argument("--json", action="store_true", help="print JSON instead of text")

    ns = sub.add_parser("new-source", help="start a new scripted source: writes the module and prints the registry entry")
    ns.add_argument("source_id")
    ns.add_argument("--name", required=True)
    ns.add_argument("--url", required=True)
    return p


def _vocab(paths: Paths) -> Vocab:
    return Vocab.load(paths.vocab)


def cmd_harvest(a, paths: Paths) -> int:
    from . import harvest
    from .http import FixtureTransport
    vocab = _vocab(paths)
    if a.source is None:
        if not a.store:
            print("csa harvest: give a source id, or 'all' (or use --store)", file=sys.stderr)
            return 2
        a.source = "all"
    kw: dict = {"refresh": a.refresh}
    if a.fixture_dir:
        kw.update(transport=FixtureTransport(Path(a.fixture_dir)), http_options={"sleep": lambda s: None},
                  force_disabled=True)
    if a.source == "all":
        results = harvest.run_all(paths, vocab, store_only=a.store, **kw)
    else:
        try:
            results = [harvest.run_source(paths, a.source, vocab, store_only=a.store, **kw)]
        except KeyError as exc:  # an unknown source id
            print(f"csa harvest: {exc.args[0]}", file=sys.stderr)
            return 2
    for res in results:
        print(res.line())
        for reason in res.skip_reasons:
            print(f"    skipped: {reason}")
        for refused in res.refused:
            print(f"    refused: {refused}")
        for note in res.notes[:40]:
            print(f"    note: {note}")
        if len(res.notes) > 40:
            print(f"    and {len(res.notes) - 40} more notes")
        if res.status == "disabled" and a.source != "all":
            print("    (use --fixture-dir to run it offline, or set enabled: true in data/sources.yaml)")
    bad = [r for r in results if not r.ok]
    if bad:
        print(f"{len(bad)} source(s) did not finish: " + ", ".join(f"{r.source_id} ({r.status})" for r in bad), file=sys.stderr)
        return 3
    return 0


def cmd_import_research(a, paths: Paths) -> int:
    from . import research
    rep = research.import_wave(paths, a.wave, _vocab(paths))
    print("\n".join(rep.lines()))
    return 0


def cmd_import_issues(a, paths: Paths) -> int:
    from . import issues
    fetcher, listed = None, None
    if a.from_file:
        listed = json.loads(Path(a.from_file).read_text())
    rep = issues.import_issues(paths, _vocab(paths), fetcher, repo=a.repo, issues=listed)
    print("\n".join(rep.lines()))
    return 0


def cmd_merge(a, paths: Paths) -> int:
    from . import merge
    rep = merge.run_merge(paths, _vocab(paths))
    print("\n".join(rep.lines()))
    return 0


def cmd_geocode(a, paths: Paths) -> int:
    from . import geocode
    services, clients = geocode.make_services()
    try:
        rep = geocode.run_geocode(paths, services, limit=a.limit)
    finally:
        for c in clients:
            c.close()
    print("\n".join(rep.lines()))
    return 0


def cmd_estimate(a, paths: Paths) -> int:
    from . import estimate
    if a.calibrate:
        print("\n".join(estimate.run_calibrate(paths)))
        return 0
    rep = estimate.run_estimate(paths)
    print("\n".join(rep.lines()))
    return 0


def cmd_check(a, paths: Paths) -> int:
    from . import check
    from .check import ERROR
    rep = check.run_check(paths, _vocab(paths))
    lines = rep.lines(limit=500)
    if a.quiet:
        lines = [l for l in lines if not l.startswith("WARNING")]
    print("\n".join(lines))
    if rep.errors or (a.strict and rep.warnings):
        return 1
    return 0


def cmd_build(a, paths: Paths) -> int:
    from . import build
    try:
        rep = build.run_build(paths, _vocab(paths))
    except build.BuildBlocked as blocked:
        print("\n".join(blocked.report.lines()), file=sys.stderr)
        print("Nothing was built.", file=sys.stderr)
        return 1
    print("\n".join(rep.lines()))
    return 0


def cmd_postal(a, paths: Paths) -> int:
    from . import postal
    rep = postal.run_postal(paths, refresh=a.refresh)
    print("\n".join(rep.lines()))
    return 0


def cmd_stats(a, paths: Paths) -> int:
    from . import stats
    data = stats.run_stats(paths)
    print(json.dumps(data, indent=1) if a.json else "\n".join(stats.render(data)))
    return 0


def cmd_new_source(a, paths: Paths) -> int:
    from . import harvest
    from .util import today
    module, snippet = harvest.scaffold_source(paths, a.source_id, a.name, a.url, today())
    print(f"Wrote {module}")
    print("Add this to data/sources.yaml, and fill in the terms you checked:\n")
    print(snippet)
    print(f"Then try it offline against saved pages: csa harvest {a.source_id} --fixture-dir <folder>")
    return 0


COMMANDS = {
    "harvest": cmd_harvest, "import-research": cmd_import_research, "import-issues": cmd_import_issues,
    "merge": cmd_merge, "geocode": cmd_geocode, "estimate": cmd_estimate, "check": cmd_check, "build": cmd_build,
    "postal": cmd_postal, "stats": cmd_stats, "new-source": cmd_new_source,
}


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.today:
        os.environ["CSA_TODAY"] = args.today
    paths = Paths(find_root(args.root))
    try:
        return COMMANDS[args.command](args, paths)
    except (FileNotFoundError, ValueError, FileExistsError) as exc:
        print(f"csa {args.command}: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
