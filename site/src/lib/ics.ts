// Calendar (.ics) output, RFC 5545. One event per show day when opening times are known, otherwise
// one all day event. Times are written in UTC (converted from the show's own time zone) so every
// calendar app reads them the same way, with no VTIMEZONE block needed.
import { addDays, formatMonthDay, parseISODate } from './dates.ts';
import { formatMoney } from './format.ts';
import type { Show, ShowStatus } from './types.ts';

const CRLF = '\r\n';
const PRODID = '-//Card Show Atlas//Calendar export//EN';

export interface IcsShow {
  id: string;
  name: string;
  days: { date: string; open: string | null; close: string | null }[];
  timezone: string | null;
  location: string | null;
  url: string | null;
  description: string | null;
  status: ShowStatus;
}

export interface IcsReminder {
  /** stable id, used in the event's UID */
  uid: string;
  /** the day the reminder is about, such as an application deadline */
  date: string;
  summary: string;
  description: string | null;
  url: string | null;
  /** alarms, in days before the date */
  daysBefore: number[];
}

/** Escape text values: backslash, semicolon, comma and line breaks. */
export function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}

/** Fold a content line to 75 octets, never splitting a character. Continuation lines begin with a space. */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > limit) {
      parts.push(current);
      current = '';
      bytes = 0;
      limit = 74;
    }
    current += ch;
    bytes += n;
  }
  if (current) parts.push(current);
  return parts.join(`${CRLF} `);
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/** "20261114" */
export function icsDate(iso: string): string {
  return iso.replace(/-/g, '');
}

function utcStamp(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function zoneOffsetMinutes(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const hour = get('hour') === 24 ? 0 : get('hour');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return (asUtc - utcMs) / 60000;
}

/**
 * The UTC instant (in milliseconds) of a wall clock date and time in an IANA time zone, or null
 * when the zone name is not understood.
 */
export function zonedToUtcMs(date: string, hhmm: string, timeZone: string): number | null {
  const p = parseISODate(date);
  const t = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!p || !t) return null;
  const guess = Date.UTC(p.y, p.m - 1, p.d, Number(t[1]), Number(t[2]));
  try {
    const off1 = zoneOffsetMinutes(guess, timeZone);
    let ms = guess - off1 * 60000;
    const off2 = zoneOffsetMinutes(ms, timeZone);
    if (off2 !== off1) ms = guess - off2 * 60000;
    return ms;
  } catch {
    return null;
  }
}

function floating(date: string, hhmm: string): string {
  const [h = '0', m = '0'] = hhmm.split(':');
  return `${icsDate(date)}T${pad(Number(h))}${pad(Number(m))}00`;
}

function prop(name: string, value: string): string {
  return `${name}:${value}`;
}

function statusLine(status: ShowStatus): string {
  return status === 'cancelled' ? 'CANCELLED' : status === 'scheduled' ? 'CONFIRMED' : 'TENTATIVE';
}

function summaryFor(show: IcsShow): string {
  if (show.status === 'postponed') return `${show.name} (postponed)`;
  if (show.status === 'cancelled') return `${show.name} (cancelled)`;
  if (show.status === 'tentative') return `${show.name} (date not confirmed)`;
  return show.name;
}

function commonLines(show: IcsShow): string[] {
  const lines: string[] = [];
  lines.push(prop('SUMMARY', escapeText(summaryFor(show))));
  if (show.location) lines.push(prop('LOCATION', escapeText(show.location)));
  if (show.description) lines.push(prop('DESCRIPTION', escapeText(show.description)));
  if (show.url) lines.push(prop('URL', show.url));
  lines.push(`STATUS:${statusLine(show.status)}`);
  return lines;
}

