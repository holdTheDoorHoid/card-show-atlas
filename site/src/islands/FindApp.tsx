// The home page: where are you, how far will you go, when. Results as a list or on the map.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { DISTANCE_MAX_MI } from '../lib/config';
import { rangeForChip, formatMonthDay, type DateChip } from '../lib/dates';
import {
  DEFAULT_FILTERS,
  selectResults,
  sanitizeFilters,
  sortResults,
  SORT_LABELS,
  type Filters,
  type SortKey,
} from '../lib/filters';
import { countryNear, DEFAULT_FIND_PREFS, radiusFromSlider, sanitizeLocation, sanitizePrefs, sliderRange, sliderValue, type SavedLocation } from '../lib/findprefs';
import { formatDriveTime, plural } from '../lib/format';
import { driveMinutes, unitForCountry, type DistanceUnit } from '../lib/geo';
import { SHOW_EVENT_TYPES } from '../lib/labels';
import { boundsOf } from '../lib/map-data';
import { lookupPostalInBrowser } from '../lib/postal-client';
import { postalErrorMessage } from '../lib/postal';
import { STORAGE_KEYS } from '../lib/storage';
import { withBase } from '../lib/urls';
import { FilterBar } from './FilterBar';
import { useIndex, useMyShows, usePersistedState, useToday, useVendorSettings } from './hooks';
import { LazyMap } from './LazyMap';
import type { MapView } from './MapCanvas';
import { ResultsList } from './ResultsList';
import { Legend } from './ui';
import { loadPlannerRows, plainError, sharedSession } from './plannerSession';
import { historyFromMyShows, seriesFromShowId, toPlannerSettings } from '../lib/planner-settings';
import { labelMap, rankForTable, type VendorRowInfo } from '../lib/vendor-rank';
import { DEFAULT_WEIGHT, sanitizeWeight, WEIGHT_PRESETS, type WeightPreset } from '../lib/weights';

const PAGE = 30;

const CHIPS: { id: DateChip; label: string }[] = [
  { id: 'weekend', label: 'This weekend' },
  { id: '2weeks', label: 'Next 2 weeks' },
  { id: '30days', label: 'Next 30 days' },
  { id: 'pick', label: 'Pick dates' },
];

function EmptyShows() {
  return (
    <div class="card empty" role="status">
      <h2>Shows are being added</h2>
      <p>Check back soon. The list is still being built, so nothing is on the map yet.</p>
      <p>
        Know a show? <a href={withBase('add/')}>Tell us about it</a>.
      </p>
    </div>
  );
}

