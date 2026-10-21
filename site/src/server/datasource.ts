// Decides where the site's data comes from, and enforces the sample data safety rule.
//
//   real     site/public/data/shows.json from the pipeline (csa build)
//   fixture  made-up sample shows from site/fixtures/data, only for `npm run dev` and tests
//   empty    nothing yet: the site builds with a "Shows are being added" empty state
//
// A production build (mode "build") never uses fixtures and fails if the data it finds looks like
// sample data. This file uses Node's fs and must not be imported by browser code.
import fs from 'node:fs';
import path from 'node:path';
import { fixtureProblems, FixtureInProductionError } from '../lib/guard.ts';
import { recordsFrom } from '../lib/normalize.ts';

export type DataKind = 'real' | 'fixture' | 'empty';
export type BuildMode = 'dev' | 'build';

export interface DataSource {
  kind: DataKind;
  /** directory holding shows.json and friends; null when empty */
  dir: string | null;
}

export function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const SHOW_KEYS = ['shows', 'items', 'records', 'events'];

/** Everything in a data folder that could hold sample shows: the shows file and the store events file. */
function recordsIn(dir: string): unknown[] {
  return [
    ...recordsFrom(readJsonFile(path.join(dir, 'shows.json')), SHOW_KEYS),
    ...recordsFrom(readJsonFile(path.join(dir, 'store_events.json')), SHOW_KEYS),
  ];
}

export function resolveDataSource(opts: { root: string; mode: BuildMode }): DataSource {
  const publicDir = path.join(opts.root, 'public', 'data');
  const fixturesDir = path.join(opts.root, 'fixtures', 'data');
  if (fs.existsSync(path.join(publicDir, 'shows.json'))) {
    const manifest = readJsonFile(path.join(publicDir, 'manifest.json'));
    const problems = fixtureProblems(manifest as { fixture?: unknown } | null, recordsIn(publicDir));
    if (problems.length > 0) {
      if (opts.mode === 'build') throw new FixtureInProductionError(problems);
      return { kind: 'fixture', dir: publicDir };
    }
    return { kind: 'real', dir: publicDir };
  }
  if (opts.mode === 'dev' && fs.existsSync(path.join(fixturesDir, 'shows.json'))) {
    return { kind: 'fixture', dir: fixturesDir };
  }
  return { kind: 'empty', dir: null };
}
