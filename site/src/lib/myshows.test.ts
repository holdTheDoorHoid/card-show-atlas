import { describe, expect, it } from 'vitest';
import {
  addShow,
  backupFileName,
  byStage,
  calendarFor,
  createBackup,
  deadlines,
  emptyStore,
  mergeStores,
  moveToStage,
  needsBackup,
  parseBackup,
  removeShow,
  sanitizeStore,
  serializeBackup,
  snapshotFromRow,
  snapshotFromShow,
  trackedCount,
  updateShow,
  type MyShowsStore,
} from './myshows.ts';
import { DEFAULT_VENDOR_SETTINGS, normalizeSettings } from './settings.ts';
import { makeRow, makeShow } from './testing.ts';

const t0 = new Date('2026-10-21T10:00:00Z');
const t1 = new Date('2026-10-22T10:00:00Z');
const snap = (name: string, first = '2026-11-14', last = first) => ({ name, first, last, city: 'Edison', region: 'NJ', country: 'US', type: 'card_show' as const });

function sample(): MyShowsStore {
  let s = emptyStore();
  s = addShow(s, 'a', snap('Sample A'), t0, { deadline: '2026-11-03' });
  s = addShow(s, 'b', snap('Sample B', '2026-12-05', '2026-12-06'), t0, { deadline: '2026-10-25' });
  s = addShow(s, 'c', snap('Sample C', '2027-01-10'), t0, { stage: 'accepted' });
  s = updateShow(s, 'c', { paymentDue: '2026-12-01', tablePrice: 150, tableType: '8 ft table' }, t0);
  s = addShow(s, 'd', snap('Sample D', '2026-10-01'), t0, { deadline: '2026-10-10' });
  return s;
}

describe('the board', () => {
  it('adds a show once and keeps what it knew about it', () => {
    let s = addShow(emptyStore(), 'a', snapshotFromShow(makeShow()), t0, { deadline: '2026-10-31' });
    expect(trackedCount(s)).toBe(1);
    expect(s.shows.a?.stage).toBe('watching');
    expect(s.shows.a?.snapshot).toMatchObject({ name: 'Sample Edison Card Show', first: '2026-11-14', last: '2026-11-15', city: 'Edison', region: 'NJ' });
    const again = addShow(s, 'a', snap('Other name'), t1);
    expect(again).toBe(s); // adding twice changes nothing
    s = removeShow(s, 'a', t1);
    expect(trackedCount(s)).toBe(0);
  });

  it('makes a snapshot from a list row too', () => {
    expect(snapshotFromRow(makeRow({ i: 'x', n: 'Sample X', d: '2026-11-14', e: '2026-11-16' }))).toMatchObject({ name: 'Sample X', first: '2026-11-14', last: '2026-11-16' });
  });

  it('moves a show between columns and records the day it was applied', () => {
    let s = sample();
    s = moveToStage(s, 'a', 'applied', t1);
    expect(s.shows.a?.stage).toBe('applied');
    expect(s.shows.a?.appliedOn).toBe('2026-10-22');
    expect(byStage(s).applied.map((e) => e.id)).toEqual(['a']);
    expect(byStage(s).watching.map((e) => e.id)).toEqual(['d', 'b']); // soonest show first
    expect(moveToStage(s, 'a', 'applied', t1)).toBe(s);
  });

  it('keeps per show details and cleans bad values', () => {
    let s = sample();
    s = updateShow(s, 'a', { grossSales: 1800, wouldDoAgain: 4, notes: 'Great room' }, t1);
    expect(s.shows.a).toMatchObject({ grossSales: 1800, wouldDoAgain: 4, notes: 'Great room' });
    s = updateShow(s, 'a', { wouldDoAgain: 9, grossSales: -5, deadline: 'tomorrow' as unknown as string }, t1);
    expect(s.shows.a?.wouldDoAgain).toBeNull();
    expect(s.shows.a?.grossSales).toBeNull();
    expect(s.shows.a?.deadline).toBeNull();
  });
});

describe('deadlines', () => {
  it('lists dates that need action, soonest first, with passed ones kept apart', () => {
    const s = sample();
    const { upcoming, passed } = deadlines(s, '2026-10-21');
    expect(upcoming.map((d) => [d.id, d.kind, d.date, d.daysLeft])).toEqual([
      ['b', 'apply', '2026-10-25', 4],
      ['a', 'apply', '2026-11-03', 13],
      ['c', 'payment', '2026-12-01', 41],
    ]);
    expect(passed.map((d) => d.id)).toEqual(['d']);
  });

  it('stops listing an apply by date once the application is in', () => {
    const s = moveToStage(sample(), 'b', 'applied', t1);
    expect(deadlines(s, '2026-10-21').upcoming.map((d) => d.id)).toEqual(['a', 'c']);
  });

  it('does not list skipped or paid shows', () => {
    let s = moveToStage(sample(), 'c', 'paid', t1);
    s = moveToStage(s, 'a', 'skipped', t1);
    expect(deadlines(s, '2026-10-21').upcoming.map((d) => d.id)).toEqual(['b']);
  });
});