/** The VEVENT blocks (as lists of lines) for one show. */
export function showEvents(show: IcsShow, now: Date): string[][] {
  const stamp = utcStamp(now.getTime());
  const days = [...show.days].sort((a, b) => (a.date < b.date ? -1 : 1));
  if (days.length === 0) return [];
  const allTimed = days.every((d) => d.open);
  if (allTimed) {
    return days.map((d) => {
      const startMs = show.timezone ? zonedToUtcMs(d.date, d.open as string, show.timezone) : null;
      let dtstart: string;
      let dtend: string;
      if (startMs !== null && show.timezone) {
        const endMs = d.close ? zonedToUtcMs(d.date, d.close, show.timezone) : null;
        dtstart = `DTSTART:${utcStamp(startMs)}`;
        dtend = `DTEND:${utcStamp(endMs !== null && endMs > startMs ? endMs : startMs + 4 * 3600000)}`;
      } else {
        dtstart = `DTSTART:${floating(d.date, d.open as string)}`;
        dtend = `DTEND:${floating(d.date, d.close ?? addHours(d.open as string, 4))}`;
      }
      return ['BEGIN:VEVENT', `UID:${show.id}-${d.date}@card-show-atlas`, `DTSTAMP:${stamp}`, dtstart, dtend, ...commonLines(show), 'END:VEVENT'];
    });
  }
  const first = (days[0] as { date: string }).date;
  const last = (days[days.length - 1] as { date: string }).date;
  return [
    [
      'BEGIN:VEVENT',
      `UID:${show.id}@card-show-atlas`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(first)}`,
      `DTEND;VALUE=DATE:${icsDate(addDays(last, 1))}`,
      ...commonLines(show),
      'END:VEVENT',
    ],
  ];
}

function addHours(hhmm: string, h: number): string {
  const [hh = '0', mm = '0'] = hhmm.split(':');
  const total = Math.min(23 * 60 + 59, Number(hh) * 60 + Number(mm) + h * 60);
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/** All day reminder event with an alarm for each of `daysBefore`. */
export function reminderEvent(r: IcsReminder, now: Date): string[] {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${r.uid}@card-show-atlas`,
    `DTSTAMP:${utcStamp(now.getTime())}`,
    `DTSTART;VALUE=DATE:${icsDate(r.date)}`,
    `DTEND;VALUE=DATE:${icsDate(addDays(r.date, 1))}`,
    prop('SUMMARY', escapeText(r.summary)),
  ];
  if (r.description) lines.push(prop('DESCRIPTION', escapeText(r.description)));
  if (r.url) lines.push(prop('URL', r.url));
  lines.push('TRANSP:TRANSPARENT');
  for (const days of [...r.daysBefore].sort((a, b) => b - a)) {
    const when = days === 1 ? 'tomorrow' : `in ${days} days`;
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      prop('DESCRIPTION', escapeText(`${r.summary} (${when}, ${formatMonthDay(r.date)})`)),
      `TRIGGER:-P${days}D`,
      'END:VALARM',
    );
  }
  lines.push('END:VEVENT');
  return lines;
}

export interface CalendarInput {
  name: string;
  now?: Date;
  shows?: IcsShow[];
  reminders?: IcsReminder[];
}

/** A complete .ics file (CRLF line endings). */
export function buildCalendar(input: CalendarInput): string {
  const now = input.now ?? new Date();
  const lines: string[] = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${PRODID}`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', prop('X-WR-CALNAME', escapeText(input.name))];
  for (const s of input.shows ?? []) for (const ev of showEvents(s, now)) lines.push(...ev);
  for (const r of input.reminders ?? []) lines.push(...reminderEvent(r, now));
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join(CRLF) + CRLF;
}

/** Turn a full show record into calendar input. */
export function icsShowFrom(show: Show, pageUrl: string | null): IcsShow {
  const v = show.venue;
  const location = [v.name, v.address, [v.city, v.region].filter(Boolean).join(', '), v.postal].filter(Boolean).join(', ');
  const bits: string[] = [];
  if (show.admission.free) bits.push('Free entry');
  else if (show.admission.adult !== null) bits.push(`Entry ${formatMoney(show.admission.adult, show.admission.currency)}`);
  if (show.vendor.deadline) bits.push(`Vendors apply by ${formatMonthDay(show.vendor.deadline, true)}`);
  if (pageUrl) bits.push(`Details: ${pageUrl}`);
  bits.push('Check the organizer before you travel.');
  return {
    id: show.id,
    name: show.name,
    days: show.days,
    timezone: show.timezone,
    location: location || null,
    url: pageUrl,
    description: bits.join('\n'),
    status: show.status,
  };
}

/** A .ics file for one show page. */
export function showIcs(show: Show, pageUrl: string | null, now: Date = new Date()): string {
  return buildCalendar({ name: show.name, now, shows: [icsShowFrom(show, pageUrl)] });
}

/** A safe file name for a download. */
export function fileNameFor(base: string, ext: string): string {
  const slug = base
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'card-show'}.${ext}`;
}
