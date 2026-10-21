// The sample data safety rule: sample (fixture) shows must never reach the public site, because
// someone could drive to a show that does not exist. These checks work on data in memory; the
// Node side (src/server/datasource.ts) applies them to files.
import type { Manifest } from './types.ts';

interface Loose {
  name?: unknown;
  venue?: { name?: unknown } | null;
  sources?: { source?: unknown }[] | null;
}

/** The source id the sample data uses in every record. */
export const FIXTURE_SOURCE_ID = 'fixture';

/** A record that looks like sample data: marked by its source, or named "Sample" at a "Sample" venue. */
export function looksLikeFixtureShow(show: unknown): boolean {
  if (!show || typeof show !== 'object') return false;
  const s = show as Loose;
  if (Array.isArray(s.sources) && s.sources.some((x) => x && x.source === FIXTURE_SOURCE_ID)) return true;
  const name = typeof s.name === 'string' ? s.name : '';
  const venue = s.venue && typeof s.venue.name === 'string' ? s.venue.name : '';
  return /^Sample\b/.test(name) && /^Sample\b/.test(venue);
}

export function manifestSaysFixture(manifest: unknown): boolean {
  return !!manifest && typeof manifest === 'object' && (manifest as { fixture?: unknown }).fixture === true;
}

/** Why this data must not be published, or an empty list when it looks real. */
export function fixtureProblems(manifest: Manifest | { fixture?: unknown } | null, records: unknown[]): string[] {
  const problems: string[] = [];
  if (manifestSaysFixture(manifest)) problems.push('manifest.json says fixture: true');
  const bad = records.filter(looksLikeFixtureShow).length;
  if (bad > 0) problems.push(`${bad} record${bad === 1 ? '' : 's'} look like sample shows`);
  return problems;
}

export class FixtureInProductionError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(
      `Sample data found where a production build would publish it (${problems.join('; ')}). ` +
        'Sample shows must never reach the public site. Remove site/public/data and rebuild it with the pipeline (csa build), ' +
        'or run "npm run build" with no data to get the empty state.',
    );
    this.name = 'FixtureInProductionError';
    this.problems = problems;
  }
}

export function assertNoFixtures(manifest: Manifest | { fixture?: unknown } | null, records: unknown[]): void {
  const problems = fixtureProblems(manifest, records);
  if (problems.length > 0) throw new FixtureInProductionError(problems);
}
