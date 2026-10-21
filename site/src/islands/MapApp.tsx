// The map page: every show on a map, with a time window bar along the bottom.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { formatRowDate } from '../lib/dates';
import { DEFAULT_FILTERS, filterRows, sanitizeFilters, type Filters } from '../lib/filters';
import { sanitizeLocation, type SavedLocation } from '../lib/findprefs';
import { plural } from '../lib/format';
import { SHOW_EVENT_TYPES } from '../lib/labels';
import { STORAGE_KEYS } from '../lib/storage';
import { dayCounts, DEFAULT_WINDOW, rowsInWindow, stepWeek, type TimeWindow } from '../lib/timewindow';
import type { IndexRow } from '../lib/types';
import { showPath, withBase } from '../lib/urls';
import { FilterBar } from './FilterBar';
import { loadStoreIndex, useIndex, usePersistedState, useToday } from './hooks';
import { LazyMap } from './LazyMap';
import type { MapView } from './MapCanvas';
import { TimeBar } from './TimeBar';
import { Legend } from './ui';

const STEP_MS = 900;

export default function MapApp() {
  const idx = useIndex();
  const today = useToday();
  const [filters, setFilters] = usePersistedState<Filters>(STORAGE_KEYS.filters, DEFAULT_FILTERS, sanitizeFilters);
  const [loc] = usePersistedState<SavedLocation | null>(STORAGE_KEYS.location, null, sanitizeLocation);
  const [win, setWin] = useState<TimeWindow>(DEFAULT_WINDOW);
  const [playing, setPlaying] = useState(false);
  const [storeOn, setStoreOn] = useState(false);
  const [storeRows, setStoreRows] = useState<IndexRow[] | null>(null);
  const [storeLoading, setStoreLoading] = useState(false);
  const [storeMissing, setStoreMissing] = useState(false);
  const [listOpen, setListOpen] = useState(false);

  // The store events layer is fetched only when it is switched on.
  useEffect(() => {
    if (!storeOn || storeRows || storeLoading) return;
    setStoreLoading(true);
    loadStoreIndex().then((f) => {
      setStoreLoading(false);
      if (f && f.rows.length > 0) setStoreRows(f.rows);
      else setStoreMissing(true);
    });
  }, [storeOn]);

  // play: step a week at a time
  const winRef = useRef(win);
  winRef.current = win;
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      const { window: next, done } = stepWeek(winRef.current);
      setWin(next);
      if (done) setPlaying(false);
    }, STEP_MS);
    return () => window.clearInterval(id);
  }, [playing]);

  const index = idx.status === 'ready' ? idx.index : null;

  const filtered = useMemo(() => (index ? filterRows(index.rows, filters, index.vocab) : []), [index, filters]);
  const counts = useMemo(() => (today ? dayCounts(filtered, today) : []), [filtered, today]);
  const visible = useMemo(() => (today ? rowsInWindow(filtered, today, win) : []), [filtered, today, win]);

  // Store events follow the "what is sold" and "free" filters only: the others describe shows.
  const storeFiltered = useMemo(() => {
    if (!storeOn || !storeRows || !index) return undefined;
    const f: Filters = { ...DEFAULT_FILTERS, sells: filters.sells, sellsKnownOnly: filters.sellsKnownOnly, free: filters.free };
    return today ? rowsInWindow(filterRows(storeRows, f, index.vocab), today, win) : [];
  }, [storeOn, storeRows, index, filters, today, win]);

  const view: MapView = loc ? { kind: 'center', center: [loc.lat, loc.lon], zoom: 8 } : { kind: 'default' };
  const origin = loc ? { lat: loc.lat, lon: loc.lon } : null;
  const empty = index && index.count === 0;

  // The index is sorted by first day and the window keeps that order, so the list needs no sorting.
  const listed = visible;

  return (
    <div>
      {index && !empty && (
        <FilterBar
          filters={filters}
          onChange={setFilters}
          vocab={index.vocab}
          idPrefix="map"
          storeLayer={{ on: storeOn, loading: storeLoading, missing: storeMissing, onChange: setStoreOn }}
        />
      )}

      {empty ? (
        <div class="card empty" role="status" style={{ marginTop: '1rem' }}>
          <h2>Shows are being added</h2>
          <p>Check back soon. Nothing is on the map yet.</p>
        </div>
      ) : idx.status === 'error' ? (
        <div class="notice notice-warn" role="alert" style={{ marginTop: '1rem' }}>
          The list of shows could not be loaded. Check your connection and reload the page.
        </div>
      ) : (
        <>
          <div style={{ marginTop: '1rem' }}>
            <LazyMap
              rows={visible}
              storeRows={storeFiltered}
              origin={origin}
              view={view}
              viewKey={`${loc?.lat},${loc?.lon}`}
              tall
              label="Map of card shows in the chosen time window"
            />
          </div>
          <Legend types={storeOn ? [...SHOW_EVENT_TYPES, 'store_event'] : SHOW_EVENT_TYPES} />
          {today && index ? (
            <TimeBar today={today} counts={counts} win={win} onChange={(w) => {
                setPlaying(false);
                setWin(w);
              }} playing={playing} onPlayToggle={() => setPlaying((p) => !p)} matching={visible.length} />
          ) : (
            <p class="loading" role="status">
              Loading shows...
            </p>
          )}
          {index && (
            <details class="card" style={{ marginTop: '1rem' }} onToggle={(e) => setListOpen((e.currentTarget as HTMLDetailsElement).open)}>
              <summary style={{ cursor: 'pointer', fontWeight: 700, minHeight: 44, display: 'flex', alignItems: 'center' }}>
                List of the {plural(visible.length, 'show')} in this window
              </summary>
              {!listOpen ? null : listed.length === 0 ? (
                <p class="muted">Nothing in this window. Drag it along the timeline.</p>
              ) : (
                <ul class="plain-list">
                  {listed.slice(0, 100).map((r) => (
                    <li>
                      <a href={withBase(showPath(r.i))}>
                        <span class="pl-date">{formatRowDate(r.d, r.e ?? r.d, new Date().getFullYear())}</span>
                        <span class="pl-name">{r.n}</span>
                        <span class="pl-meta">
                          {r.c}, {r.r}
                        </span>
                      </a>
                    </li>
                  ))}
                  {listed.length > 100 && <li class="muted" style={{ padding: '0.6rem 0' }}>and {listed.length - 100} more. Narrow the window to see them all.</li>}
                </ul>
              )}
            </details>
          )}
        </>
      )}
    </div>
  );
}
