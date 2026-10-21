// Shared hooks for the interactive parts: the data index, saved settings, and My shows.
import { useEffect, useRef, useState } from 'preact/hooks';
import { addShow, emptyStore, moveToStage, removeShow, sanitizeStore, updateShow, type MyShowPatch, type MyShowsStore, type ShowSnapshot, type Stage } from '../lib/myshows';
import { DEFAULT_VENDOR_SETTINGS, normalizeSettings, type VendorSettings } from '../lib/settings';
import { browserStore, readJson, STORAGE_KEYS, writeJson } from '../lib/storage';
import { todayISO } from '../lib/dates';
import { dataUrl } from '../lib/urls';
import type { IndexFile } from '../lib/types';

// ---------- the compact index ----------

let indexPromise: Promise<IndexFile> | null = null;
let storePromise: Promise<IndexFile | null> | null = null;

export function loadIndex(): Promise<IndexFile> {
  if (!indexPromise) {
    indexPromise = fetch(dataUrl('index.json'))
      .then((r) => {
        if (!r.ok) throw new Error(`index.json ${r.status}`);
        return r.json() as Promise<IndexFile>;
      })
      .catch((err) => {
        indexPromise = null;
        throw err;
      });
  }
  return indexPromise;
}

/** The store events layer. Only fetched when someone switches the layer on. */
export function loadStoreIndex(): Promise<IndexFile | null> {
  if (!storePromise) {
    storePromise = fetch(dataUrl('store_index.json'))
      .then((r) => (r.ok ? (r.json() as Promise<IndexFile>) : null))
      .catch(() => {
        storePromise = null;
        return null;
      });
  }
  return storePromise;
}

export type IndexState = { status: 'loading'; index: null } | { status: 'ready'; index: IndexFile } | { status: 'error'; index: null };

export function useIndex(): IndexState {
  const [state, setState] = useState<IndexState>({ status: 'loading', index: null });
  useEffect(() => {
    let alive = true;
    loadIndex().then(
      (index) => alive && setState({ status: 'ready', index }),
      () => alive && setState({ status: 'error', index: null }),
    );
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

// ---------- values saved in this browser ----------

/**
 * State that is remembered on this device. The first render always uses `initial`, so the page
 * built at publish time and the first render in the browser match; the saved value is applied
 * right after.
 */
export function usePersistedState<T>(key: string, initial: T, clean: (raw: unknown) => T): [T, (v: T | ((prev: T) => T)) => void, boolean] {
  const [value, setValue] = useState<T>(initial);
  const [loaded, setLoaded] = useState(false);
  const cleanRef = useRef(clean);
  cleanRef.current = clean;
  useEffect(() => {
    const raw = readJson(browserStore(), key);
    if (raw !== null) setValue(cleanRef.current(raw));
    setLoaded(true);
  }, [key]);
  useEffect(() => {
    if (loaded) writeJson(browserStore(), key, value);
  }, [key, value, loaded]);
  return [value, setValue, loaded];
}

/** Today's date, read once the page is running in the browser. */
export function useToday(): string | null {
  const [today, setToday] = useState<string | null>(null);
  useEffect(() => {
    setToday(todayISO());
    const onVisible = () => {
      if (document.visibilityState === 'visible') setToday(todayISO());
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
  return today;
}

// ---------- My shows ----------

let myShows: MyShowsStore | null = null;
let saveFailed = false;
const listeners = new Set<() => void>();

function currentStore(): MyShowsStore {
  if (!myShows) myShows = sanitizeStore(readJson(browserStore(), STORAGE_KEYS.myShows));
  return myShows;
}

function commit(next: MyShowsStore): void {
  myShows = next;
  saveFailed = !writeJson(browserStore(), STORAGE_KEYS.myShows, next);
  for (const l of listeners) l();
}

export interface MyShowsApi {
  /** false until the saved list has been read in the browser */
  ready: boolean;
  store: MyShowsStore;
  /** true when the browser refused to save (private window or full storage) */
  saveFailed: boolean;
  persistent: boolean;
  add(id: string, snapshot: ShowSnapshot, extra?: { stage?: Stage; deadline?: string | null; tablePrice?: number | null; tableType?: string }): void;
  update(id: string, patch: MyShowPatch): void;
  move(id: string, stage: Stage): void;
  remove(id: string): void;
  replace(next: MyShowsStore): void;
}

export function useMyShows(): MyShowsApi {
  const [, bump] = useState(0);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    currentStore();
    setReady(true);
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    // other tabs
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEYS.myShows) {
        myShows = null;
        l();
      }
    };
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(l);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return {
    ready,
    store: ready ? currentStore() : emptyStore(),
    saveFailed,
    persistent: ready ? browserStore().persistent : true,
    add: (id, snapshot, extra) => commit(addShow(currentStore(), id, snapshot, new Date(), extra)),
    update: (id, patch) => commit(updateShow(currentStore(), id, patch, new Date())),
    move: (id, stage) => commit(moveToStage(currentStore(), id, stage, new Date())),
    remove: (id) => commit(removeShow(currentStore(), id, new Date())),
    replace: (next) => commit(next),
  };
}

// ---------- vendor settings ----------

export function useVendorSettings(): { settings: VendorSettings; ready: boolean; save: (s: VendorSettings) => boolean } {
  const [settings, setSettings] = useState<VendorSettings>(DEFAULT_VENDOR_SETTINGS);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setSettings(normalizeSettings(readJson(browserStore(), STORAGE_KEYS.settings)));
    setReady(true);
  }, []);
  return {
    settings,
    ready,
    save: (s) => {
      setSettings(s);
      return writeJson(browserStore(), STORAGE_KEYS.settings, s);
    },
  };
}

export function markBackedUp(now: Date): void {
  browserStore().set(STORAGE_KEYS.lastBackup, now.toISOString());
}

export function lastBackup(): string | null {
  return browserStore().get(STORAGE_KEYS.lastBackup);
}

/** Dark or light, as the page is showing it right now. Used to dim the map tiles at night. */
export function isDarkNow(): boolean {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'dark') return true;
  if (attr === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Offer a file for download from text. */
export function downloadText(fileName: string, mime: string, text: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
