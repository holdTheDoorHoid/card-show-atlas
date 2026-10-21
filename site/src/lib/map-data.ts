// Turns index rows into places for the map, and builds the card shown when a marker is tapped.
// Cards are HTML strings (Leaflet popups), so every piece of data goes through escapeHtml.
import { formatRowDate } from './dates.ts';
import { escapeHtml, formatMoney } from './format.ts';
import { EVENT_TYPE_INFO, isApproximate, precisionNote, SHOW_STATUS_LABEL, SIZE_INFO } from './labels.ts';
import type { EventType, IndexRow } from './types.ts';
import { safeUrl } from './format.ts';

export interface Place {
  /** rounded coordinates, shared by every show here */
  key: string;
  lat: number;
  lon: number;
  rows: IndexRow[];
  /** the marker's event type: the soonest show's */
  type: EventType;
  /** true when every show here only has an approximate location */
  soft: boolean;
}

/** Shows at the same venue share one marker. Coordinates are matched to about 10 metres. */
export function groupPlaces(rows: IndexRow[]): Place[] {
  const map = new Map<number, Place>();
  for (const row of rows) {
    if (!row.ll) continue;
    // a number key per place: no strings are built for rows that join a place that already exists
    const num = Math.round(row.ll[0] * 1e4) * 4e6 + Math.round(row.ll[1] * 1e4);
    const place = map.get(num);
    if (place) place.rows.push(row);
    else map.set(num, { key: `${row.ll[0].toFixed(4)},${row.ll[1].toFixed(4)}`, lat: row.ll[0], lon: row.ll[1], rows: [row], type: row.t, soft: isApproximate(row.g) });
  }
  const places = [...map.values()];
  for (const p of places) {
    p.rows.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : a.i < b.i ? -1 : 1));
    p.type = (p.rows[0] as IndexRow).t;
    p.soft = p.rows.every((r) => isApproximate(r.g));
  }
  return places;
}

const MAX_LISTED = 8;

export interface PopupOptions {
  /** site path of a show page, with the base path: (id) => "/card-show-atlas/shows/x/" */
  showHref: (id: string) => string;
  /** link text for the details link */
  isStoreLayer?: boolean;
  /** the current year: dates in other years get the year added */
  refYear?: number;
}

function rowCard(row: IndexRow, opts: PopupOptions): string {
  const info = EVENT_TYPE_INFO[row.t];
  const bits: string[] = [];
  bits.push(`<span class="pop-type">${escapeHtml(info.label)}</span>`);
  if (row.sz) bits.push(`<span class="pop-size">${escapeHtml(SIZE_INFO[row.sz].label)}</span>`);
  if (row.st && row.st !== 'scheduled') bits.push(`<span class="pop-status">${escapeHtml(SHOW_STATUS_LABEL[row.st])}</span>`);
  const entry = row.fr === 1 ? 'Free entry' : row.ad !== undefined ? `Entry ${formatMoney(row.ad, row.cu ?? 'USD')}` : '';
  const official = opts.isStoreLayer ? safeUrl(row.u) : null;
  const href = opts.isStoreLayer ? official : opts.showHref(row.i);
  const link = href
    ? `<a class="pop-link" href="${escapeHtml(href)}"${opts.isStoreLayer ? ' target="_blank" rel="noopener noreferrer"' : ''}>${opts.isStoreLayer ? 'Official page' : 'Show details'}</a>`
    : '';
  return (
    `<div class="pop-card">` +
    `<div class="pop-name">${escapeHtml(row.n)}</div>` +
    `<div class="pop-when">${escapeHtml(formatRowDate(row.d, row.e ?? row.d, opts.refYear))}</div>` +
    `<div class="pop-where">${escapeHtml(row.c)}, ${escapeHtml(row.r)}</div>` +
    `<div class="pop-tags">${bits.join('')}</div>` +
    (entry ? `<div class="pop-entry">${escapeHtml(entry)}</div>` : '') +
    link +
    `</div>`
  );
}

/** The card for a marker: one show in full, or a short list when several shows share a place. */
export function popupHtml(place: Place, opts: PopupOptions): string {
  const note = place.soft ? precisionNote(place.rows[0]?.g ?? 'city') : null;
  const noteHtml = note ? `<p class="pop-note">${escapeHtml(note)}</p>` : '';
  if (place.rows.length === 1) return rowCard(place.rows[0] as IndexRow, opts) + noteHtml;
  const shown = place.rows.slice(0, MAX_LISTED);
  const more = place.rows.length - shown.length;
  const items = shown
    .map((r) => {
      const href = opts.isStoreLayer ? safeUrl(r.u) : opts.showHref(r.i);
      const label = `${escapeHtml(formatRowDate(r.d, r.e ?? r.d, opts.refYear))}: ${escapeHtml(r.n)}`;
      return `<li>${href ? `<a href="${escapeHtml(href)}"${opts.isStoreLayer ? ' target="_blank" rel="noopener noreferrer"' : ''}>${label}</a>` : label}</li>`;
    })
    .join('');
  return (
    `<div class="pop-card"><div class="pop-name">${place.rows.length} shows here</div>` +
    `<div class="pop-where">${escapeHtml((place.rows[0] as IndexRow).c)}, ${escapeHtml((place.rows[0] as IndexRow).r)}</div>` +
    `<ul class="pop-list">${items}</ul>` +
    (more > 0 ? `<div class="pop-more">and ${more} more</div>` : '') +
    `</div>${noteHtml}`
  );
}

/** Bounds [[south, west], [north, east]] that hold every place, or null when there are none. */
export function boundsOf(rows: IndexRow[]): [[number, number], [number, number]] | null {
  let s = 90;
  let n = -90;
  let w = 180;
  let e = -180;
  let any = false;
  for (const r of rows) {
    if (!r.ll) continue;
    any = true;
    s = Math.min(s, r.ll[0]);
    n = Math.max(n, r.ll[0]);
    w = Math.min(w, r.ll[1]);
    e = Math.max(e, r.ll[1]);
  }
  return any ? [[s, w], [n, e]] : null;
}
