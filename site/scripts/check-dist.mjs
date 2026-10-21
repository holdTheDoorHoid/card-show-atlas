// Runs after `astro build`. Fails the build when anything in dist/ looks like sample data, as a
// second line of defence behind prepare-data.mjs: sample shows must never be published.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { looksLikeFixtureShow } from '../src/lib/guard.ts';

const root = process.env.CSA_SITE_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const problems = [];

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('check-dist: dist/index.html is missing, the build did not produce a site.');
  process.exit(1);
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

let pages = 0;
for (const file of walk(dist)) {
  const rel = path.relative(dist, file);
  if (rel.endsWith('.html')) {
    pages++;
    // The sample data banner is only ever rendered for sample data.
    if (fs.readFileSync(file, 'utf8').includes('data-sample-banner')) problems.push(`${rel}: has the sample data banner`);
  } else if (rel.startsWith(`data${path.sep}`) && rel.endsWith('.json')) {
    let json;
    try {
      json = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (json && json.fixture === true) problems.push(`${rel}: fixture is true`);
    const list = Array.isArray(json) ? json : Array.isArray(json?.shows) ? json.shows : [];
    const bad = list.filter(looksLikeFixtureShow).length;
    if (bad > 0) problems.push(`${rel}: ${bad} records look like sample shows`);
  }
}
if (fs.existsSync(path.join(dist, 'shows'))) {
  for (const name of fs.readdirSync(path.join(dist, 'shows'))) {
    if (name.startsWith('sample-')) problems.push(`shows/${name}: a page for a sample show`);
  }
}

if (problems.length > 0) {
  console.error('check-dist: SAMPLE DATA FOUND IN THE BUILD. This must never be published.');
  for (const p of problems.slice(0, 20)) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`check-dist: ${pages} pages checked, no sample data found.`);
