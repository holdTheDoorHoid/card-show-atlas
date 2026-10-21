import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateFixtures } from '../../fixtures/make-fixtures.mjs';
import { looksLikeFixtureShow } from './guard.ts';
import { buildIndex, splitStoreEvents } from './index-build.ts';
import { normalizeShows, validateShowRecord } from './normalize.ts';
import { lookupInTable, parsePostalInput, type PostalTable } from './postal.ts';
import { EVENT_TYPES } from './types.ts';
import { allVocabEntries, DEFAULT_VOCAB, normalizeVocab } from './vocab.ts';

const files = generateFixtures({ base: '2026-10-21' });
const shows = files['shows.json'] as Record<string, any>[];
const stores = files['store_events.json'] as Record<string, any>[];
const vocabIds = new Set(allVocabEntries(DEFAULT_VOCAB).map((v) => v.id));

describe('the sample data follows DATA_MODEL', () => {
  it('has a few hundred shows across many states and provinces', () => {
    expect(shows.length).toBeGreaterThanOrEqual(300);
    const regions = new Set(shows.map((s) => `${s.venue.country}:${s.venue.region}`));
    expect(regions.size).toBeGreaterThanOrEqual(40);
    expect([...regions].filter((r) => r.startsWith('CA:')).length).toBeGreaterThanOrEqual(8);
  });

  it('every record passes the DATA_MODEL checks', () => {
    for (const s of [...shows, ...stores]) {
      const problems = validateShowRecord(s, vocabIds);
      expect(problems, `${s.id}: ${problems.join('; ')}`).toEqual([]);
    }
  });

  it('every name starts with Sample, so nobody can take a sample for a real show', () => {
    for (const s of [...shows, ...stores]) {
      expect(s.name.startsWith('Sample'), s.name).toBe(true);
      expect(s.venue.name.startsWith('Sample'), s.venue.name).toBe(true);
      expect(looksLikeFixtureShow(s)).toBe(true);
    }
    for (const sr of files['series.json'] as { name: string }[]) expect(sr.name.startsWith('Sample')).toBe(true);
    for (const p of files['promoters.json'] as { name: string }[]) expect(p.name.startsWith('Sample')).toBe(true);
  });

  it('links only go to example.com', () => {
    const urls = new Set<string>();
    JSON.stringify([shows, stores], (_k, v) => {
      if (typeof v === 'string' && /^https?:\/\//.test(v)) urls.add(new URL(v).hostname);
      return v;
    });
    expect([...urls]).toEqual(['example.com']);
  });

  it('is marked as sample data in the manifest', () => {
    const m = files['manifest.json'] as { fixture: boolean; sources: { id: string }[] };
    expect(m.fixture).toBe(true);
    const ids = new Set(m.sources.map((s) => s.id));
    for (const s of shows) for (const src of s.sources) expect(ids.has(src.source)).toBe(true);
  });

  it('covers all five event types, with store events kept apart', () => {
    const types = new Set([...shows, ...stores].map((s) => s.event_type));
    expect([...types].sort()).toEqual([...EVENT_TYPES].sort());
    expect(shows.every((s) => s.event_type !== 'store_event')).toBe(true);
    expect(stores.every((s) => s.event_type === 'store_event')).toBe(true);
    expect(stores.length).toBeGreaterThanOrEqual(30);
  });

  it('covers the variety the site has to handle', () => {
    const has = (pred: (s: Record<string, any>) => boolean) => shows.some(pred);
    expect(has((s) => s.days.length > 1)).toBe(true);
    expect(has((s) => s.days.length === 1)).toBe(true);
    expect(has((s) => s.vendor.tables.length > 0)).toBe(true);
    expect(has((s) => s.vendor.tables.length === 0)).toBe(true);
    for (const status of ['scheduled', 'tentative', 'postponed', 'cancelled']) expect(has((s) => s.status === status), status).toBe(true);
    for (const p of ['address', 'venue', 'postal', 'city']) expect(has((s) => s.venue.geo_precision === p), p).toBe(true);
    for (const v of ['open', 'waitlist', 'sold_out', 'closed', 'unknown']) expect(has((s) => s.vendor.status === v), v).toBe(true);
    for (const v of ['organizer_confirmed', 'listed', 'community', 'unverified']) expect(has((s) => s.verification === v), v).toBe(true);
    for (const c of ['small', 'medium', 'large', 'major']) expect(has((s) => s.estimate?.size_class === c), c).toBe(true);
    expect(has((s) => s.estimate === null)).toBe(true);
    expect(has((s) => s.mix === 'tcg')).toBe(true);
    expect(has((s) => s.mix === 'sports')).toBe(true);
    expect(has((s) => s.mix === 'mixed')).toBe(true);
    expect(has((s) => s.mix === 'unknown')).toBe(true);
    expect(has((s) => s.admission.free === true)).toBe(true);
    expect(has((s) => s.admission.currency === 'CAD')).toBe(true);
    expect(has((s) => s.size.reported_attendance !== null)).toBe(true);
  });

  it('ids are unique and stable in form', () => {
    const ids = shows.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of shows) expect(s.id).toBe(`${s.series_id}-${s.days[0].date}`);
  });

  it('is deterministic for a given base date and moves with the date', () => {
    const again = generateFixtures({ base: '2026-10-21' });
    expect(JSON.stringify(again['shows.json'])).toBe(JSON.stringify(shows));
    const later = generateFixtures({ base: '2026-11-21' }) as typeof files;
    expect((later['shows.json'] as Record<string, any>[])[0]?.days[0].date).not.toBe(shows[0]?.days[0].date);
  });

  it('all normalize cleanly into the site index', () => {
    const { shows: normalized, dropped } = normalizeShows(shows);
    expect(dropped).toBe(0);
    expect(normalized).toHaveLength(shows.length);
    const index = buildIndex(splitStoreEvents(normalized).shows, normalizeVocab(files['vocab.json']), { generated: 'x', fixture: true });
    expect(index.count).toBe(shows.length);
    expect(index.rows.every((r) => r.ll !== undefined)).toBe(true);
  });

  it('the committed fixture files are in step with the generator', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../fixtures/data/manifest.json'), 'utf8'));
    expect(manifest.fixture).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(path.join(__dirname, '../../fixtures/data/shows.json'), 'utf8'));
    const regenerated = generateFixtures({ base: manifest.fixture_base })['shows.json'];
    expect(onDisk).toEqual(regenerated);
  });
});

describe('the sample postal files', () => {
  const us = files['postal/US.json'] as PostalTable;
  const ca = files['postal/CA.json'] as PostalTable;

  it('are small and use the documented format', () => {
    expect(Object.keys(us).length).toBeGreaterThan(50);
    expect(Object.keys(ca).length).toBeGreaterThan(10);
    for (const [k, v] of Object.entries(us)) {
      expect(k).toMatch(/^\d{5}$/);
      expect(v).toHaveLength(2);
    }
    for (const k of Object.keys(ca)) expect(k).toMatch(/^[A-Z]\d[A-Z]$/);
  });

  it('find the town of every sample show', () => {
    for (const s of shows) {
      const q = parsePostalInput(s.venue.postal ?? '');
      if (!q) continue; // shows located by city have no code
      expect(lookupInTable(s.venue.country === 'CA' ? ca : us, q), s.venue.postal).not.toBeNull();
    }
  });
});