export default function FindApp({ emptyAtBuild = false }: { emptyAtBuild?: boolean }) {
  const idx = useIndex();
  const today = useToday();
  const my = useMyShows();
  const [loc, setLoc] = usePersistedState<SavedLocation | null>(STORAGE_KEYS.location, null, sanitizeLocation);
  const [prefs, setPrefs] = usePersistedState(STORAGE_KEYS.find, DEFAULT_FIND_PREFS, sanitizePrefs);
  const [filters, setFilters] = usePersistedState<Filters>(STORAGE_KEYS.filters, DEFAULT_FILTERS, sanitizeFilters);
  const vendor = useVendorSettings();
  const [weight, setWeight] = usePersistedState<WeightPreset>(STORAGE_KEYS.weights, DEFAULT_WEIGHT, sanitizeWeight);
  const [byPoints, setByPoints] = useState(false);
  const [vendorInfo, setVendorInfo] = useState<Map<string, VendorRowInfo> | null>(null);
  const [scoring, setScoring] = useState(false);
  const [scoreError, setScoreError] = useState<string | null>(null);
  const [view, setView] = useState<'list' | 'map'>('list');
  const [shown, setShown] = useState(PAGE);
  const [zip, setZip] = useState('');
  const [zipMsg, setZipMsg] = useState<{ kind: 'error' | 'ok' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Put the saved postal code back in the box once it has been read.
  useEffect(() => {
    if (loc && loc.source === 'postal') setZip((z) => (z === '' ? loc.label : z));
  }, [loc?.label, loc?.source]);

  const index = idx.status === 'ready' ? idx.index : null;
  // "Best for my table" needs a home in the vendor settings (the planner scores the drive from there).
  const vendorAvailable = vendor.ready && vendor.settings.home.lat !== null;
  const sortKey: SortKey = prefs.sort === 'vendor' && !vendorAvailable ? 'date' : prefs.sort;
  const vendorPs = useMemo(() => (vendorAvailable ? toPlannerSettings(vendor.settings) : null), [vendorAvailable, vendor.settings]);
  const vocab = index?.vocab;
  const unit: DistanceUnit = prefs.unit ?? unitForCountry(loc?.country);
  const maxMiles = prefs.radiusMi;
  const origin = loc ? { lat: loc.lat, lon: loc.lon } : null;
  const range = today ? rangeForChip(prefs.chip, today, { from: prefs.pickFrom ?? undefined, to: prefs.pickTo ?? undefined }) : null;

  const results = useMemo(() => {
    if (!index || !range) return [];
    const found = selectResults(index.rows, { filters, vocab: index.vocab, range, origin, maxMiles: origin ? maxMiles : null });
    const key: SortKey = !origin && sortKey === 'distance' ? 'date' : sortKey;
    const vendorScores = vendorInfo ? new Map([...vendorInfo].map(([id, v]) => [id, v.score] as [string, number | null])) : undefined;
    return sortResults(found, key, { today: today as string, selected: filters.sells, vocab: index.vocab, vendorScores });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, filters, range?.from, range?.to, loc?.lat, loc?.lon, maxMiles, sortKey, today, vendorInfo]);

  // The vendor scores come from the route planner, which runs in a worker. Its data is fetched only
  // when someone picks "Best for my table", so the home page stays light for everyone else.
  useEffect(() => {
    if (sortKey !== 'vendor' || !vendorPs || !today || !index) return;
    let alive = true;
    setScoring(true);
    setScoreError(null);
    (async () => {
      try {
        const rows = await loadPlannerRows();
        const byId = new Map(rows.map((r) => [r.id, r]));
        const history = historyFromMyShows(my.store, (id) => byId.get(id)?.series_id ?? seriesFromShowId(id));
        const withHistory = toPlannerSettings(vendor.settings, { history });
        const info = await rankForTable(sharedSession(rows), withHistory.settings, {
          today,
          weights: weight,
          scoreBy: byPoints ? 'points' : 'auto',
          labels: labelMap(index.vocab),
        });
        if (alive) setVendorInfo(info);
      } catch (e) {
        if (alive) setScoreError(plainError(e));
      } finally {
        if (alive) setScoring(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [sortKey === 'vendor', vendorPs, today, index, weight, byPoints, my.ready]);

  const resultsKey = `${loc?.lat},${loc?.lon},${maxMiles},${range?.from},${range?.to},${sortKey},${JSON.stringify(filters)}`;
  useEffect(() => setShown(PAGE), [resultsKey]);

  async function submitZip(e: Event) {
    e.preventDefault();
    setBusy(true);
    setZipMsg(null);
    const r = await lookupPostalInBrowser(zip);
    setBusy(false);
    if (!r.ok) {
      setZipMsg({ kind: 'error', text: postalErrorMessage(r.reason) });
      return;
    }
    setLoc({ label: r.display, lat: r.lat, lon: r.lon, country: r.country, source: 'postal' });
    setZipMsg({ kind: 'ok', text: `Showing shows near ${r.display}.` });
  }

  function useMyLocation() {
    if (!('geolocation' in navigator)) {
      setZipMsg({ kind: 'error', text: 'Your browser cannot share a location. Type a ZIP or postal code instead.' });
      return;
    }
    setBusy(true);
    setZipMsg({ kind: 'info', text: 'Asking your device for your location...' });
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setBusy(false);
        // Rounded to about a kilometre: more precision is not needed to find shows.
        const lat = Math.round(pos.coords.latitude * 100) / 100;
        const lon = Math.round(pos.coords.longitude * 100) / 100;
        const country = countryNear(index?.rows ?? [], lat, lon);
        setLoc({ label: 'your location', lat, lon, country, source: 'gps' });
        setZip('');
        setZipMsg({ kind: 'ok', text: 'Using your location. It stays on this device.' });
      },
      (err) => {
        setBusy(false);
        setZipMsg({
          kind: 'error',
          text: err.code === err.PERMISSION_DENIED ? 'Location is blocked for this site. Type a ZIP or postal code instead.' : 'We could not get your location. Type a ZIP or postal code instead.',
        });
      },
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 10 * 60 * 1000 },
    );
  }

  function forgetPlace() {
    setLoc(null);
    setZip('');
    setZipMsg({ kind: 'info', text: 'Your place was removed from this device.' });
  }

  const slider = sliderRange(unit);
  const sliderNow = sliderValue(maxMiles, unit);
  const driveLine = formatDriveTime(driveMinutes(maxMiles));

  const mapView: MapView = useMemo(() => {
    const b = boundsOf(results.map((r) => r.row));
    if (b && results.length > 0) return { kind: 'bounds', bounds: b };
    if (origin) return { kind: 'center', center: [origin.lat, origin.lon], zoom: 8 };
    return { kind: 'default' };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultsKey, results.length > 0]);

  const noShowsAtAll = (index && index.count === 0) || (emptyAtBuild && idx.status !== 'ready');

  if (noShowsAtAll) return <EmptyShows />;

  return (
    <div>
      <section class="find-controls card" aria-label="Search for shows">
        <div>
          <label class="q-title" for="where">
            1. Where are you?
          </label>
          <form class="input-row" onSubmit={submitZip}>
            <input
              id="where"
              type="text"
              inputMode="text"
              autoComplete="postal-code"
              placeholder="ZIP or postal code"
              value={zip}
              onInput={(e) => setZip((e.currentTarget as HTMLInputElement).value)}
              aria-describedby="where-msg"
              maxLength={12}
            />
            <button class="btn btn-primary" type="submit" disabled={busy || zip.trim() === ''}>
              Set
            </button>
          </form>
          <div class="btn-row">
            <button type="button" class="btn btn-small" onClick={useMyLocation} disabled={busy}>
              Use my location
            </button>
            {loc && (
              <button type="button" class="btn btn-small btn-quiet" onClick={forgetPlace}>
                Forget my place
              </button>
            )}
          </div>
          <p id="where-msg" class={`hint ${zipMsg?.kind === 'error' ? 'error' : zipMsg?.kind === 'ok' ? 'ok-text' : ''}`} role="status">
            {zipMsg ? zipMsg.text : loc ? `Using ${loc.label}. It stays on this device.` : 'Your place stays on this device. Nothing is sent anywhere.'}
          </p>
        </div>

        <div>
          <label class="q-title" for="far">
            2. How far will you go?
          </label>
          <input
            id="far"
            type="range"
            min={slider.min}
            max={slider.max}
            step={slider.step}
            value={sliderNow}
            disabled={!loc}
            aria-describedby="far-line"
            onInput={(e) => setPrefs({ ...prefs, radiusMi: radiusFromSlider(Number((e.currentTarget as HTMLInputElement).value), unit) })}
          />
          <p id="far-line" class="radius-line" aria-live="polite">
            {loc ? (
              <>
                Up to {sliderNow} {unit}, {driveLine} by car
              </>
            ) : (
              <span class="muted">Set your place to measure distance.</span>
            )}
          </p>
          <div class="chips" role="group" aria-label="Distance unit">
            <button type="button" class="chip" aria-pressed={unit === 'mi'} onClick={() => setPrefs({ ...prefs, unit: 'mi' })}>
              Miles
            </button>
            <button type="button" class="chip" aria-pressed={unit === 'km'} onClick={() => setPrefs({ ...prefs, unit: 'km' })}>
              Kilometres
            </button>
          </div>
        </div>

        <div>
          <div class="q-title" id="when-title">
            3. When?
          </div>
          <div class="chips" role="group" aria-labelledby="when-title">
            {CHIPS.map((c) => (
              <button type="button" class="chip" aria-pressed={prefs.chip === c.id} onClick={() => setPrefs({ ...prefs, chip: c.id })}>
                {c.label}
              </button>
            ))}
          </div>
          {prefs.chip === 'pick' && today && (
            <div class="field-grid" style={{ marginTop: '0.7rem' }}>
              <div class="field">
                <label for="pick-from">From</label>
                <input id="pick-from" type="date" value={range?.from ?? ''} onInput={(e) => setPrefs({ ...prefs, pickFrom: (e.currentTarget as HTMLInputElement).value || null })} />
              </div>
              <div class="field">
                <label for="pick-to">To</label>
                <input id="pick-to" type="date" value={range?.to ?? ''} min={range?.from} onInput={(e) => setPrefs({ ...prefs, pickTo: (e.currentTarget as HTMLInputElement).value || null })} />
              </div>
            </div>
          )}
        </div>
      </section>

      {vocab && <FilterBar filters={filters} onChange={setFilters} vocab={vocab} idPrefix="find" />}

      {idx.status === 'error' ? (
        <div class="notice notice-warn" role="alert" style={{ marginTop: '1.2rem' }}>
          The list of shows could not be loaded. Check your connection and reload the page.
        </div>
      ) : !index || !range ? (
        <p class="loading" role="status">
          Loading shows...
        </p>
      ) : (
        <>
          <div class="results-head">
            <h2 aria-live="polite">
              {plural(results.length, 'show')}
              <span class="hint" style={{ display: 'block', fontSize: '0.95rem', fontWeight: 400 }}>
                {formatMonthDay(range.from)}
                {range.to !== range.from ? ` to ${formatMonthDay(range.to)}` : ''}
                {loc ? `, within ${sliderNow} ${unit} of ${loc.label}` : ', anywhere in the US and Canada'}
              </span>
            </h2>
            <div class="btn-row" style={{ margin: 0, alignItems: 'center' }}>
              <div class="sort-field">
                <label for="sort">Sort by</label>
                <select id="sort" value={sortKey} onChange={(e) => setPrefs({ ...prefs, sort: (e.currentTarget as HTMLSelectElement).value as SortKey })}>
                  {(Object.keys(SORT_LABELS) as SortKey[]).filter((k) => k !== 'vendor' || vendorAvailable).map((k) => (
                    <option value={k} disabled={k === 'distance' && !loc}>
                      {SORT_LABELS[k]}
                      {k === 'distance' && !loc ? ' (set your place)' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div class="view-toggle" role="group" aria-label="Show results as">
                <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>
                  List
                </button>
                <button type="button" aria-pressed={view === 'map'} onClick={() => setView('map')}>
                  Map
                </button>
              </div>
            </div>
          </div>

          {sortKey === 'vendor' && vendorPs && (
            <div class="card vendor-tools">
              <p style={{ margin: '0 0 0.4rem', fontWeight: 700 }}>Best for my table</p>
              {vendorPs.profit ? (
                <div class="chips" role="group" aria-label="Score shows by" style={{ marginBottom: '0.5rem' }}>
                  <button type="button" class="chip" aria-pressed={!byPoints} onClick={() => setByPoints(false)}>
                    Expected profit
                  </button>
                  <button type="button" class="chip" aria-pressed={byPoints} onClick={() => setByPoints(true)}>
                    My priorities
                  </button>
                </div>
              ) : (
                <p class="hint" style={{ marginTop: 0 }}>
                  Scored by your priorities. Fill in your <a href={withBase('my-shows/#settings')}>vendor settings</a> (sales, margin, fuel, hotel, food) to score by expected profit.
                </p>
              )}
              <div class="chips" role="group" aria-label="What matters most">
                {WEIGHT_PRESETS.map((p) => (
                  <button type="button" class="chip" aria-pressed={weight === p.id} title={p.help} disabled={vendorPs.profit && !byPoints} onClick={() => setWeight(p.id)}>
                    {p.label}
                  </button>
                ))}
              </div>
              <p class="hint" role="status" style={{ marginBottom: 0 }}>
                {scoring ? 'Scoring shows for your table...' : scoreError ? scoreError : vendorPs.profit && !byPoints ? 'Scores come from the profit each show is expected to make you. Pick My priorities to use the presets.' : 'The score is out of 100. Each show says why.'}
              </p>
            </div>
          )}

          {!loc && (
            <p class="hint">
              Add your ZIP or postal code above to see how far each show is and how long the drive takes.
            </p>
          )}

          {results.length === 0 ? (
            <div class="card empty" role="status">
              <h3>No shows match</h3>
              <p>Try a wider distance, a longer stretch of dates, or fewer filters.</p>
              <div class="btn-row" style={{ justifyContent: 'center' }}>
                {loc && maxMiles < DISTANCE_MAX_MI && (
                  <button type="button" class="btn btn-small" onClick={() => setPrefs({ ...prefs, radiusMi: Math.min(DISTANCE_MAX_MI, Math.max(maxMiles * 2, 50)) })}>
                    Double the distance
                  </button>
                )}
                {prefs.chip !== '30days' && (
                  <button type="button" class="btn btn-small" onClick={() => setPrefs({ ...prefs, chip: '30days' })}>
                    Look at the next 30 days
                  </button>
                )}
                <button type="button" class="btn btn-small" onClick={() => setFilters({ ...DEFAULT_FILTERS })}>
                  Clear filters
                </button>
              </div>
            </div>
          ) : view === 'list' ? (
            <>
              <ResultsList results={results.slice(0, shown)} vocab={index.vocab} unit={unit} my={my} vendor={sortKey === 'vendor' ? vendorInfo ?? new Map() : null} />
              {results.length > shown && (
                <div class="btn-row" style={{ justifyContent: 'center' }}>
                  <button type="button" class="btn" onClick={() => setShown(shown + PAGE)}>
                    Show {Math.min(PAGE, results.length - shown)} more ({results.length - shown} left)
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              <LazyMap rows={results.map((r) => r.row)} origin={origin} view={mapView} viewKey={resultsKey} label="Map of the shows in your results" />
              <Legend types={SHOW_EVENT_TYPES} />
              <p class="hint">Tap a marker for details. Use the List button above for the same results as a list.</p>
            </>
          )}
        </>
      )}
      {my.saveFailed && (
        <p class="notice notice-warn" role="alert">
          This browser would not save My shows. Private windows often block saving.
        </p>
      )}
    </div>
  );
}
