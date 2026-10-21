/**
 * Links out of a plan: Google Maps directions and share links (DESIGN 6.5).
 *
 * Share links never contain the start point unless `includeStart` is set, so a link pasted in a
 * group chat does not reveal anyone's address. Decoding validates everything and never throws.
 */
import { formatShortDate } from './format.js';
import { dateFromEpochDay, epochDay, isValidDate } from './time.js';
import type { Plan, PlanPoint } from './vending.js';
import type { PresetName, Weights } from './factors.js';
import { WEIGHT_KEYS } from './factors.js';

/* ---------------------------------- Google Maps ---------------------------------- */

export interface MapsLink {
  url: string;
  /** "Trip 1: Nov 14 to 15", "Part 2 of 3". */
  label: string;
}

export interface MapsLinkOptions {
  /** Put the start and end point in the link. Default false: Google starts from where you are. */
  includeStart?: boolean;
  /** Waypoints per link. Google allows up to 9 on most browsers (3 on some phones). Default 9. */
  maxWaypoints?: number;
}

function coord(p: { lat: number; lon: number }): string {
  return `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
}

function dirUrl(origin: PlanPoint | null, destination: PlanPoint, waypoints: PlanPoint[]): string {
  const params: string[] = ['api=1'];
  if (origin) params.push(`origin=${encodeURIComponent(coord(origin))}`);
  params.push(`destination=${encodeURIComponent(coord(destination))}`);
  if (waypoints.length > 0) params.push(`waypoints=${encodeURIComponent(waypoints.map(coord).join('|'))}`);
  params.push('travelmode=driving');
  return `https://www.google.com/maps/dir/?${params.join('&')}`;
}

function chunkRoute(points: PlanPoint[], hasOrigin: boolean, maxWaypoints: number): { origin: PlanPoint | null; dest: PlanPoint; way: PlanPoint[] }[] {
  const out: { origin: PlanPoint | null; dest: PlanPoint; way: PlanPoint[] }[] = [];
  if (points.length === 0) return out;
  let i = 0;
  let origin: PlanPoint | null = hasOrigin ? points[0]! : null;
  if (hasOrigin) i = 1;
  while (i < points.length) {
    const rest = points.slice(i, i + maxWaypoints + 1);
    const dest = rest[rest.length - 1]!;
    out.push({ origin, dest, way: rest.slice(0, -1) });
    origin = dest;
    i += rest.length;
  }
  return out;
}

/** Driving directions through the plan's stops. Season plans get one link per trip. */
export function googleMapsUrls(plan: Plan, opts: MapsLinkOptions = {}): MapsLink[] {
  const maxWay = Math.max(1, Math.min(9, opts.maxWaypoints ?? 9));
  const groups: { label: string; stops: PlanPoint[] }[] = [];
  const asPoint = (s: Plan['stops'][number]): PlanPoint => ({ name: s.town, lat: s.lat, lon: s.lon, showId: s.showId, kind: 'show' });
  if (plan.trips.length > 1) {
    plan.trips.forEach((t, i) => {
      const stops = plan.stops.filter((s) => t.showIds.includes(s.showId)).map(asPoint);
      const when = t.departDate === t.returnDate ? formatShortDate(t.departDate) : `${formatShortDate(t.departDate)} to ${formatShortDate(t.returnDate)}`;
      groups.push({ label: `Trip ${i + 1}: ${when}`, stops });
    });
  } else {
    groups.push({ label: plan.title, stops: plan.stops.map(asPoint) });
  }
  const links: MapsLink[] = [];
  for (const g of groups) {
    if (g.stops.length === 0) continue;
    const pts = opts.includeStart ? [plan.start, ...g.stops, plan.end] : g.stops;
    const chunks = chunkRoute(pts, !!opts.includeStart, maxWay);
    chunks.forEach((c, i) => {
      links.push({
        url: dirUrl(c.origin, c.dest, c.way),
        label: chunks.length > 1 ? `${g.label}, part ${i + 1} of ${chunks.length}` : g.label,
      });
    });
  }
  return links;
}

/* ---------------------------------- Share links ---------------------------------- */

