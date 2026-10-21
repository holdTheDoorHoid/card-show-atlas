// Build time data for Astro pages: reads shows.json and friends once and derives the pages' views
// (series, promoters, states). Node only. Pages call loadSiteData(); nothing here runs in the browser.
import path from 'node:path';
import { slugify } from '../lib/format.ts';
import { normalizeShows, recordsFrom } from '../lib/normalize.ts';
import { regionSlug } from '../lib/regions.ts';
import { normalizeVocab } from '../lib/vocab.ts';
import type { Manifest, ManifestSource, PromoterRecord, SeriesRecord, Show, Vocab } from '../lib/types.ts';
import { readJsonFile, resolveDataSource, type BuildMode, type DataKind } from './datasource.ts';

export interface SeriesView {
  id: string;
  name: string;
  promoterId: string | null;
  promoterName: string | null;
  cadence: string | null;
  usualVenue: string | null;
  links: SeriesRecord['links'];
  history: SeriesRecord['history'];
  /** editions that have a page on this site, oldest first */
  editions: Show[];
}

export interface PromoterView {
  id: string;
  name: string;
  url: string | null;
  region: string | null;
  publicContact: string | null;
  series: SeriesView[];
  shows: Show[];
}

export interface RegionView {
  slug: string;
  country: string;
  code: string;
  shows: Show[];
}

export interface SiteData {
  kind: DataKind;
  fixture: boolean;
  empty: boolean;
  manifest: Manifest;
  vocab: Vocab;
  shows: Show[];
  byId: Map<string, Show>;
  series: SeriesView[];
  promoters: PromoterView[];
  regions: RegionView[];
  sourceById: Map<string, ManifestSource>;
  dropped: number;
}

const cache = new Map<string, SiteData>();

