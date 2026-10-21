// Plain words and map symbols for the data's codes.
import type { EventType, GeoPrecision, ShowStatus, SizeClass, VendorStatus, Verification } from './types.ts';

export type MarkerShape = 'circle' | 'square' | 'diamond' | 'triangle' | 'hexagon';

export interface EventTypeInfo {
  label: string;
  plural: string;
  blurb: string;
  /** marker colour: from a colour blind safe palette */
  color: string;
  /** marker shape: so colour is never the only cue */
  shape: MarkerShape;
}

export const EVENT_TYPE_INFO: Record<EventType, EventTypeInfo> = {
  card_show: { label: 'Card show', plural: 'Card shows', blurb: 'Tables of dealers buying, selling and trading cards.', color: '#0072b2', shape: 'circle' },
  convention: { label: 'Convention', plural: 'Conventions', blurb: 'A larger collectibles or card convention.', color: '#d55e00', shape: 'square' },
  tournament: { label: 'Tournament', plural: 'Tournaments', blurb: 'A big tournament with a vendor hall.', color: '#007a5a', shape: 'diamond' },
  pop_culture_con: { label: 'Pop culture con', plural: 'Pop culture cons', blurb: 'A comic, anime or gaming con with card vendors.', color: '#b0408a', shape: 'triangle' },
  store_event: { label: 'Store event', plural: 'Store events', blurb: 'Prereleases, leagues and weekly tournaments at a store.', color: '#9a6a00', shape: 'hexagon' },
};

/** The four kinds of show, in the order they are offered as filters (store events are a separate layer). */
export const SHOW_EVENT_TYPES: EventType[] = ['card_show', 'convention', 'tournament', 'pop_culture_con'];

export const SIZE_INFO: Record<SizeClass, { label: string; bars: number; blurb: string }> = {
  small: { label: 'Small', bars: 1, blurb: 'Under about 500 people' },
  medium: { label: 'Medium', bars: 2, blurb: 'Roughly 500 to 1,500 people' },
  large: { label: 'Large', bars: 3, blurb: 'Roughly 1,500 to 5,000 people' },
  major: { label: 'Major', bars: 4, blurb: 'Thousands of people over the weekend' },
};

export const SIZE_ORDER: SizeClass[] = ['small', 'medium', 'large', 'major'];

export const SHOW_STATUS_LABEL: Record<ShowStatus, string> = {
  scheduled: 'Scheduled',
  tentative: 'Date not confirmed',
  postponed: 'Postponed',
  cancelled: 'Cancelled',
};

export const VENDOR_STATUS_LABEL: Record<VendorStatus, string> = {
  open: 'Tables open',
  waitlist: 'Waitlist only',
  sold_out: 'Sold out',
  closed: 'Applications closed',
  unknown: 'Vendor status unknown',
};

export const VERIFICATION_LABEL: Record<Verification, string> = {
  organizer_confirmed: 'Confirmed by organizer',
  listed: 'Listed by another site',
  community: 'Community submitted',
  unverified: 'Not yet verified',
};

export const VERIFICATION_CODE_LABEL: Record<'o' | 'l' | 'c' | 'u', string> = {
  o: VERIFICATION_LABEL.organizer_confirmed,
  l: VERIFICATION_LABEL.listed,
  c: VERIFICATION_LABEL.community,
  u: VERIFICATION_LABEL.unverified,
};

export function precisionNote(p: GeoPrecision): string | null {
  switch (p) {
    case 'postal':
      return 'Approximate location: only the postal code area is known.';
    case 'city':
      return 'Approximate location: only the town is known.';
    default:
      return null;
  }
}

export function isApproximate(p: GeoPrecision | undefined): boolean {
  return p === 'postal' || p === 'city';
}

// ---------- marker graphics ----------

const SHAPES: Record<MarkerShape, (attrs: string) => string> = {
  circle: (a) => `<circle cx="12" cy="12" r="8.5" ${a}/>`,
  square: (a) => `<rect x="4" y="4" width="16" height="16" rx="2.2" ${a}/>`,
  diamond: (a) => `<polygon points="12,2.5 21.5,12 12,21.5 2.5,12" ${a}/>`,
  triangle: (a) => `<polygon points="12,3 21.8,20.5 2.2,20.5" ${a}/>`,
  hexagon: (a) => `<polygon points="12,2.5 20.2,7.2 20.2,16.8 12,21.5 3.8,16.8 3.8,7.2" ${a}/>`,
};

/**
 * The marker for an event type as inline SVG. Exact locations are solid; approximate ones are
 * lighter with a dashed outline.
 */
export function markerSvg(type: EventType, opts: { soft?: boolean; size?: number } = {}): string {
  const { color, shape } = EVENT_TYPE_INFO[type];
  const size = opts.size ?? 28;
  const attrs = opts.soft
    ? `fill="${color}" fill-opacity="0.35" stroke="${color}" stroke-width="2" stroke-dasharray="3 2.2"`
    : `fill="${color}" stroke="#ffffff" stroke-width="2.2" stroke-linejoin="round"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false">${SHAPES[shape](attrs)}</svg>`;
}
