// My shows: the vendor tracker. Everything here is saved in the browser; the backup file is how it
// moves between a phone and a laptop. All functions return new objects and never change their input.
import { addDays, daysBetween, formatMonthDay, isISODate } from './dates.ts';
import { buildCalendar, type IcsReminder, type IcsShow } from './ics.ts';
import { normalizeSettings, type VendorSettings } from './settings.ts';
import { absoluteUrl, showPath } from './urls.ts';
import type { EventType, IndexRow, Show } from './types.ts';
import { EVENT_TYPES } from './types.ts';

export type Stage = 'watching' | 'applied' | 'waitlisted' | 'accepted' | 'paid' | 'done' | 'skipped';

export const STAGES: { id: Stage; label: string; help: string }[] = [
  { id: 'watching', label: 'Watching', help: 'Interested, not applied yet' },
  { id: 'applied', label: 'Applied', help: 'Waiting to hear back' },
  { id: 'waitlisted', label: 'Waitlisted', help: 'On the organizer’s waitlist' },
  { id: 'accepted', label: 'Accepted', help: 'You have a table, payment may be due' },
  { id: 'paid', label: 'Paid', help: 'Table is paid for' },
  { id: 'done', label: 'Done', help: 'The show is over' },
  { id: 'skipped', label: 'Skipped', help: 'Not doing this one' },
];

export const STAGE_IDS: readonly Stage[] = STAGES.map((s) => s.id);

export function stageLabel(stage: Stage): string {
  return STAGES.find((s) => s.id === stage)?.label ?? stage;
}

/** Enough about the show to keep the card useful after the show leaves the lists. */
export interface ShowSnapshot {
  name: string;
  first: string;
  last: string;
  city: string;
  region: string;
  country: string;
  type: EventType;
}

export interface MyShow {
  id: string;
  stage: Stage;
  snapshot: ShowSnapshot;
  addedAt: string;
  updatedAt: string;
  /** what kind of table, such as "8 ft table" */
  tableType: string;
  /** price paid (or quoted) for the table */
  tablePrice: number | null;
  /** the day the application went in */
  appliedOn: string | null;
  /** apply by */
  deadline: string | null;
  /** payment due */
  paymentDue: string | null;
  notes: string;
  /** after the show: actual gross sales */
  grossSales: number | null;
  /** after the show: 1 to 5, would I do it again */
  wouldDoAgain: number | null;
}

export interface MyShowsStore {
  version: 1;
  /** when anything last changed, for the backup reminder */
  updatedAt: string | null;
  shows: Record<string, MyShow>;
}

export function emptyStore(): MyShowsStore {
  return { version: 1, updatedAt: null, shows: {} };
}

export function snapshotFromRow(row: IndexRow): ShowSnapshot {
  return { name: row.n, first: row.d, last: row.e ?? row.d, city: row.c, region: row.r, country: row.k, type: row.t };
}

export function snapshotFromShow(show: Show): ShowSnapshot {
  const first = show.days[0]?.date ?? '';
  const last = show.days[show.days.length - 1]?.date ?? first;
  return {
    name: show.name,
    first,
    last,
    city: show.venue.city,
    region: show.venue.region,
    country: show.venue.country,
    type: show.event_type,
  };
}

function stamp(now: Date): string {
  return now.toISOString();
}

export function isTracked(store: MyShowsStore, id: string): boolean {
  return id in store.shows;
}

export function trackedCount(store: MyShowsStore): number {
  return Object.keys(store.shows).length;
}

/** Add a show (or leave it alone when it is already there). The deadline can be filled from the show's vendor info. */
export function addShow(
  store: MyShowsStore,
  id: string,
  snapshot: ShowSnapshot,
  now: Date,
  extra: { stage?: Stage; deadline?: string | null; tablePrice?: number | null; tableType?: string } = {},
): MyShowsStore {
  if (isTracked(store, id)) return store;
  const entry: MyShow = {
    id,
    stage: extra.stage ?? 'watching',
    snapshot,
    addedAt: stamp(now),
    updatedAt: stamp(now),
    tableType: extra.tableType ?? '',
    tablePrice: extra.tablePrice ?? null,
    appliedOn: null,
    deadline: extra.deadline && isISODate(extra.deadline) ? extra.deadline : null,
    paymentDue: null,
    notes: '',
    grossSales: null,
    wouldDoAgain: null,
  };
  return { ...store, updatedAt: stamp(now), shows: { ...store.shows, [id]: entry } };
}

export type MyShowPatch = Partial<Omit<MyShow, 'id' | 'addedAt' | 'updatedAt'>>;

export function updateShow(store: MyShowsStore, id: string, patch: MyShowPatch, now: Date): MyShowsStore {
  const current = store.shows[id];
  if (!current) return store;
  const next = sanitizeEntry({ ...current, ...patch, id, addedAt: current.addedAt, updatedAt: stamp(now) });
  if (!next) return store;
  return { ...store, updatedAt: stamp(now), shows: { ...store.shows, [id]: next } };
}

