// Browser side of the postal lookup: fetch the table for a country once, on demand, and keep it.
import { dataUrl } from './urls.ts';
import { lookupPostal, type PostalCountry, type PostalResult, type PostalTable } from './postal.ts';

const cache = new Map<PostalCountry, Promise<PostalTable | null>>();

function loadTable(country: PostalCountry): Promise<PostalTable | null> {
  let p = cache.get(country);
  if (!p) {
    p = fetch(dataUrl(`postal/${country}.json`))
      .then((r) => (r.ok ? (r.json() as Promise<PostalTable>) : null))
      .catch(() => null);
    // A failed load is not kept, so the next try can succeed.
    p.then((t) => {
      if (t === null) cache.delete(country);
    });
    cache.set(country, p);
  }
  return p;
}

export function lookupPostalInBrowser(input: string): Promise<PostalResult> {
  return lookupPostal(input, loadTable);
}
