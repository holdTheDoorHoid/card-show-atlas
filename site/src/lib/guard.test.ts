import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveDataSource } from '../server/datasource.ts';
import { loadSiteDataFrom } from '../server/data.ts';
import { assertNoFixtures, FixtureInProductionError, fixtureProblems, looksLikeFixtureShow, manifestSaysFixture } from './guard.ts';
import { makeShow } from './testing.ts';

const sampleRecord = { name: 'Sample Edison Card Show', venue: { name: 'Sample Expo Hall' }, sources: [{ source: 'fixture' }] };
const realRecord = { name: 'Garden State Card Show', venue: { name: 'Example Expo Hall' }, sources: [{ source: 'example_calendar' }] };

describe('recognising sample data', () => {
  it('spots sample shows by their source or by Sample at both the show and the venue', () => {
    expect(looksLikeFixtureShow(sampleRecord)).toBe(true);
    expect(looksLikeFixtureShow({ name: 'Sample X', venue: { name: 'Sample Hall' } })).toBe(true);
    expect(looksLikeFixtureShow({ name: 'Anything', sources: [{ source: 'fixture' }] })).toBe(true);
  });

  it('does not flag real shows, even ones with Sample in the name', () => {
    expect(looksLikeFixtureShow(realRecord)).toBe(false);
    expect(looksLikeFixtureShow({ name: 'Sample Road Card Show', venue: { name: 'Fire Hall' }, sources: [{ source: 'x' }] })).toBe(false);
    expect(looksLikeFixtureShow(null)).toBe(false);
    expect(looksLikeFixtureShow('Sample')).toBe(false);
  });

  it('reads the manifest flag', () => {
    expect(manifestSaysFixture({ fixture: true })).toBe(true);
    expect(manifestSaysFixture({ fixture: false })).toBe(false);
    expect(manifestSaysFixture(null)).toBe(false);
  });

  it('lists the reasons', () => {
    expect(fixtureProblems({ fixture: true }, [sampleRecord, sampleRecord])).toEqual(['manifest.json says fixture: true', '2 records look like sample shows']);
    expect(fixtureProblems({ fixture: false }, [realRecord])).toEqual([]);
  });

  it('throws a plain error for sample data', () => {
    expect(() => assertNoFixtures({ fixture: true }, [])).toThrow(FixtureInProductionError);
    expect(() => assertNoFixtures(null, [realRecord])).not.toThrow();
    try {
      assertNoFixtures(null, [sampleRecord]);
    } catch (e) {
      expect((e as Error).message).toMatch(/must never reach the public site/);
    }
  });
});

describe('where the data comes from', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function makeRoot(files: Record<string, unknown>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'csa-guard-'));
    dirs.push(root);
    for (const [rel, data] of Object.entries(files)) {
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data));
    }
    return root;
  }

  const fixtureShows = [sampleRecord];
  const realShows = [realRecord];

  it('uses real data from public/data when it is there', () => {
    const root = makeRoot({ 'public/data/shows.json': realShows, 'public/data/manifest.json': { fixture: false } });
    for (const mode of ['dev', 'build'] as const) {
      expect(resolveDataSource({ root, mode })).toEqual({ kind: 'real', dir: path.join(root, 'public', 'data') });
    }
  });

  it('uses sample data only in dev, and only when there is no real data', () => {
    const root = makeRoot({ 'fixtures/data/shows.json': fixtureShows });
    expect(resolveDataSource({ root, mode: 'dev' })).toEqual({ kind: 'fixture', dir: path.join(root, 'fixtures', 'data') });
  });

  it('a production build with no real data is empty, never sample data', () => {
    const root = makeRoot({ 'fixtures/data/shows.json': fixtureShows });
    expect(resolveDataSource({ root, mode: 'build' })).toEqual({ kind: 'empty', dir: null });
    const nothing = makeRoot({});
    expect(resolveDataSource({ root: nothing, mode: 'build' })).toEqual({ kind: 'empty', dir: null });
  });

  it('a production build fails if public/data holds sample data (manifest flag)', () => {
    const root = makeRoot({ 'public/data/shows.json': realShows, 'public/data/manifest.json': { fixture: true } });
    expect(() => resolveDataSource({ root, mode: 'build' })).toThrow(FixtureInProductionError);
  });

  it('a production build fails if public/data holds sample shows even without the flag', () => {
    const root = makeRoot({ 'public/data/shows.json': fixtureShows });
    expect(() => resolveDataSource({ root, mode: 'build' })).toThrow(FixtureInProductionError);
  });

  it('a production build fails if only the store events file holds sample data', () => {
    const root = makeRoot({ 'public/data/shows.json': realShows, 'public/data/store_events.json': fixtureShows });
    expect(() => resolveDataSource({ root, mode: 'build' })).toThrow(FixtureInProductionError);
  });

  it('dev treats leftover sample data in public/data as sample data, not real', () => {
    const root = makeRoot({ 'public/data/shows.json': fixtureShows, 'public/data/manifest.json': { fixture: true } });
    expect(resolveDataSource({ root, mode: 'dev' }).kind).toBe('fixture');
  });

  it('the page data loader marks sample data and builds an empty site for no data', () => {
    const empty = loadSiteDataFrom(makeRoot({ 'fixtures/data/shows.json': [makeShow()] }), 'build');
    expect(empty.empty).toBe(true);
    expect(empty.fixture).toBe(false);
    expect(empty.shows).toEqual([]);
    const dev = loadSiteDataFrom(makeRoot({ 'fixtures/data/shows.json': [makeShow()] }), 'dev');
    expect(dev.fixture).toBe(true);
    expect(dev.manifest.fixture).toBe(true);
    expect(dev.shows).toHaveLength(1);
    expect(() => loadSiteDataFrom(makeRoot({ 'public/data/shows.json': [makeShow()] }), 'build')).toThrow(FixtureInProductionError);
  });
});