export function moveToStage(store: MyShowsStore, id: string, stage: Stage, now: Date): MyShowsStore {
  const current = store.shows[id];
  if (!current || current.stage === stage) return store;
  const patch: MyShowPatch = { stage };
  if (stage === 'applied' && !current.appliedOn) patch.appliedOn = stamp(now).slice(0, 10);
  return updateShow(store, id, patch, now);
}

export function removeShow(store: MyShowsStore, id: string, now: Date): MyShowsStore {
  if (!isTracked(store, id)) return store;
  const shows = { ...store.shows };
  delete shows[id];
  return { ...store, updatedAt: stamp(now), shows };
}

export function byStage(store: MyShowsStore): Record<Stage, MyShow[]> {
  const out = Object.fromEntries(STAGE_IDS.map((s) => [s, [] as MyShow[]])) as Record<Stage, MyShow[]>;
  for (const e of Object.values(store.shows)) out[e.stage].push(e);
  for (const s of STAGE_IDS) out[s].sort((a, b) => (a.snapshot.first < b.snapshot.first ? -1 : a.snapshot.first > b.snapshot.first ? 1 : a.id < b.id ? -1 : 1));
  return out;
}

export interface DeadlineItem {
  id: string;
  kind: 'apply' | 'payment';
  date: string;
  name: string;
  stage: Stage;
  /** days from today; negative when passed */
  daysLeft: number;
}

/**
 * Dates that need action, soonest first. "Apply by" counts while a show is being watched; "payment
 * due" counts until it is paid. Dates that have passed are listed separately.
 */
export function deadlines(store: MyShowsStore, today: string): { upcoming: DeadlineItem[]; passed: DeadlineItem[] } {
  const items: DeadlineItem[] = [];
  for (const e of Object.values(store.shows)) {
    if (e.stage === 'watching' && e.deadline) {
      items.push({ id: e.id, kind: 'apply', date: e.deadline, name: e.snapshot.name, stage: e.stage, daysLeft: daysBetween(today, e.deadline) });
    }
    if ((e.stage === 'applied' || e.stage === 'waitlisted' || e.stage === 'accepted') && e.paymentDue) {
      items.push({ id: e.id, kind: 'payment', date: e.paymentDue, name: e.snapshot.name, stage: e.stage, daysLeft: daysBetween(today, e.paymentDue) });
    }
  }
  const order = (a: DeadlineItem, b: DeadlineItem) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return {
    upcoming: items.filter((i) => i.daysLeft >= 0).sort(order),
    passed: items.filter((i) => i.daysLeft < 0).sort((a, b) => order(b, a)),
  };
}

export function deadlineText(item: DeadlineItem): string {
  const verb = item.kind === 'apply' ? 'Apply by' : 'Payment due';
  return `${verb} ${formatMonthDay(item.date)}`;
}

/** "Today", "Tomorrow", "In 5 days", "3 days ago" */
export function daysLeftText(daysLeft: number): string {
  if (daysLeft === 0) return 'Today';
  if (daysLeft === 1) return 'Tomorrow';
  if (daysLeft === -1) return 'Yesterday';
  return daysLeft > 0 ? `In ${daysLeft} days` : `${-daysLeft} days ago`;
}

// ---------- calendar export ----------

export const REMINDER_DAYS = [7, 1];

export function reminders(store: MyShowsStore, today: string): IcsReminder[] {
  const { upcoming } = deadlines(store, today);
  return upcoming.map((d) => ({
    uid: `${d.id}-${d.kind}`,
    date: d.date,
    summary: `${d.kind === 'apply' ? 'Apply by' : 'Payment due'}: ${d.name}`,
    description: `${deadlineText(d)} for ${d.name}.`,
    url: absoluteUrl(showPath(d.id)),
    daysBefore: REMINDER_DAYS,
  }));
}

function icsShowFromEntry(e: MyShow): IcsShow {
  const days: IcsShow['days'] = [];
  for (let d = e.snapshot.first; d <= e.snapshot.last && days.length < 31; d = addDays(d, 1)) days.push({ date: d, open: null, close: null });
  return {
    id: e.id,
    name: e.snapshot.name,
    days,
    timezone: null,
    location: [e.snapshot.city, e.snapshot.region].filter(Boolean).join(', ') || null,
    url: absoluteUrl(showPath(e.id)),
    description: `My status: ${stageLabel(e.stage)}${e.tableType ? `\nTable: ${e.tableType}` : ''}`,
    status: 'scheduled',
  };
}

/** Calendar of the shows still to come (not skipped, not done) plus deadline reminders. */
export function calendarFor(store: MyShowsStore, today: string, now: Date): string {
  const shows = Object.values(store.shows)
    .filter((e) => e.stage !== 'skipped' && e.stage !== 'done' && e.snapshot.last >= today)
    .sort((a, b) => (a.snapshot.first < b.snapshot.first ? -1 : 1))
    .map(icsShowFromEntry);
  return buildCalendar({ name: 'My card shows', now, shows, reminders: reminders(store, today) });
}

