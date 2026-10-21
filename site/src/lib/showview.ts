// What a show page says, as plain text pieces. Kept out of the page template so it can be tested.
import { daysBetween, formatDayLong, formatHours, formatMonthDay, formatRange, timeZoneAbbreviation } from './dates.ts';
import { STALE_AFTER_DAYS } from './config.ts';
import { formatMoney, formatNumber, roundedCount } from './format.ts';
import { precisionNote, SHOW_STATUS_LABEL, SIZE_INFO } from './labels.ts';
import type { ManifestSource, Show, Verification } from './types.ts';

export function firstDay(show: Show): string {
  return show.days[0]?.date ?? '';
}

export function lastDay(show: Show): string {
  return show.days[show.days.length - 1]?.date ?? firstDay(show);
}

export function isPast(show: Show, today: string): boolean {
  return lastDay(show) < today;
}

/** "Nov 14 to 15, 2026" */
export function whenHeadline(show: Show): string {
  const a = firstDay(show);
  const b = lastDay(show);
  const sameYear = a.slice(0, 4) === b.slice(0, 4);
  const range = formatRange(a, b);
  return sameYear ? `${range}, ${a.slice(0, 4)}` : range;
}

export interface DayRow {
  date: string;
  label: string;
  hours: string;
  zone: string;
}

export function dayRows(show: Show): DayRow[] {
  return show.days.map((d) => ({
    date: d.date,
    label: formatDayLong(d.date),
    hours: formatHours(d.open, d.close) || 'Hours not listed',
    zone: formatHours(d.open, d.close) ? timeZoneAbbreviation(show.timezone, d.date) : '',
  }));
}

export function placeLine(show: Show): string {
  const v = show.venue;
  return [v.name, `${v.city}, ${v.region}`].filter(Boolean).join(', ');
}

export function addressLines(show: Show): string[] {
  const v = show.venue;
  const out: string[] = [];
  if (v.name) out.push(v.name);
  if (v.address) out.push(v.address);
  out.push([`${v.city}, ${v.region}`, v.postal].filter(Boolean).join(' '));
  return out;
}

/** A directions link that opens in a maps app. */
export function directionsUrl(show: Show): string | null {
  const v = show.venue;
  if (v.lat !== null && v.lon !== null && (v.geo_precision === 'address' || v.geo_precision === 'venue')) {
    return `https://www.google.com/maps/dir/?api=1&destination=${v.lat},${v.lon}`;
  }
  const text = [v.name, v.address, v.city, v.region, v.postal].filter(Boolean).join(', ');
  return text ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(text)}` : null;
}

export function openStreetMapUrl(show: Show): string | null {
  const v = show.venue;
  if (v.lat === null || v.lon === null) return null;
  return `https://www.openstreetmap.org/?mlat=${v.lat}&mlon=${v.lon}#map=15/${v.lat}/${v.lon}`;
}

export function statusNotice(show: Show): { kind: 'bad' | 'warn'; text: string } | null {
  switch (show.status) {
    case 'cancelled':
      return { kind: 'bad', text: 'This show has been cancelled. Do not travel for it.' };
    case 'postponed':
      return { kind: 'warn', text: 'This show has been postponed. The dates below are the old ones. Check the organizer for new dates.' };
    case 'tentative':
      return { kind: 'warn', text: 'The date is not confirmed yet. It may be a usual schedule, such as "second Sunday", that the organizer has not announced.' };
    default:
      return null;
  }
}

export function staleNotice(show: Show, today: string): string | null {
  if (!show.last_checked || isPast(show, today)) return null;
  const age = daysBetween(show.last_checked, today);
  return age > STALE_AFTER_DAYS ? `This listing was last checked ${age} days ago and may be out of date.` : null;
}

export function lastCheckedText(show: Show): string {
  return show.last_checked ? formatMonthDay(show.last_checked, true) : 'Not checked yet';
}

export function approximateNotice(show: Show): string | null {
  return precisionNote(show.venue.geo_precision);
}

export function entryLines(show: Show): string[] {
  const a = show.admission;
  const lines: string[] = [];
  if (a.free === true || a.adult === 0) lines.push('Free entry');
  else if (a.adult !== null) lines.push(`Adults ${formatMoney(a.adult, a.currency)}`);
  if (a.free !== true && a.adult !== 0 && a.child !== null) lines.push(a.child === 0 ? 'Children free' : `Children ${formatMoney(a.child, a.currency)}`);
  if (a.notes) lines.push(a.notes);
  if (lines.length === 0) lines.push('Entry price not listed');
  return lines;
}

// ---------- size ----------

const CONFIDENCE_TEXT = { reported: 'Reported', estimated: 'Estimated', rough: 'Rough guess' } as const;

export interface SizeView {
  badge: string;
  how: string;
  confidence: string;
  range: string | null;
  traffic: string | null;
}

