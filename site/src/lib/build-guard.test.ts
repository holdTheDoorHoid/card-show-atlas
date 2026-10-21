// End to end checks of the production build's sample data guard: the real scripts, run on a
// throwaway site folder.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tempSite(files: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'csa-build-'));
  dirs.push(root);
  for (const [rel, data] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  }
  return root;
}

function run(script: string, args: string[], root: string) {
  return spawnSync('node', [path.join(siteRoot, 'scripts', script), ...args], { env: { ...process.env, CSA_SITE_ROOT: root }, encoding: 'utf8' });
}

const sampleShow = { id: 'sample-a-2026-11-14', series_id: 'sample-a', name: 'Sample A Card Show', event_type: 'card_show', days: [{ date: '2026-11-14' }], venue: { name: 'Sample Hall', city: 'Edison', region: 'NJ', lat: 40.5, lon: -74.4 }, sources: [{ source: 'fixture' }] };
const realShow = { id: 'garden-state-2026-11-14', series_id: 'garden-state', name: 'Garden State Card Show', event_type: 'card_show', days: [{ date: '2026-11-14' }], venue: { name: 'Expo Hall', city: 'Edison', region: 'NJ', lat: 40.5, lon: -74.4 }, sources: [{ source: 'example_calendar' }] };

describe('prepare-data in a production build', () => {
  it('builds an empty index when there is no data, even if sample data sits in fixtures/', () => {
    const root = tempSite({ 'fixtures/data/shows.json': [sampleShow] });
    const r = run('prepare-data.mjs', ['--build'], root);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/empty state/);
    const index = JSON.parse(fs.readFileSync(path.join(root, 'public/data/index.json'), 'utf8'));
    expect(index).toMatchObject({ count: 0, rows: [], fixture: false });
    expect(fs.existsSync(path.join(root, 'public/data/shows.json'))).toBe(false); // nothing was copied in
  });

  it('refuses sample data found in public/data', () => {
    const root = tempSite({ 'public/data/shows.json': [sampleShow], 'public/data/manifest.json': { fixture: true } });
    const r = run('prepare-data.mjs', ['--build'], root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Sample data found/);
    expect(r.stderr).toMatch(/never reach the public site/);
  });

  it('refuses sample shows even when the manifest does not say so', () => {
    const root = tempSite({ 'public/data/shows.json': [sampleShow] });
    expect(run('prepare-data.mjs', ['--build'], root).status).toBe(1);
  });

  it('writes the compact index for real data', () => {
    const root = tempSite({ 'public/data/shows.json': [realShow], 'public/data/manifest.json': { built: '2026-10-21T00:00:00Z', fixture: false } });
    const r = run('prepare-data.mjs', ['--build'], root);
    expect(r.status).toBe(0);
    const index = JSON.parse(fs.readFileSync(path.join(root, 'public/data/index.json'), 'utf8'));
    expect(index).toMatchObject({ count: 1, fixture: false, generated: '2026-10-21T00:00:00Z' });
    expect(index.rows[0]).toMatchObject({ i: 'garden-state-2026-11-14', n: 'Garden State Card Show', r: 'NJ' });
  });

  it('stops when shows.json has records but none can be read', () => {
    const root = tempSite({ 'public/data/shows.json': [{ nonsense: true }, { id: 'x' }] });
    const r = run('prepare-data.mjs', ['--build'], root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/none could be read/);
  });
});

describe('check-dist after a build', () => {
  const page = '<!doctype html><title>x</title>';

  it('passes a clean site', () => {
    const root = tempSite({ 'dist/index.html': page, 'dist/data/index.json': { fixture: false, rows: [] }, 'dist/shows/garden-state-2026-11-14/index.html': page });
    expect(run('check-dist.mjs', [], root).status).toBe(0);
  });

  it('fails when a page carries the sample data banner', () => {
    const root = tempSite({ 'dist/index.html': '<div data-sample-banner>SAMPLE</div>' });
    const r = run('check-dist.mjs', [], root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/SAMPLE DATA FOUND/);
  });

  it('fails when a data file is marked as a fixture or holds sample shows', () => {
    expect(run('check-dist.mjs', [], tempSite({ 'dist/index.html': page, 'dist/data/index.json': { fixture: true } })).status).toBe(1);
    expect(run('check-dist.mjs', [], tempSite({ 'dist/index.html': page, 'dist/data/shows.json': [sampleShow] })).status).toBe(1);
  });

  it('fails when there is a page for a sample show', () => {
    expect(run('check-dist.mjs', [], tempSite({ 'dist/index.html': page, 'dist/shows/sample-a-2026-11-14/index.html': page })).status).toBe(1);
  });

  it('fails when nothing was built', () => {
    expect(run('check-dist.mjs', [], tempSite({ 'dist/readme.txt': 'x' })).status).toBe(1);
  });
});
