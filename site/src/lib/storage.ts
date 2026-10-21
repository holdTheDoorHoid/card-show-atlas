// Everything the site remembers lives in this browser's localStorage. Reads and writes are wrapped in
// try/catch: private windows, blocked site data and full storage must never break a page.

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): boolean;
  remove(key: string): boolean;
  /** true when data is really saved in the browser, false for the in-memory fallback */
  readonly persistent: boolean;
}

export const STORAGE_KEYS = {
  myShows: 'csa.myshows.v1',
  settings: 'csa.settings.v1',
  location: 'csa.location.v1',
  filters: 'csa.filters.v1',
  filtersOpen: 'csa.filtersopen.v1',
  find: 'csa.find.v1',
  lastBackup: 'csa.lastbackup.v1',
  theme: 'csa.theme.v1',
} as const;

export function createMemoryStore(initial: Record<string, string> = {}): KeyValueStore {
  const map = new Map(Object.entries(initial));
  return {
    persistent: false,
    get: (k) => map.get(k) ?? null,
    set: (k, v) => {
      map.set(k, v);
      return true;
    },
    remove: (k) => map.delete(k),
  };
}

let shared: KeyValueStore | null = null;

/** The browser's localStorage when it works, otherwise a store that lasts until the page closes. */
export function browserStore(): KeyValueStore {
  if (shared) return shared;
  try {
    const ls = window.localStorage;
    const probe = '__csa_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    shared = {
      persistent: true,
      get: (k) => {
        try {
          return ls.getItem(k);
        } catch {
          return null;
        }
      },
      set: (k, v) => {
        try {
          ls.setItem(k, v);
          return true;
        } catch {
          return false;
        }
      },
      remove: (k) => {
        try {
          ls.removeItem(k);
          return true;
        } catch {
          return false;
        }
      },
    };
  } catch {
    shared = createMemoryStore();
  }
  return shared;
}

export function readJson(store: KeyValueStore, key: string): unknown {
  const text = store.get(key);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function writeJson(store: KeyValueStore, key: string, value: unknown): boolean {
  return store.set(key, JSON.stringify(value));
}
