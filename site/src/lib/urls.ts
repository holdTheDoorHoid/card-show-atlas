// Links that include the site's base path (/card-show-atlas) and the issue form links.
import { BASE_PATH, GITHUB_REPO, SITE_ORIGIN } from './config.ts';

function readBase(): string {
  const env = (import.meta as unknown as { env?: { BASE_URL?: string } }).env;
  return env?.BASE_URL ?? BASE_PATH;
}

/** The base path without a trailing slash: "/card-show-atlas", or "" at the root. */
export function basePath(base: string = readBase()): string {
  const trimmed = base.replace(/\/+$/, '');
  return trimmed === '' ? '' : trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/** A site path with the base in front: withBase('shows/x/') gives "/card-show-atlas/shows/x/". */
export function withBase(path: string, base?: string): string {
  const clean = path.replace(/^\/+/, '');
  return `${basePath(base)}/${clean}`;
}

/** The full public URL of a site path. */
export function absoluteUrl(path: string): string {
  return `${SITE_ORIGIN}${withBase(path, BASE_PATH)}`;
}

export function showPath(id: string): string {
  return `shows/${encodeURIComponent(id)}/`;
}

export function dataUrl(file: string): string {
  return withBase(`data/${file}`);
}

export type IssueTemplate = 'add-show.yml' | 'fix-show.yml' | 'organizer.yml' | 'remove.yml';

/**
 * A link to a GitHub issue form, with some fields filled in. GitHub fills a form field from a query
 * parameter named after the field's id.
 */
export function issueFormUrl(template: IssueTemplate, fields: Record<string, string> = {}, title?: string): string {
  const params = new URLSearchParams({ template });
  if (title) params.set('title', title);
  for (const [k, v] of Object.entries(fields)) params.set(k, v);
  return `https://github.com/${GITHUB_REPO}/issues/new?${params.toString()}`;
}

export function fixShowUrl(showId: string, showName: string): string {
  return issueFormUrl('fix-show.yml', { page: absoluteUrl(showPath(showId)) }, `Fix show: ${showName}`);
}

export function removeShowUrl(showId: string, showName: string): string {
  return issueFormUrl('remove.yml', { page: absoluteUrl(showPath(showId)) }, `Remove: ${showName}`);
}
