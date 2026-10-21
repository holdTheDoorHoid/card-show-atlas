// Share links, from the page's side. The planner makes and checks the link itself (planner/src/links.ts);
// this file decides what goes into it, where it lives in the address, and how an opened link
// turns back into a filled in form. The start point is left out unless the person ticked the box.
import type { SharePayload, ShareSettings } from '../../../planner/src/links.ts';
import type { Plan } from '../../../planner/src/vending.ts';
import type { PlannerCaller } from './plan-run.ts';
import { SITE_ORIGIN } from './config.ts';
import { addDays, isISODate } from './dates.ts';
import { defaultSeasonForm, defaultWeekendForm, type PlanPlace, type SeasonForm, type WeekendForm } from './plan-options.ts';
import { sanitizeWeight } from './weights.ts';
import { basePath } from './urls.ts';

export const SHARE_HASH_KEY = 'plan';

export type ShareSource =
  | { kind: 'weekend'; form: WeekendForm; startPoint: PlanPlace | { lat: number; lon: number } | null }
  | { kind: 'season'; form: SeasonForm; /** the dates actually planned */ range: { start: string; end: string }; startPoint: PlanPlace | { lat: number; lon: number } | null };

/** What a link may carry: the shows and the planning knobs. Never sales, margin, history or the home settings. */
export function sharePayload(source: ShareSource, plan: Plan, includeStart: boolean): SharePayload {
  const showIds = plan.stops.map((s) => s.showId);
  let payload: SharePayload;
  if (source.kind === 'weekend') {
    const f = source.form;
    const settings: ShareSettings = {
      start: f.start,
      end: f.end,
      overnight: f.overnight,
      weights: f.weights,
    };
    if (f.maxDriveHours !== null) settings.maxDriveHours = f.maxDriveHours;
    if (f.mode === 'shopping') settings.dwellMinutes = f.dwellMinutes;
    payload = { mode: f.mode, showIds, settings };
  } else {
    const f = source.form;
    const range = source.range;
    const settings: ShareSettings = {
      start: range.start,
      end: range.end,
      weekendsOnly: f.weekendsOnly,
      fridayIsWeekend: f.weekendsOnly && f.fridayCounts,
      chain: f.chain,
      weights: f.weights,
    };
    if (f.maxShowsPerMonth !== null) settings.maxShowsPerMonth = f.maxShowsPerMonth;
    if (f.maxNightsAway !== null) settings.maxNightsAway = f.maxNightsAway;
    if (f.blackout.length > 0) settings.blackout = f.blackout;
    if (f.maxDriveHours !== null) settings.maxDriveHours = f.maxDriveHours;
    payload = { mode: 'season', showIds, settings };
  }
  if (includeStart && source.startPoint) payload.start = { lat: source.startPoint.lat, lon: source.startPoint.lon };
  return payload;
}

export async function makeShareLink(planner: PlannerCaller, source: ShareSource, plan: Plan, includeStart: boolean): Promise<string> {
  const payload = sharePayload(source, plan, includeStart);
  return planner.call('encodeShare', { payload, includeStart });
}

/** The address to paste: the Plan page with the link in the part after the #, which is never sent to a server. */
export function shareUrl(link: string, origin: string = SITE_ORIGIN, base: string = basePath()): string {
  return `${origin}${base}/plan/#${SHARE_HASH_KEY}=${link}`;
}

/** The share link in a page address' hash, or null. */
export function linkFromHash(hash: string): string | null {
  const m = new RegExp(`^#?${SHARE_HASH_KEY}=([A-Za-z0-9_.-]+)$`).exec(hash.trim());
  return m ? (m[1] as string) : null;
}

export interface OpenedShare {
  tab: 'weekend' | 'season';
  weekend: WeekendForm;
  season: SeasonForm;
  /** plan only these shows */
  onlyIds: string[];
  /** where the sender started, when they chose to share it */
  start: PlanPlace | null;
}

export type OpenShareResult = { ok: true; value: OpenedShare } | { ok: false; error: string };

/** Decode a link and fill in the forms it describes. Dates in the past move forward to the coming weekend or today. */
export async function openShare(planner: PlannerCaller, link: string, today: string): Promise<OpenShareResult> {
  const res = await planner.call('decodeShare', { link });
  if (!res.ok) return { ok: false, error: res.error };
  const v = res.value;
  const s = v.settings;
  const start: PlanPlace | null = v.start ? { lat: v.start.lat, lon: v.start.lon, label: 'the sender’s start point', country: null } : null;
  const weekend = defaultWeekendForm(today);
  const season = defaultSeasonForm(today);
  const keepDates = (d: string | undefined) => (d && isISODate(d) ? d : undefined);
  if (v.mode === 'season') {
    season.span = 'custom';
    season.start = keepDates(s.start) ?? season.start;
    season.end = keepDates(s.end) ?? addDays(season.start, 90);
    if (season.start < today) season.start = today;
    if (season.end < season.start) season.end = addDays(season.start, 90);
    season.weekendsOnly = s.weekendsOnly ?? season.weekendsOnly;
    season.fridayCounts = s.fridayIsWeekend ?? false;
    season.chain = s.chain ?? true;
    season.maxShowsPerMonth = s.maxShowsPerMonth ?? null;
    season.maxNightsAway = s.maxNightsAway ?? null;
    season.blackout = s.blackout ?? [];
    season.maxDriveHours = s.maxDriveHours ?? null;
    season.weights = typeof s.weights === 'string' ? sanitizeWeight(s.weights) : season.weights;
    season.startPlace = start;
  } else {
    weekend.mode = v.mode === 'shopping' ? 'shopping' : 'vending';
    weekend.start = keepDates(s.start) ?? weekend.start;
    weekend.end = keepDates(s.end) ?? weekend.end;
    if (weekend.start < today) {
      const shift = weekend.end >= today ? today : weekend.start;
      weekend.start = shift;
    }
    if (weekend.end < weekend.start) weekend.end = addDays(weekend.start, 2);
    weekend.overnight = s.overnight ?? 'stay';
    weekend.maxDriveHours = s.maxDriveHours ?? null;
    weekend.dwellMinutes = s.dwellMinutes ?? 90;
    weekend.weights = typeof s.weights === 'string' ? sanitizeWeight(s.weights) : weekend.weights;
    weekend.startPlace = start;
  }
  return { ok: true, value: { tab: v.mode === 'season' ? 'season' : 'weekend', weekend, season, onlyIds: v.showIds, start } };
}
