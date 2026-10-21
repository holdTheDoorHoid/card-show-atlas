// State and province names, for the browse pages and for labels.

export const US_REGIONS: Readonly<Record<string, string>> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky',
  LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  PR: 'Puerto Rico', GU: 'Guam', VI: 'U.S. Virgin Islands', AS: 'American Samoa',
  MP: 'Northern Mariana Islands',
};

export const CA_REGIONS: Readonly<Record<string, string>> = {
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick',
  NL: 'Newfoundland and Labrador', NS: 'Nova Scotia', NT: 'Northwest Territories', NU: 'Nunavut',
  ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Quebec', SK: 'Saskatchewan', YT: 'Yukon',
};

export const COUNTRY_NAMES: Readonly<Record<string, string>> = {
  US: 'United States',
  CA: 'Canada',
};

/** The name of a region in a country, or the code itself when it is not known. */
export function regionName(country: string, code: string): string {
  const table = country === 'CA' ? CA_REGIONS : country === 'US' ? US_REGIONS : {};
  return table[code] ?? code;
}

/** Page path for a state or province: "nj", or "ca-on" would clash with "ca" (California), so Canada gets a prefix. */
export function regionSlug(country: string, code: string): string {
  const c = code.toLowerCase();
  return country === 'CA' ? `ca-${c}` : country === 'US' ? c : `${country.toLowerCase()}-${c}`;
}

export function countryName(code: string): string {
  return COUNTRY_NAMES[code] ?? code;
}