/** Planning knobs safe to share. Personal numbers (sales, margin, history) are never included. */
export interface ShareSettings {
  start?: string;
  end?: string;
  overnight?: 'stay' | 'home';
  maxDriveHours?: number;
  dwellMinutes?: number;
  weekendsOnly?: boolean;
  fridayIsWeekend?: boolean;
  maxShowsPerMonth?: number;
  maxNightsAway?: number;
  maxShows?: number;
  chain?: boolean;
  weights?: PresetName | Partial<Weights>;
  blackout?: string[];
}

export interface SharePayload {
  mode: 'vending' | 'shopping' | 'season';
  showIds: string[];
  settings: ShareSettings;
  /** Only present when the sender ticked "include my start point". Rounded to about 100 m. */
  start?: { lat: number; lon: number };
}

export type DecodeResult = { ok: true; value: SharePayload } | { ok: false; error: string };

const MODES = { v: 'vending', s: 'shopping', p: 'season' } as const;
const MODE_CODE: Record<SharePayload['mode'], string> = { vending: 'v', shopping: 's', season: 'p' };
const ID_RE = /^[a-z0-9][a-z0-9-]{0,159}$/;
const SERIES_DATE_RE = /^(.*)-(\d{4}-\d{2}-\d{2})$/;
const PRESETS: PresetName[] = ['biggest_crowds', 'cheapest', 'closest', 'balanced'];
const MAX_SHOWS = 300;
const MAX_LINK = 12000;

/* UTF-8 and base64url without TextEncoder or btoa, so this runs anywhere. */
function utf8Encode(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

function utf8Decode(bytes: number[]): string | null {
  let s = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i]!;
    let c: number;
    let n: number;
    if (b < 0x80) {
      c = b;
      n = 0;
    } else if (b >= 0xc2 && b < 0xe0) {
      c = b & 31;
      n = 1;
    } else if (b >= 0xe0 && b < 0xf0) {
      c = b & 15;
      n = 2;
    } else if (b >= 0xf0 && b < 0xf5) {
      c = b & 7;
      n = 3;
    } else return null;
    for (let k = 1; k <= n; k++) {
      const x = bytes[i + k];
      if (x === undefined || (x & 0xc0) !== 0x80) return null;
      c = (c << 6) | (x & 63);
    }
    if ((n === 2 && c < 0x800) || (n === 3 && (c < 0x10000 || c > 0x10ffff)) || (c >= 0xd800 && c <= 0xdfff)) return null;
    s += String.fromCodePoint(c);
    i += n + 1;
  }
  return s;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function b64urlEncode(bytes: number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    if (b !== undefined) out += B64[(n >> 6) & 63]!;
    if (c !== undefined) out += B64[n & 63]!;
  }
  return out;
}

function b64urlDecode(s: string): number[] | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of s) {
    buf = (buf << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 255);
    }
  }
  return out;
}

