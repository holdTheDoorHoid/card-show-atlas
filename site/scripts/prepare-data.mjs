// Runs before `astro dev` and `astro build`. It
//   1. decides where the data comes from (real pipeline output, sample fixtures in dev, or nothing),
//   2. refuses to continue in a production build if the data looks like sample data,
//   3. writes the compact client index (index.json) and the store events index (store_index.json).
//
// Usage: node scripts/prepare-data.mjs --dev | --build
//
// Real data is read from public/data/shows.json (written by the pipeline). In dev with no real data,
// the sample data in fixtures/data is used and its derived files are written next to it. In a
// production build with no real data, an empty index is written and the site shows its empty state.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFixtures } from '../fixtures/make-fixtures.mjs';
import { FixtureInProductionError } from '../src/lib/guard.ts';
import { buildIndex, emptyIndex, splitStoreEvents } from '../src/lib/index-build.ts';
import { normalizeShows, recordsFrom } from '../src/lib/normalize.ts';
import { normalizeVocab } from '../src/lib/vocab.ts';
import { readJsonFile, resolveDataSource } from '../src/server/datasource.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv.includes('--build') ? 'build' : 'dev';
const publicDir = path.join(root, 'public', 'data');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function fail(message) {
  console.error(`prepare-data: ${message}`);
  process.exit(1);
}

/** In dev, regenerate the sample dates when they have gone stale, so the lists are not empty. */
function refreshFixturesIfStale() {
  const manifestFile = path.join(root, 'fixtures', 'data', 'manifest.json');
  const manifest = readJsonFile(manifestFile);
  const today = new Date().toISOString().slice(0, 10);
  const base = manifest && typeof manifest.fixture_base === 'string' ? manifest.fixture_base : null;
  const age = base ? (Date.parse(today) - Date.parse(base)) / 86400000 : Infinity;
  if (age > 14 || age < 0) {
    writeFixtures({ base: today });
    console.log(`prepare-data: sample data was ${base ?? 'missing'}, regenerated for ${today}.`);
  }
}

let source;
try {
  if (mode === 'dev') {
    // Only look at fixtures when there is no real data.
    if (!fs.existsSync(path.join(publicDir, 'shows.json'))) refreshFixturesIfStale();
  }
  source = resolveDataSource({ root, mode });
} catch (err) {
  if (err instanceof FixtureInProductionError) fail(err.message);
  throw err;
}

const generated = new Date().toISOString();

if (source.kind === 'empty' || !source.dir) {
  const vocab = normalizeVocab(null);
  writeJson(path.join(publicDir, 'index.json'), emptyIndex(vocab, generated));
  writeJson(path.join(publicDir, 'store_index.json'), emptyIndex(vocab, generated));
  console.log(
    mode === 'build'
      ? 'prepare-data: no shows.json in public/data, so the site will build with its empty state ("Shows are being added").'
      : 'prepare-data: no shows.json and no sample data, writing an empty index.',
  );
  process.exit(0);
}

const dir = source.dir;
const fixture = source.kind === 'fixture';
if (fixture && mode === 'build') fail('internal error: sample data selected for a production build.');

const { shows: all, dropped } = normalizeShows(readJsonFile(path.join(dir, 'shows.json')));
const rawStore = recordsFrom(readJsonFile(path.join(dir, 'store_events.json')), ['events', 'store_events', 'shows', 'items', 'records']);
const { shows: storeFromFile } = normalizeShows(rawStore);
const split = splitStoreEvents(all);
const storeEvents = [...split.storeEvents, ...storeFromFile.filter((s) => !split.storeEvents.some((x) => x.id === s.id))].filter((s) => s.event_type === 'store_event');
const shows = split.shows;

if (all.length === 0 && dropped > 0) {
  fail(`shows.json has ${dropped} records but none could be read. Check them against docs/DATA_MODEL.md section 2.`);
}
if (dropped > 0) console.warn(`prepare-data: warning, ${dropped} records in shows.json were skipped (missing id, name, type, dates or place).`);

const vocab = normalizeVocab(readJsonFile(path.join(dir, 'vocab.json')));
const manifest = readJsonFile(path.join(dir, 'manifest.json'));
const stamp = manifest && typeof manifest.built === 'string' ? manifest.built : generated;

writeJson(path.join(dir, 'index.json'), buildIndex(shows, vocab, { generated: stamp, fixture }));
writeJson(path.join(dir, 'store_index.json'), buildIndex(storeEvents, vocab, { generated: stamp, fixture, withLink: true }));

const indexBytes = fs.statSync(path.join(dir, 'index.json')).size;
console.log(
  `prepare-data: ${source.kind} data from ${path.relative(root, dir)}: ${shows.length} shows (index ${(indexBytes / 1024).toFixed(0)} KB), ${storeEvents.length} store events.` +
    (fixture ? ' SAMPLE DATA: dev and tests only, never published.' : ''),
);