function normalizeManifest(raw: unknown, fixture: boolean): Manifest {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const rawSources = Array.isArray(o.sources)
    ? o.sources
    : o.sources && typeof o.sources === 'object'
      ? Object.entries(o.sources as Record<string, unknown>).map(([id, v]) => ({ id, ...(v as object) }))
      : [];
  const sources: ManifestSource[] = [];
  for (const s of rawSources) {
    if (!s || typeof s !== 'object') continue;
    const r = s as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id : typeof r.source === 'string' ? r.source : '';
    if (!id) continue;
    sources.push({
      id,
      name: typeof r.name === 'string' ? r.name : id,
      url: typeof r.url === 'string' ? r.url : null,
      kind: typeof r.kind === 'string' ? r.kind : null,
      credit: typeof r.credit === 'string' ? r.credit : null,
    });
  }
  const counts = o.counts && typeof o.counts === 'object' ? (o.counts as Manifest['counts']) : null;
  return {
    built: typeof o.built === 'string' ? o.built : typeof o.built_at === 'string' ? o.built_at : null,
    fixture: fixture || o.fixture === true,
    counts,
    sources,
  };
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function buildSeries(shows: Show[], rawSeries: unknown[], promoterNames: Map<string, string>): SeriesView[] {
  const meta = new Map<string, Record<string, unknown>>();
  for (const r of rawSeries) if (r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string') meta.set((r as { id: string }).id, r as Record<string, unknown>);
  const groups = new Map<string, Show[]>();
  for (const s of shows) {
    const g = groups.get(s.series_id);
    if (g) g.push(s);
    else groups.set(s.series_id, [s]);
  }
  const out: SeriesView[] = [];
  for (const [id, editions] of groups) {
    editions.sort((a, b) => (a.days[0]?.date ?? '') .localeCompare(b.days[0]?.date ?? ''));
    const m = meta.get(id) ?? {};
    const latest = editions[editions.length - 1] as Show;
    const venue = m.venue && typeof m.venue === 'object' ? (m.venue as Record<string, unknown>) : null;
    const usual = venue
      ? [str(venue.name), str(venue.city), str(venue.region)].filter(Boolean).join(', ')
      : [latest.venue.name, latest.venue.city, latest.venue.region].filter(Boolean).join(', ');
    const promoterId = str(m.promoter_id) ?? latest.organizer.promoter_id ?? (latest.organizer.name ? slugify(latest.organizer.name) : null);
    out.push({
      id,
      name: str(m.name) ?? latest.name,
      promoterId,
      promoterName: promoterId ? (promoterNames.get(promoterId) ?? latest.organizer.name) : null,
      cadence: str(m.cadence),
      usualVenue: usual || null,
      links: m.links && typeof m.links === 'object' ? (m.links as SeriesRecord['links']) : null,
      history: Array.isArray(m.history) ? (m.history as SeriesRecord['history']) : [],
      editions,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function buildPromoters(shows: Show[], series: SeriesView[], rawPromoters: unknown[]): { views: PromoterView[]; names: Map<string, string> } {
  const meta = new Map<string, Record<string, unknown>>();
  for (const r of rawPromoters) if (r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string') meta.set((r as { id: string }).id, r as Record<string, unknown>);
  const names = new Map<string, string>();
  const groups = new Map<string, Show[]>();
  for (const s of shows) {
    const id = s.organizer.promoter_id ?? (s.organizer.name ? slugify(s.organizer.name) : null);
    if (!id) continue;
    if (s.organizer.name && !names.has(id)) names.set(id, s.organizer.name);
    const g = groups.get(id);
    if (g) g.push(s);
    else groups.set(id, [s]);
  }
  for (const [id, m] of meta) {
    const n = str(m.name);
    if (n) names.set(id, n);
  }
  const views: PromoterView[] = [];
  for (const [id, list] of groups) {
    list.sort((a, b) => (a.days[0]?.date ?? '').localeCompare(b.days[0]?.date ?? ''));
    const m = meta.get(id) ?? {};
    const first = list[0] as Show;
    views.push({
      id,
      name: names.get(id) ?? id,
      url: str(m.url) ?? first.organizer.url,
      region: str(m.region),
      publicContact: str(m.public_contact),
      series: series.filter((s) => s.promoterId === id),
      shows: list,
    });
  }
  return { views: views.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)), names };
}

function buildRegions(shows: Show[]): RegionView[] {
  const groups = new Map<string, RegionView>();
  for (const s of shows) {
    const slug = regionSlug(s.venue.country, s.venue.region.toLowerCase().replace(/[^a-z0-9]/g, ''));
    const g = groups.get(slug);
    if (g) g.shows.push(s);
    else groups.set(slug, { slug, country: s.venue.country, code: s.venue.region, shows: [s] });
  }
  for (const g of groups.values()) g.shows.sort((a, b) => (a.days[0]?.date ?? '').localeCompare(b.days[0]?.date ?? '') || a.id.localeCompare(b.id));
  return [...groups.values()].sort((a, b) => a.country.localeCompare(b.country) || a.code.localeCompare(b.code));
}

export function loadSiteDataFrom(root: string, mode: BuildMode): SiteData {
  const key = `${root}|${mode}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const source = resolveDataSource({ root, mode });
  const fixture = source.kind === 'fixture';
  const dir = source.dir;
  const rawShows = dir ? readJsonFile(path.join(dir, 'shows.json')) : null;
  const { shows: allShows, dropped } = normalizeShows(rawShows);
  const shows = allShows.filter((s) => s.event_type !== 'store_event');
  const manifest = normalizeManifest(dir ? readJsonFile(path.join(dir, 'manifest.json')) : null, fixture);
  const vocab = normalizeVocab(dir ? readJsonFile(path.join(dir, 'vocab.json')) : null);
  const rawSeries = dir ? recordsFrom(readJsonFile(path.join(dir, 'series.json')), ['series', 'items', 'records']) : [];
  const rawPromoters = dir ? recordsFrom(readJsonFile(path.join(dir, 'promoters.json')), ['promoters', 'items', 'records']) : [];
  const promoterNames = new Map<string, string>();
  for (const p of rawPromoters as Partial<PromoterRecord>[]) if (p && typeof p.id === 'string' && typeof p.name === 'string') promoterNames.set(p.id, p.name);
  const series = buildSeries(shows, rawSeries, promoterNames);
  const { views: promoters } = buildPromoters(shows, series, rawPromoters);
  const data: SiteData = {
    kind: source.kind,
    fixture,
    empty: shows.length === 0,
    manifest,
    vocab,
    shows,
    byId: new Map(shows.map((s) => [s.id, s])),
    series,
    promoters,
    regions: buildRegions(shows),
    sourceById: new Map(manifest.sources.map((s) => [s.id, s])),
    dropped,
  };
  cache.set(key, data);
  return data;
}

/** The site root: the folder `npm run` was started in (site/). */
export function siteRoot(): string {
  return process.env.CSA_SITE_ROOT ?? process.cwd();
}

export function buildMode(): BuildMode {
  return import.meta.env?.DEV ? 'dev' : 'build';
}

export function loadSiteData(): SiteData {
  return loadSiteDataFrom(siteRoot(), buildMode());
}