/** FNV 1a, 32 bit, as base 36. Catches truncated or mistyped links. */
function checksum(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

interface Wire {
  m: string;
  b?: number;
  d?: string[];
  e: (number | string)[];
  s?: Record<string, unknown>;
  h?: [number, number];
}

const SETTING_KEYS: Record<keyof ShareSettings, string> = {
  start: 'a',
  end: 'z',
  overnight: 'o',
  maxDriveHours: 'd',
  dwellMinutes: 'w',
  weekendsOnly: 'k',
  fridayIsWeekend: 'f',
  maxShowsPerMonth: 'm',
  maxNightsAway: 'n',
  maxShows: 'x',
  chain: 'c',
  weights: 'g',
  blackout: 'l',
};

/**
 * Compact, URL safe string for a plan. Show ids that end in a date are stored as a series plus a
 * day offset, so a season plan stays short. The start point is left out unless `includeStart`.
 */
export function encodeShareLink(payload: SharePayload, opts: { includeStart?: boolean } = {}): string {
  const series: string[] = [];
  const seriesIndex = new Map<string, number>();
  const parsed = payload.showIds.map((id) => {
    const m = SERIES_DATE_RE.exec(id);
    if (m && isValidDate(m[2]!)) return { series: m[1]!, day: epochDay(m[2]!), id };
    return { series: null, day: 0, id };
  });
  const days = parsed.filter((p) => p.series !== null).map((p) => p.day);
  const base = days.length ? Math.min(...days) : 0;
  const e: (number | string)[] = [];
  for (const p of parsed) {
    if (p.series === null) {
      e.push(p.id);
      continue;
    }
    let si = seriesIndex.get(p.series);
    if (si === undefined) {
      si = series.length;
      series.push(p.series);
      seriesIndex.set(p.series, si);
    }
    e.push(si, p.day - base);
  }
  const s: Record<string, unknown> = {};
  for (const [k, short] of Object.entries(SETTING_KEYS) as [keyof ShareSettings, string][]) {
    const v = payload.settings?.[k];
    if (v === undefined || v === null) continue;
    if (k === 'start' || k === 'end') s[short] = epochDay(v as string);
    else if (k === 'blackout') s[short] = (v as string[]).map(epochDay);
    else if (k === 'weights' && typeof v === 'string') s[short] = PRESETS.indexOf(v as PresetName);
    else s[short] = v;
  }
  const wire: Wire = { m: MODE_CODE[payload.mode], e };
  if (series.length) {
    wire.b = base;
    wire.d = series;
  }
  if (Object.keys(s).length) wire.s = s;
  if (opts.includeStart && payload.start) {
    wire.h = [Math.round(payload.start.lat * 1000) / 1000, Math.round(payload.start.lon * 1000) / 1000];
  }
  const json = JSON.stringify(wire);
  return `${b64urlEncode(utf8Encode(json))}.${checksum(json)}`;
}

function isInt(x: unknown, lo: number, hi: number): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= lo && x <= hi;
}

function isNum(x: unknown, lo: number, hi: number): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;
}