// ---------- reading saved data safely ----------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.slice(0, max) : '');
const date = (v: unknown): string | null => (isISODate(v) ? v : null);
const money = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

function sanitizeSnapshot(v: unknown): ShowSnapshot | null {
  if (!isObj(v)) return null;
  const name = text(v.name, 200);
  const first = date(v.first);
  if (!name || !first) return null;
  const last = date(v.last) ?? first;
  const type = EVENT_TYPES.includes(v.type as EventType) ? (v.type as EventType) : 'card_show';
  return { name, first, last: last < first ? first : last, city: text(v.city, 100), region: text(v.region, 10), country: text(v.country, 4) || 'US', type };
}

export function sanitizeEntry(v: unknown): MyShow | null {
  if (!isObj(v)) return null;
  const id = text(v.id, 200);
  const snapshot = sanitizeSnapshot(v.snapshot);
  if (!id || !snapshot) return null;
  const stage = STAGE_IDS.includes(v.stage as Stage) ? (v.stage as Stage) : 'watching';
  const again = typeof v.wouldDoAgain === 'number' && v.wouldDoAgain >= 1 && v.wouldDoAgain <= 5 ? Math.round(v.wouldDoAgain) : null;
  const added = text(v.addedAt, 40) || new Date(0).toISOString();
  return {
    id,
    stage,
    snapshot,
    addedAt: added,
    updatedAt: text(v.updatedAt, 40) || added,
    tableType: text(v.tableType, 120),
    tablePrice: money(v.tablePrice),
    appliedOn: date(v.appliedOn),
    deadline: date(v.deadline),
    paymentDue: date(v.paymentDue),
    notes: text(v.notes, 4000),
    grossSales: money(v.grossSales),
    wouldDoAgain: again,
  };
}

export function sanitizeStore(v: unknown): MyShowsStore {
  const store = emptyStore();
  if (!isObj(v) || !isObj(v.shows)) return store;
  const shows: Record<string, MyShow> = {};
  for (const [key, raw] of Object.entries(v.shows)) {
    const e = sanitizeEntry(isObj(raw) && !raw.id ? { ...raw, id: key } : raw);
    if (e) shows[e.id] = e;
  }
  return { version: 1, updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : null, shows };
}

// ---------- backup and restore ----------

export const BACKUP_APP = 'card-show-atlas';
export const BACKUP_VERSION = 1;

export interface BackupFile {
  app: typeof BACKUP_APP;
  kind: 'backup';
  version: number;
  exported: string;
  myShows: MyShowsStore;
  settings: VendorSettings;
}

export function createBackup(store: MyShowsStore, settings: VendorSettings, now: Date): BackupFile {
  return { app: BACKUP_APP, kind: 'backup', version: BACKUP_VERSION, exported: stamp(now), myShows: store, settings };
}

export function serializeBackup(b: BackupFile): string {
  return JSON.stringify(b, null, 2);
}

export function backupFileName(now: Date): string {
  return `card-show-atlas-backup-${stamp(now).slice(0, 10)}.json`;
}

export type ParsedBackup = { ok: true; store: MyShowsStore; settings: VendorSettings; exported: string | null } | { ok: false; error: string };

export function parseBackup(textContent: string): ParsedBackup {
  let raw: unknown;
  try {
    raw = JSON.parse(textContent);
  } catch {
    return { ok: false, error: 'That file is not a Card Show Atlas backup (it could not be read).' };
  }
  if (!isObj(raw) || raw.app !== BACKUP_APP || raw.kind !== 'backup') {
    return { ok: false, error: 'That file is not a Card Show Atlas backup.' };
  }
  if (typeof raw.version !== 'number' || raw.version > BACKUP_VERSION) {
    return { ok: false, error: 'That backup was made by a newer version of the site. Reload the page and try again.' };
  }
  return {
    ok: true,
    store: sanitizeStore(raw.myShows),
    settings: normalizeSettings(raw.settings),
    exported: typeof raw.exported === 'string' ? raw.exported : null,
  };
}

/** Combine two lists. For a show in both, the one changed most recently wins. */
export function mergeStores(a: MyShowsStore, b: MyShowsStore): MyShowsStore {
  const shows: Record<string, MyShow> = { ...a.shows };
  for (const [id, e] of Object.entries(b.shows)) {
    const mine = shows[id];
    if (!mine || e.updatedAt > mine.updatedAt) shows[id] = e;
  }
  const updatedAt = [a.updatedAt, b.updatedAt].filter((x): x is string => !!x).sort().pop() ?? null;
  return { version: 1, updatedAt, shows };
}

/** Should the page nudge the person to make a backup? True when there is data that no backup contains yet. */
export function needsBackup(store: MyShowsStore, lastBackup: string | null): boolean {
  if (trackedCount(store) === 0) return false;
  if (!lastBackup) return true;
  return !!store.updatedAt && store.updatedAt > lastBackup;
}