/** The size badge's "how we know" text and the numbers behind it. */
export function sizeView(show: Show): SizeView {
  const e = show.estimate;
  if (!e) {
    return {
      badge: 'Size unknown',
      how: 'We do not have enough information to estimate how big this show is yet.',
      confidence: 'Unknown',
      range: null,
      traffic: null,
    };
  }
  const explain =
    e.explain ||
    ({
      reported: 'Reported by the organizer.',
      players: 'Estimated from player counts.',
      tables: show.size.tables ? `Estimated from ${show.size.tables} vendor tables.` : 'Estimated from the number of vendor tables.',
      area: 'Estimated from the size of the venue.',
      history: 'Estimated from past years.',
      type_default: 'A rough guess from the type of event.',
    }[e.basis] ?? '');
  const { low, mid, high } = e.attendance;
  return {
    badge: SIZE_INFO[e.size_class].label,
    how: explain,
    confidence: CONFIDENCE_TEXT[e.confidence] ?? 'Estimated',
    range: `About ${formatNumber(roundedCount(low))} to ${formatNumber(roundedCount(high))} people, most likely around ${formatNumber(roundedCount(mid))}`,
    traffic: e.traffic_per_table !== null ? `${e.traffic_per_table} people per table` : null,
  };
}

// ---------- vendors ----------

export interface VendorView {
  hasInfo: boolean;
  statusText: string;
  statusKind: 'ok' | 'warn' | 'bad' | 'plain';
}

export function vendorView(show: Show): VendorView {
  const v = show.vendor;
  const hasInfo = v.tables.length > 0 || !!v.application_url || !!v.deadline || !!v.opens || v.status !== 'unknown' || !!v.electricity || !!v.setup || !!v.contact || !!v.notes;
  const map = {
    open: { statusText: 'Tables are open', statusKind: 'ok' },
    waitlist: { statusText: 'Waitlist only', statusKind: 'warn' },
    sold_out: { statusText: 'Sold out', statusKind: 'bad' },
    closed: { statusText: 'Applications are closed', statusKind: 'bad' },
    unknown: { statusText: 'Table status unknown', statusKind: 'plain' },
  } as const;
  return { hasInfo, ...map[v.status] };
}

// ---------- sources ----------

export interface SourceView {
  name: string;
  credit: string;
  url: string | null;
  retrieved: string | null;
  fields: string;
}

export function sourceViews(show: Show, byId: Map<string, ManifestSource>): SourceView[] {
  return show.sources.map((s) => {
    const meta = byId.get(s.source);
    const name = meta?.name ?? s.source.replace(/_/g, ' ');
    return {
      name,
      credit: meta?.credit ?? `Listed by ${name}`,
      url: s.url ?? meta?.url ?? null,
      retrieved: s.retrieved ? formatMonthDay(s.retrieved, true) : null,
      fields: s.fields.join(', ').replace(/_/g, ' '),
    };
  });
}

export function verificationView(show: Show, byId: Map<string, ManifestSource>): { text: string; kind: 'ok' | 'accent' | 'plain'; explain: string } {
  const v: Verification = show.verification;
  if (v === 'organizer_confirmed') {
    return { text: 'Confirmed by organizer', kind: 'ok', explain: 'Seen on the organizer’s own page or post.' };
  }
  if (v === 'community') {
    return { text: 'Community submitted', kind: 'accent', explain: 'Sent in by a visitor and reviewed. The organizer has not confirmed it yet.' };
  }
  if (v === 'listed') {
    const first = show.sources[0];
    const meta = first ? byId.get(first.source) : undefined;
    const name = meta?.name ?? (first ? first.source.replace(/_/g, ' ') : 'another site');
    return { text: `Listed by ${name}`, kind: 'accent', explain: 'Seen on a listing site. The organizer’s own page has not confirmed it yet.' };
  }
  return { text: 'Not yet verified', kind: 'plain', explain: 'We have not been able to check this against a source we trust.' };
}

export function statusBadge(show: Show): string | null {
  return show.status === 'scheduled' ? null : SHOW_STATUS_LABEL[show.status];
}

// ---------- search engines ----------

export function jsonLdFor(show: Show, url: string): Record<string, unknown> {
  const v = show.venue;
  const status =
    show.status === 'cancelled' ? 'https://schema.org/EventCancelled' : show.status === 'postponed' ? 'https://schema.org/EventPostponed' : 'https://schema.org/EventScheduled';
  const first = show.days[0];
  const last = show.days[show.days.length - 1];
  return {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: show.name,
    startDate: first ? (first.open ? `${first.date}T${first.open}` : first.date) : undefined,
    endDate: last ? (last.close ? `${last.date}T${last.close}` : last.date) : undefined,
    eventStatus: status,
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    url,
    location: {
      '@type': 'Place',
      name: v.name ?? `${v.city}, ${v.region}`,
      address: {
        '@type': 'PostalAddress',
        streetAddress: v.address ?? undefined,
        addressLocality: v.city,
        addressRegion: v.region,
        postalCode: v.postal ?? undefined,
        addressCountry: v.country,
      },
    },
    isAccessibleForFree: show.admission.free === true || show.admission.adult === 0 ? true : undefined,
    organizer: show.organizer.name ? { '@type': 'Organization', name: show.organizer.name, url: show.organizer.url ?? undefined } : undefined,
  };
}