describe('calendar export', () => {
  it('has the shows still to come and a reminder a week and a day before each deadline', () => {
    const ics = calendarFor(sample(), '2026-10-21', t1).replace(/\r\n[ \t]/g, '');
    expect(ics).toContain('SUMMARY:Sample A');
    expect(ics).toContain('SUMMARY:Sample C');
    expect(ics).not.toContain('SUMMARY:Sample D'); // already over
    expect(ics).toContain('SUMMARY:Apply by: Sample A');
    expect(ics).toContain('SUMMARY:Payment due: Sample C');
    expect(ics.match(/TRIGGER:-P7D/g)).toHaveLength(3);
    expect(ics.match(/TRIGGER:-P1D/g)).toHaveLength(3);
    expect(ics).toContain('DTSTART;VALUE=DATE:20261103');
  });

  it('leaves out skipped shows', () => {
    const s = moveToStage(sample(), 'a', 'skipped', t1);
    const ics = calendarFor(s, '2026-10-21', t1);
    expect(ics).not.toContain('SUMMARY:Sample A');
  });
});

describe('backup and restore', () => {
  it('round trips the list and the settings exactly', () => {
    const store = sample();
    const settings = normalizeSettings({
      ...DEFAULT_VENDOR_SETTINGS,
      home: { postal: '08837', lat: 40.52, lon: -74.41, country: 'US' },
      fuelEconomy: 18,
      fuelPrice: 3.45,
      hotelPerNight: 129,
      foodPerDay: 45,
      typicalSales: { small: 600, medium: 1500, large: 3000, major: 6000 },
      marginPercent: 40,
      sells: ['pokemon', 'mtg'],
    });
    const text = serializeBackup(createBackup(store, settings, t1));
    const back = parseBackup(text);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.store).toEqual(store);
    expect(back.settings).toEqual(settings);
    expect(back.exported).toBe(t1.toISOString());
    // and again, so a restored backup can be backed up
    const second = parseBackup(serializeBackup(createBackup(back.store, back.settings, t1)));
    expect(second.ok && second.store).toEqual(store);
  });

  it('names the file by date', () => {
    expect(backupFileName(t1)).toBe('card-show-atlas-backup-2026-10-22.json');
  });

  it('refuses files that are not backups, with a plain message', () => {
    for (const bad of ['not json', '{}', '[]', '{"app":"other","kind":"backup","version":1}', 'null']) {
      const r = parseBackup(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/backup/);
    }
    const newer = parseBackup(JSON.stringify({ app: 'card-show-atlas', kind: 'backup', version: 99, myShows: {} }));
    expect(newer.ok).toBe(false);
    if (!newer.ok) expect(newer.error).toMatch(/newer/);
  });

  it('drops damaged entries and cleans odd values instead of failing', () => {
    const raw = {
      app: 'card-show-atlas',
      kind: 'backup',
      version: 1,
      myShows: {
        version: 1,
        shows: {
          good: { id: 'good', stage: 'applied', snapshot: snap('Sample Good'), tablePrice: 100 },
          nosnap: { id: 'nosnap', stage: 'applied' },
          weird: { id: 'weird', stage: 'flying', snapshot: snap('Sample Weird'), wouldDoAgain: 12, notes: 5, deadline: 'soon' },
        },
      },
      settings: { fuelEconomy: -4, maxDrivingHoursPerDay: 99, home: { lat: 400, lon: 0 } },
    };
    const r = parseBackup(JSON.stringify(raw));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.store.shows).sort()).toEqual(['good', 'weird']);
    expect(r.store.shows.weird).toMatchObject({ stage: 'watching', wouldDoAgain: null, notes: '', deadline: null });
    expect(r.settings.fuelEconomy).toBeNull();
    expect(r.settings.maxDrivingHoursPerDay).toBe(16);
    expect(r.settings.home.lat).toBeNull();
  });

  it('merges two lists, keeping the newer copy of a show in both', () => {
    let a = addShow(emptyStore(), 'x', snap('Sample X'), t0);
    a = updateShow(a, 'x', { notes: 'old' }, t0);
    let b = addShow(emptyStore(), 'x', snap('Sample X'), t0);
    b = updateShow(b, 'x', { notes: 'new' }, t1);
    b = addShow(b, 'y', snap('Sample Y'), t1);
    const merged = mergeStores(a, b);
    expect(merged.shows.x?.notes).toBe('new');
    expect(Object.keys(merged.shows).sort()).toEqual(['x', 'y']);
    expect(mergeStores(b, a).shows.x?.notes).toBe('new');
  });

  it('nudges for a backup only when there is something not yet saved', () => {
    expect(needsBackup(emptyStore(), null)).toBe(false);
    const s = sample();
    expect(needsBackup(s, null)).toBe(true);
    expect(needsBackup(s, new Date('2027-01-01T00:00:00Z').toISOString())).toBe(false);
    const changed = updateShow(s, 'a', { notes: 'x' }, new Date('2027-02-01T00:00:00Z'));
    expect(needsBackup(changed, new Date('2027-01-01T00:00:00Z').toISOString())).toBe(true);
  });

  it('reads old or damaged saved data without throwing', () => {
    expect(sanitizeStore(null).shows).toEqual({});
    expect(sanitizeStore({ shows: 'no' }).shows).toEqual({});
    expect(sanitizeStore({ shows: { a: 5, b: null } }).shows).toEqual({});
  });
});