/** Decodes and validates a share link. Never throws. */
export function decodeShareLink(link: string): DecodeResult {
  const bad = (error: string): DecodeResult => ({ ok: false, error });
  if (typeof link !== 'string' || link.length === 0) return bad('The link is empty.');
  if (link.length > MAX_LINK) return bad('The link is too long.');
  const dot = link.lastIndexOf('.');
  if (dot <= 0) return bad('The link is not complete.');
  const bytes = b64urlDecode(link.slice(0, dot));
  if (!bytes) return bad('The link has characters that do not belong in it.');
  const json = utf8Decode(bytes);
  if (json === null) return bad('The link could not be read.');
  if (checksum(json) !== link.slice(dot + 1)) return bad('The link was cut off or changed. Ask for it again.');
  let wire: unknown;
  try {
    wire = JSON.parse(json);
  } catch {
    return bad('The link could not be read.');
  }
  if (!wire || typeof wire !== 'object' || Array.isArray(wire)) return bad('The link could not be read.');
  const w = wire as Record<string, unknown>;
  for (const k of Object.keys(w)) if (!['m', 'b', 'd', 'e', 's', 'h'].includes(k)) return bad('The link has unknown parts.');
  const mode = MODES[w.m as keyof typeof MODES];
  if (!mode) return bad('The link is for an unknown kind of plan.');
  const series = w.d ?? [];
  if (!Array.isArray(series) || series.length > MAX_SHOWS || !series.every((x) => typeof x === 'string' && ID_RE.test(x))) {
    return bad('The link has a show that is not valid.');
  }
  if (series.length > 0 && !isInt(w.b, 0, 200_000)) return bad('The link has a date that is not valid.');
  const base = (w.b as number) ?? 0;
  if (!Array.isArray(w.e) || w.e.length > MAX_SHOWS * 2) return bad('The link has no shows or too many.');
  const showIds: string[] = [];
  for (let i = 0; i < w.e.length; i++) {
    const x = w.e[i];
    if (typeof x === 'string') {
      if (!ID_RE.test(x)) return bad('The link has a show that is not valid.');
      showIds.push(x);
    } else if (isInt(x, 0, series.length - 1)) {
      const off = w.e[i + 1];
      if (!isInt(off, 0, 4000)) return bad('The link has a date that is not valid.');
      const id = `${series[x]}-${dateFromEpochDay(base + off)}`;
      if (!ID_RE.test(id)) return bad('The link has a show that is not valid.');
      showIds.push(id);
      i += 1;
    } else {
      return bad('The link has a show that is not valid.');
    }
  }
  if (showIds.length > MAX_SHOWS) return bad('The link has too many shows.');
  const settings: ShareSettings = {};
  const s = w.s ?? {};
  if (typeof s !== 'object' || s === null || Array.isArray(s)) return bad('The link settings could not be read.');
  const known = new Set(Object.values(SETTING_KEYS));
  for (const k of Object.keys(s)) if (!known.has(k)) return bad('The link has unknown settings.');
  const sv = s as Record<string, unknown>;
  const day = (x: unknown) => (isInt(x, 0, 200_000) ? dateFromEpochDay(x) : null);
  if (sv.a !== undefined) {
    const d = day(sv.a);
    if (!d) return bad('The start date in the link is not valid.');
    settings.start = d;
  }
  if (sv.z !== undefined) {
    const d = day(sv.z);
    if (!d) return bad('The end date in the link is not valid.');
    settings.end = d;
  }
  if (settings.start && settings.end && settings.end < settings.start) return bad('The dates in the link are the wrong way round.');
  if (sv.o !== undefined) {
    if (sv.o !== 'stay' && sv.o !== 'home') return bad('The link settings could not be read.');
    settings.overnight = sv.o;
  }
  if (sv.d !== undefined) {
    if (!isNum(sv.d, 0.25, 24)) return bad('The driving limit in the link is not valid.');
    settings.maxDriveHours = sv.d;
  }
  if (sv.w !== undefined) {
    if (!isInt(sv.w, 1, 720)) return bad('The time at each show in the link is not valid.');
    settings.dwellMinutes = sv.w;
  }
  for (const [short, key] of [['k', 'weekendsOnly'], ['f', 'fridayIsWeekend'], ['c', 'chain']] as const) {
    if (sv[short] === undefined) continue;
    if (typeof sv[short] !== 'boolean') return bad('The link settings could not be read.');
    settings[key] = sv[short] as boolean;
  }
  for (const [short, key, hi] of [['m', 'maxShowsPerMonth', 31], ['n', 'maxNightsAway', 60], ['x', 'maxShows', 50]] as const) {
    if (sv[short] === undefined) continue;
    if (!isInt(sv[short], 0, hi)) return bad('The link settings could not be read.');
    settings[key] = sv[short] as number;
  }
  if (sv.g !== undefined) {
    if (isInt(sv.g, 0, PRESETS.length - 1)) settings.weights = PRESETS[sv.g]!;
    else if (typeof sv.g === 'object' && sv.g !== null && !Array.isArray(sv.g)) {
      const g = sv.g as Record<string, unknown>;
      const out: Partial<Weights> = {};
      for (const k of Object.keys(g)) {
        if (!(WEIGHT_KEYS as string[]).includes(k) || !isNum(g[k], 0, 1000)) return bad('The weights in the link are not valid.');
        out[k as keyof Weights] = g[k] as number;
      }
      settings.weights = out;
    } else return bad('The weights in the link are not valid.');
  }
  if (sv.l !== undefined) {
    if (!Array.isArray(sv.l) || sv.l.length > 400) return bad('The blackout dates in the link are not valid.');
    const list: string[] = [];
    for (const x of sv.l) {
      const d = day(x);
      if (!d) return bad('The blackout dates in the link are not valid.');
      list.push(d);
    }
    settings.blackout = list;
  }
  const value: SharePayload = { mode, showIds, settings };
  if (w.h !== undefined) {
    const h = w.h;
    if (!Array.isArray(h) || h.length !== 2 || !isNum(h[0], -90, 90) || !isNum(h[1], -180, 180)) {
      return bad('The start point in the link is not valid.');
    }
    value.start = { lat: h[0], lon: h[1] };
  }
  return { ok: true, value };
}

/** Builds a share payload from a plan. */
export function sharePayloadFor(plan: Plan, mode: SharePayload['mode'], settings: ShareSettings = {}): SharePayload {
  return { mode, showIds: plan.stops.map((s) => s.showId), settings, start: { lat: plan.start.lat, lon: plan.start.lon } };
}
