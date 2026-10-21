// Postal code lookup. The data files (public/data/postal/US.json and CA.json) map a code to
// [lat, lon]: {"08837": [40.52, -74.35]} for the US (five digit ZIP), and {"M5V": [43.64, -79.4]}
// for Canada, keyed by the first three characters (the forward sortation area).

export type PostalCountry = 'US' | 'CA';
export type PostalTable = Record<string, [number, number]>;

export interface PostalQuery {
  country: PostalCountry;
  /** the key used in the data file */
  key: string;
  /** the code as it will be shown: "08837" or "M5V" */
  display: string;
}

const US_ZIP = /^(\d{5})(?:[- ]?\d{4})?$/;
const CA_POSTAL = /^([A-Z]\d[A-Z])(?:[ -]?(?:\d[A-Z]\d)?)$/;

/** Work out what kind of code was typed. Returns null when it is neither a ZIP nor a postal code. */
export function parsePostalInput(input: string): PostalQuery | null {
  const text = input.trim().toUpperCase();
  if (!text) return null;
  const us = US_ZIP.exec(text);
  if (us) return { country: 'US', key: us[1] as string, display: us[1] as string };
  const ca = CA_POSTAL.exec(text.replace(/\s+/g, ' '));
  if (ca) return { country: 'CA', key: ca[1] as string, display: ca[1] as string };
  return null;
}

export function lookupInTable(table: PostalTable, q: PostalQuery): { lat: number; lon: number } | null {
  const hit = table[q.key];
  if (!Array.isArray(hit) || typeof hit[0] !== 'number' || typeof hit[1] !== 'number') return null;
  return { lat: hit[0], lon: hit[1] };
}

export type PostalResult =
  | { ok: true; lat: number; lon: number; country: PostalCountry; display: string }
  | { ok: false; reason: 'invalid' | 'unknown' | 'unavailable' };

/** `load` fetches the table for a country, or returns null when the file cannot be loaded. */
export async function lookupPostal(
  input: string,
  load: (country: PostalCountry) => Promise<PostalTable | null>,
): Promise<PostalResult> {
  const q = parsePostalInput(input);
  if (!q) return { ok: false, reason: 'invalid' };
  let table: PostalTable | null = null;
  try {
    table = await load(q.country);
  } catch {
    table = null;
  }
  if (!table) return { ok: false, reason: 'unavailable' };
  const hit = lookupInTable(table, q);
  if (!hit) return { ok: false, reason: 'unknown' };
  return { ok: true, ...hit, country: q.country, display: q.display };
}

export function postalErrorMessage(reason: 'invalid' | 'unknown' | 'unavailable'): string {
  switch (reason) {
    case 'invalid':
      return 'Enter a five digit ZIP code or a Canadian postal code like M5V or M5V 2T6.';
    case 'unknown':
      return 'We could not find that code. Check it, or use your location instead.';
    case 'unavailable':
      return 'The postal code list could not be loaded. Check your connection, or use your location instead.';
  }
}
