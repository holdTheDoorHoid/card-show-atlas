// Makes the SAMPLE data used by `npm run dev` and the tests. Everything here is made up:
// every show, series, promoter and venue name starts with "Sample", every link points at
// example.com, and every record carries the source id "fixture". Sample data must never be
// published: the production build refuses to include it (see src/lib/guard.ts).
//
// Usage: node fixtures/make-fixtures.mjs [--base YYYY-MM-DD]
// Dates are generated relative to the base date (today by default). The output is deterministic
// for a given base date. `npm run dev` regenerates the folder when it is more than two weeks old.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_VOCAB } from '../src/lib/vocab.ts';
import { CITIES } from './cities.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, 'data');

// ---------- small helpers ----------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const dayNum = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
};
const fromNum = (n) => {
  const t = new Date(n * 86400000);
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
};
const addDays = (s, n) => fromNum(dayNum(s) + n);
const weekdayOf = (s) => new Date(dayNum(s) * 86400000).getUTCDay();

/** The nth (1 to 4) given weekday (0 Sunday) of a month, or the last one when n is -1. */
function nthWeekday(year, month, weekday, n) {
  if (n > 0) {
    const first = weekdayOf(iso(year, month, 1));
    return iso(year, month, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7);
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = weekdayOf(iso(year, month, lastDay));
  return iso(year, month, lastDay - ((last - weekday + 7) % 7));
}

const slugify = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

// ---------- generator ----------

const PROMOTER_WORDS = ['Garden', 'Keystone', 'Lakeshore', 'Prairie', 'Summit', 'Harbor', 'Pioneer', 'Maple', 'Cedar', 'Granite', 'Riverbend', 'Sunrise', 'Northstar', 'Bluegrass', 'Lone Star', 'Evergreen', 'Silver', 'Copper', 'Atlantic', 'Pacific', 'Heartland', 'Capital', 'Foothills', 'Bayou', 'Mesa', 'Redwood', 'Great Lakes', 'Tidewater', 'Cascade', 'Boardwalk'];
const VENUE_KINDS = ['Expo Hall', 'Convention Center', 'Fairgrounds', 'Hotel Ballroom', 'Community Center', 'VFW Hall', 'Armory', 'Event Center', 'Rec Center', 'Banquet Hall'];
const CARD_SHOW_NAMES = [(c) => `${c} Card Show`, (c) => `${c} Sports Card Show`, (c) => `${c} Trading Card Expo`, (c) => `${c} Card and Collectibles Show`, (c) => `${c} Card Bash`];
const CONVENTION_NAMES = [(c) => `${c} Collectors Convention`, (c) => `${c} Card Collectors Expo`, (c) => `${c} National Card Expo`];
const TOURNAMENT_NAMES = [(c) => `${c} Regional Championships`, (c) => `${c} Open Tournament Weekend`, (c) => `${c} Card Game Challenge`];
const CON_NAMES = [(c) => `${c} Comic and Anime Con`, (c) => `${c} Pop Culture Con`, (c) => `${c} Gaming and Collectibles Con`];

const TCG_SETS = [
  ['pokemon', 'mtg', 'yugioh'],
  ['pokemon', 'one_piece', 'lorcana'],
  ['pokemon', 'mtg', 'yugioh', 'one_piece', 'lorcana'],
  ['pokemon'],
  ['mtg', 'yugioh'],
  ['pokemon', 'dragon_ball', 'digimon', 'one_piece'],
  ['mtg', 'fab', 'swu', 'lorcana'],
];
const SPORT_SETS = [['baseball', 'basketball', 'football'], ['baseball', 'football'], ['hockey', 'basketball'], ['baseball'], ['multi_sport'], ['football', 'basketball', 'baseball', 'hockey']];
const OTHER_SETS = [[], [], [], ['comics'], ['non_sport'], ['toys', 'comics'], ['memorabilia'], ['anime', 'video_games']];

const SQFT = [12000, 20000, 35000, 60000, 90000];

export function generateFixtures({ base }) {
  const rand = mulberry32(20261021);
  const int = (a, b) => a + Math.floor(rand() * (b - a + 1));
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const chance = (p) => rand() < p;
  const windowStart = addDays(base, -30);
  const windowEnd = addDays(base, 400);
  const baseDate = new Date(dayNum(base) * 86400000);
  const baseYear = baseDate.getUTCFullYear();
  const baseMonth = baseDate.getUTCMonth() + 1;

  // promoters
  const promoters = PROMOTER_WORDS.map((w) => {
    const name = `Sample ${w} Promotions`;
    return { id: slugify(name), name, url: `https://example.com/promoters/${slugify(w)}`, region: null, series: [], links: { facebook: null, instagram: null }, public_contact: `info@example.com` };
  });

  // series plans
  const plans = [];
  const usedSeriesIds = new Set();
  const cityPool = [...CITIES];
  const shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };
  shuffle(cityPool);
  let cityCursor = 0;
  const nextCity = () => cityPool[cityCursor++ % cityPool.length];

  const addPlan = (cadence, type) => {
    const city = nextCity();
    const [cityName, region] = city;
    const make = type === 'convention' ? CONVENTION_NAMES : type === 'tournament' ? TOURNAMENT_NAMES : type === 'pop_culture_con' ? CON_NAMES : CARD_SHOW_NAMES;
    let name = `Sample ${pick(make)(cityName)}`;
    let seriesId = slugify(`${name} ${cityName} ${region}`);
    let n = 2;
    while (usedSeriesIds.has(seriesId)) {
      name = `Sample ${pick(make)(cityName)} ${n}`;
      seriesId = slugify(`${name} ${cityName} ${region}`);
      n++;
    }
    usedSeriesIds.add(seriesId);
    const multi = type === 'pop_culture_con' ? 3 : type === 'convention' ? int(2, 3) : type === 'tournament' ? 2 : chance(0.2) ? 2 : 1;
    plans.push({ cadence, type, city, name, seriesId, multi, promoter: pick(promoters), venueKind: pick(VENUE_KINDS), weekday: multi >= 3 ? 5 : multi === 2 ? 6 : pick([0, 0, 6]), nth: pick([1, 2, 3, 4, -1]) });
  };
  for (let i = 0; i < 12; i++) addPlan('monthly', 'card_show');
  for (let i = 0; i < 14; i++) addPlan('bimonthly', 'card_show');
  for (let i = 0; i < 10; i++) addPlan('quarterly', i % 5 === 0 ? 'convention' : 'card_show');
  for (let i = 0; i < 40; i++) addPlan('annual', pick(['card_show', 'card_show', 'convention', 'tournament', 'pop_culture_con']));
  for (let i = 0; i < 60; i++) addPlan('oneoff', pick(['card_show', 'card_show', 'card_show', 'convention', 'tournament', 'pop_culture_con']));

  const stepMonths = { monthly: 1, bimonthly: 2, quarterly: 3, annual: 12, oneoff: 12 };
  const cadenceText = (p) => {
    const nth = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', '-1': 'last' }[p.nth];
    const wd = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][p.weekday];
    if (p.cadence === 'monthly') return `${nth} ${wd} of most months`;
    if (p.cadence === 'bimonthly') return `${nth} ${wd} every other month`;
    if (p.cadence === 'quarterly') return `${nth} ${wd} each quarter`;
    if (p.cadence === 'annual') return 'once a year';
    return null;
  };

  const shows = [];
  const seriesRecords = [];

  for (const p of plans) {
    const [cityName, region, country, clat, clon, postal, tz] = p.city;
    const currency = country === 'CA' ? 'CAD' : 'USD';
    // one venue per series
    const vlat = clat + (rand() - 0.5) * 0.06;
    const vlon = clon + (rand() - 0.5) * 0.08;
    const precisionRoll = rand();
    const precision = precisionRoll < 0.72 ? 'address' : precisionRoll < 0.88 ? 'venue' : precisionRoll < 0.96 ? 'postal' : 'city';
    const venueName = `Sample ${cityName} ${p.venueKind}`;
    const pos = precision === 'address' || precision === 'venue' ? [Math.round(vlat * 1e4) / 1e4, Math.round(vlon * 1e4) / 1e4] : [Math.round(clat * 100) / 100, Math.round(clon * 100) / 100];
    const venue = {
      name: venueName,
      address: precision === 'city' || precision === 'postal' ? null : `${int(10, 9800)} ${pick(['Main St', 'Fairground Rd', 'Commerce Dr', 'Exposition Blvd', 'Market St', 'Lakeview Ave'])}`,
      city: cityName,
      region,
      postal: precision === 'city' ? null : postal,
      country,
      lat: pos[0],
      lon: pos[1],
      geo_precision: precision,
    };

    const tcgSet = pick(TCG_SETS);
    const sportSet = pick(SPORT_SETS.filter((s) => country !== 'CA' || chance(0.5) || s.includes('hockey')));
    const otherSet = pick(OTHER_SETS);
    const mixRoll = rand();
    let sells;
    if (mixRoll < 0.12) sells = { tcg: [], sports: [], other: [] };
    else if (mixRoll < 0.42) sells = { tcg: [...tcgSet], sports: [], other: [...otherSet] };
    else if (mixRoll < 0.66) sells = { tcg: [], sports: [...sportSet], other: [...otherSet.slice(0, 1)] };
    else sells = { tcg: [...tcgSet], sports: [...sportSet], other: [...otherSet] };
    if (p.type === 'tournament') sells = { tcg: [pick(['pokemon', 'mtg', 'yugioh', 'one_piece', 'lorcana'])], sports: [], other: [] };
    if (p.type === 'pop_culture_con') sells = { tcg: [...tcgSet.slice(0, 2)], sports: [], other: ['comics', 'anime', 'toys'] };
    const mix = sells.tcg.length && sells.sports.length ? 'mixed' : sells.tcg.length ? 'tcg' : sells.sports.length ? 'sports' : 'unknown';

    // edition dates
    const dates = [];
    if (p.cadence === 'oneoff') {
      dates.push(addDays(base, int(-30, 330)));
    } else if (p.cadence === 'annual') {
      const when = addDays(base, int(-20, 340));
      dates.push(when);
    } else {
      const step = stepMonths[p.cadence];
      const phase = int(0, step - 1);
      for (let k = -1; k <= 13; k++) {
        if (((k % step) + step) % step !== phase) continue;
        const total = baseMonth - 1 + k;
        const y = baseYear + Math.floor(total / 12);
        const m = (((total % 12) + 12) % 12) + 1;
        const start = nthWeekday(y, m, p.weekday, p.nth);
        dates.push(start);
      }
    }
    const inWindow = dates.filter((d) => d >= windowStart && d <= windowEnd);
    if (inWindow.length === 0) continue;

    const baseTables = p.type === 'convention' ? int(120, 600) : p.type === 'tournament' ? int(30, 150) : p.type === 'pop_culture_con' ? int(80, 400) : Math.round(Math.exp(3 + rand() * 3.2));
    const firstYear = baseYear - int(1, 12);
    const tablesKnown = chance(0.72);
    const adultPrice = chance(0.28) ? 0 : pick([3, 5, 5, 8, 10, 12, 15, 20]);
    const hasVendor = chance(0.62);
    const price = Math.round((baseTables > 150 ? 120 : 45) + rand() * 90);
    const vendorNote = chance(0.25) ? 'Load in the night before is available' : null;
    const confirmed = chance(0.3);
    const attendanceReported = chance(0.16);
    const editionNumberStart = int(1, 40);
    const editionIds = [];

    inWindow.forEach((date, idx) => {
      const days = [];
      const open = p.type === 'tournament' ? '09:00' : p.type === 'pop_culture_con' || p.type === 'convention' ? '10:00' : pick(['09:00', '10:00', '10:00']);
      const close = p.type === 'tournament' ? '20:00' : p.type === 'pop_culture_con' ? '18:00' : p.type === 'convention' ? '17:00' : pick(['14:00', '15:00', '16:00']);
      const hoursKnown = chance(0.88);
      for (let d = 0; d < p.multi; d++) {
        const last = d === p.multi - 1;
        days.push({
          date: addDays(date, d),
          open: hoursKnown ? open : null,
          close: hoursKnown ? (last && p.multi > 1 ? close.replace(/^\d\d/, (h) => pad(Math.max(10, Number(h) - 2))) : close) : null,
        });
      }
      const idRoll = rand();
      const status = idRoll < 0.9 ? 'scheduled' : idRoll < 0.96 ? 'tentative' : idRoll < 0.98 ? 'postponed' : 'cancelled';
      const id = `${p.seriesId}-${date}`;
      editionIds.push(id);

      const tables = tablesKnown ? Math.max(8, Math.round(baseTables * (0.9 + rand() * 0.25))) : null;
      const players = p.type === 'tournament' ? int(250, 2400) : null;
      const size = {
        tables,
        booths: tablesKnown && chance(0.1) ? Math.round(tables * 0.6) : null,
        venue_sqft: chance(0.18) ? pick(SQFT) : null,
        players,
        reported_attendance: attendanceReported && date < base ? { value: Math.round((tables ?? baseTables) * 6.4 * p.multi * 0.85), year: Number(date.slice(0, 4)), source_url: 'https://example.com/sample-recap' } : null,
        first_year: firstYear,
        edition: chance(0.5) ? editionNumberStart + idx : null,
      };

      // vendor info
      let vendor = { tables: [], application_url: null, opens: null, deadline: null, status: 'unknown', electricity: null, setup: null, contact: null, notes: null };
      if (hasVendor && p.type !== 'tournament') {
        const deadline = addDays(date, -int(14, 45));
        const opens = addDays(deadline, -int(30, 80));
        let vstatus;
        const r = rand();
        if (deadline < base) vstatus = r < 0.55 ? 'closed' : r < 0.75 ? 'waitlist' : r < 0.9 ? 'sold_out' : 'unknown';
        else vstatus = r < 0.62 ? 'open' : r < 0.77 ? 'waitlist' : r < 0.9 ? 'sold_out' : 'unknown';
        const sizes = chance(0.5) ? [{ label: '6 ft table', price, currency, notes: null }, { label: '8 ft table', price: price + 25, currency, notes: chance(0.5) ? '2 badges included' : null }] : [{ label: '8 ft table', price, currency, notes: '2 badges included' }];
        vendor = {
          tables: sizes,
          application_url: `https://example.com/sample-vendors/${p.seriesId}`,
          opens,
          deadline,
          status: vstatus,
          electricity: chance(0.4) ? `25 ${currency} extra` : null,
          setup: chance(0.5) ? pick(['07:00', '08:00']) : null,
          contact: 'vendors@example.com',
          notes: vendorNote,
        };
      }

      // estimate
      let estimate = null;
      if (chance(0.88)) {
        const perDay = p.type === 'convention' ? 14 : p.type === 'pop_culture_con' ? 24 : p.type === 'tournament' ? 1.4 : 5.8;
        const dayFactor = 1 + 0.6 * (p.multi - 1);
        let mid;
        let basis;
        let confidence;
        let explain;
        if (size.reported_attendance) {
          mid = size.reported_attendance.value;
          basis = 'reported';
          confidence = 'reported';
          explain = `Reported by the organizer for ${size.reported_attendance.year}.`;
        } else if (p.type === 'tournament' && players) {
          mid = Math.round(players * perDay * 1.1);
          basis = 'players';
          confidence = 'estimated';
          explain = `Estimated from ${players} players registered at the last event.`;
        } else if (tables) {
          mid = Math.round(tables * perDay * dayFactor);
          basis = 'tables';
          confidence = 'estimated';
          explain = `Estimated from ${tables} vendor tables at a ${p.multi === 1 ? 'one day' : `${p.multi} day`} ${p.type === 'card_show' ? 'card show' : p.type === 'convention' ? 'convention' : p.type === 'pop_culture_con' ? 'pop culture con' : 'tournament'}.`;
        } else {
          mid = p.type === 'convention' ? 2500 : p.type === 'pop_culture_con' ? 4000 : 450;
          basis = 'type_default';
          confidence = 'rough';
          explain = 'Rough guess from the type of event. We do not know how many tables there are.';
        }
        const sizeClass = mid < 500 ? 'small' : mid < 1500 ? 'medium' : mid < 5000 ? 'large' : 'major';
        estimate = {
          attendance: { low: Math.round(mid * 0.6), mid, high: Math.round(mid * 1.6) },
          basis,
          confidence,
          size_class: sizeClass,
          traffic_per_table: tables ? Math.round((mid / tables) * 10) / 10 : null,
          explain,
        };
      }

      const verRoll = rand();
      const verification = confirmed || verRoll < 0.12 ? 'organizer_confirmed' : verRoll < 0.72 ? 'listed' : verRoll < 0.88 ? 'community' : 'unverified';
      const lastChecked = addDays(base, -(chance(0.12) ? int(46, 90) : int(0, 20)));
      const sources = [
        { source: 'fixture', url: `https://example.com/sample-listing/${id}`, retrieved: lastChecked, fields: ['name', 'days', 'venue', 'admission'] },
      ];
      if (verification === 'organizer_confirmed') sources.push({ source: 'fixture_organizer', url: `https://example.com/sample/${p.seriesId}`, retrieved: lastChecked, fields: ['days', 'vendor.tables'] });

      shows.push({
        id,
        series_id: p.seriesId,
        name: p.name,
        event_type: p.type,
        status,
        days,
        timezone: tz,
        venue: { ...venue },
        sells: { tcg: [...sells.tcg], sports: [...sells.sports], other: [...sells.other] },
        mix,
        admission: { free: adultPrice === 0, adult: adultPrice, child: adultPrice === 0 ? 0 : chance(0.5) ? 0 : Math.round(adultPrice / 2), currency, notes: adultPrice > 0 && chance(0.4) ? 'Under 12 free' : null },
        size,
        vendor,
        organizer: { name: p.promoter.name, promoter_id: p.promoter.id, url: p.promoter.url },
        links: { official: `https://example.com/sample/${p.seriesId}`, tickets: chance(0.15) ? `https://example.com/sample-tickets/${p.seriesId}` : null, facebook: null, instagram: null },
        sources,
        verification,
        first_seen: addDays(lastChecked, -int(5, 120)),
        last_checked: lastChecked,
        summary: chance(0.3) ? `A ${p.cadence === 'oneoff' ? 'one time' : p.cadence === 'annual' ? 'yearly' : p.cadence} sample listing at ${venueName}. This is made up for testing.` : null,
        estimate,
      });
    });

    p.promoter.series.push(p.seriesId);
    seriesRecords.push({
      id: p.seriesId,
      name: p.name,
      promoter_id: p.promoter.id,
      venue: { name: venueName, city: cityName, region },
      cadence: cadenceText(p),
      editions: editionIds,
      links: { official: `https://example.com/sample/${p.seriesId}` },
      history: chance(0.4) ? [{ year: baseYear - 1, attendance: Math.round(baseTables * 6 * p.multi) }, { year: baseYear - 2, attendance: Math.round(baseTables * 5.2 * p.multi) }] : [],
    });
  }

  shows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // store events
  const STORE_GAMES = [
    ['pokemon', 'Pokémon Prerelease'],
    ['mtg', 'Magic Prerelease'],
    ['mtg', 'Friday Night Magic'],
    ['yugioh', 'Yu-Gi-Oh Locals'],
    ['one_piece', 'One Piece Store Tournament'],
    ['lorcana', 'Lorcana League Night'],
    ['pokemon', 'Pokémon League Challenge'],
  ];
  const storeEvents = [];
  for (let i = 0; i < 64; i++) {
    const city = CITIES[(i * 7) % CITIES.length];
    const [cityName, region, country, clat, clon, postal, tz] = city;
    const [game, label] = STORE_GAMES[i % STORE_GAMES.length];
    const date = addDays(base, int(-10, 120));
    const name = `Sample ${label} at Sample Game Shop ${cityName}`;
    const seriesId = slugify(`${name} ${cityName} ${region}`);
    const id = `${seriesId}-${date}`;
    storeEvents.push({
      id,
      series_id: seriesId,
      name,
      event_type: 'store_event',
      status: 'scheduled',
      days: [{ date, open: '18:00', close: '21:00' }],
      timezone: tz,
      venue: { name: `Sample Game Shop ${cityName}`, address: `${int(10, 900)} Main St`, city: cityName, region, postal, country, lat: Math.round((clat + (rand() - 0.5) * 0.05) * 1e4) / 1e4, lon: Math.round((clon + (rand() - 0.5) * 0.07) * 1e4) / 1e4, geo_precision: 'address' },
      sells: { tcg: [game], sports: [], other: [] },
      mix: 'tcg',
      admission: { free: false, adult: pick([5, 10, 15, 30]), child: null, currency: country === 'CA' ? 'CAD' : 'USD', notes: null },
      size: { tables: null, booths: null, venue_sqft: null, players: int(8, 64), reported_attendance: null, first_year: null, edition: null },
      vendor: { tables: [], application_url: null, opens: null, deadline: null, status: 'unknown', electricity: null, setup: null, contact: null, notes: null },
      organizer: { name: `Sample Game Shop ${cityName}`, promoter_id: null, url: null },
      links: { official: `https://example.com/sample-store/${seriesId}`, tickets: null, facebook: null, instagram: null },
      sources: [{ source: 'fixture', url: `https://example.com/sample-store-listing/${id}`, retrieved: base, fields: ['name', 'days', 'venue'] }],
      verification: 'listed',
      first_seen: base,
      last_checked: base,
      summary: null,
      estimate: null,
    });
  }
  storeEvents.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // postal tables
  const postalUS = {};
  const postalCA = {};
  for (const [, , country, lat, lon, postal] of CITIES) {
    if (country === 'US') postalUS[postal] = [Math.round(lat * 100) / 100, Math.round(lon * 100) / 100];
    else postalCA[postal.slice(0, 3)] = [Math.round(lat * 100) / 100, Math.round(lon * 100) / 100];
  }
  // a few more near-by codes so a typed code often differs slightly from a city centre
  const extraUS = { '08817': [40.5, -74.37], '08901': [40.49, -74.45], '19104': [39.96, -75.2], '10036': [40.76, -73.99], '60614': [41.92, -87.65], '90210': [34.1, -118.41], '30309': [33.8, -84.39], '75204': [32.8, -96.79] };
  Object.assign(postalUS, extraUS);
  const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

  const byType = {};
  const byCountry = {};
  for (const s of shows) {
    byType[s.event_type] = (byType[s.event_type] ?? 0) + 1;
    byCountry[s.venue.country] = (byCountry[s.venue.country] ?? 0) + 1;
  }
  const manifest = {
    built: `${base}T00:00:00Z`,
    fixture: true,
    fixture_base: base,
    counts: { shows: shows.length, by_type: byType, by_country: byCountry },
    sources: [
      { id: 'fixture', name: 'Sample listing (made up)', url: 'https://example.com', kind: 'aggregator', credit: 'Sample data. This listing is made up for testing.' },
      { id: 'fixture_organizer', name: 'Sample organizer page (made up)', url: 'https://example.com', kind: 'promoter', credit: 'Sample data. This organizer is made up for testing.' },
    ],
  };

  const usedPromoters = promoters.filter((p) => p.series.length > 0);
  return {
    'shows.json': shows,
    'store_events.json': storeEvents,
    'series.json': seriesRecords.sort((a, b) => (a.id < b.id ? -1 : 1)),
    'promoters.json': usedPromoters,
    'vocab.json': DEFAULT_VOCAB,
    'manifest.json': manifest,
    'postal/US.json': sortKeys(postalUS),
    'postal/CA.json': sortKeys(postalCA),
  };
}

export function writeFixtures({ base, dir = OUT }) {
  const files = generateFixtures({ base });
  fs.mkdirSync(path.join(dir, 'postal'), { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    let text;
    if (Array.isArray(data)) text = `[\n${data.map((x) => JSON.stringify(x)).join(',\n')}\n]\n`; // one record per line
    else text = name.startsWith('postal/') ? JSON.stringify(data) : `${JSON.stringify(data, null, 1)}\n`;
    fs.writeFileSync(path.join(dir, name), text);
  }
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--base');
  const base = i >= 0 ? process.argv[i + 1] : new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(base)) {
    console.error('--base needs a date like 2026-10-21');
    process.exit(1);
  }
  const files = writeFixtures({ base });
  console.log(`fixtures: wrote ${files['shows.json'].length} sample shows, ${files['store_events.json'].length} sample store events (base ${base}) to fixtures/data/`);
}
