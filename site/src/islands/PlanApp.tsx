// The Plan page: a weekend run or a season, planned in a Web Worker from the vendor's own settings.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { LegMatrix } from '../../../planner/src/travel.ts';
import type { PlannerShow } from '../../../planner/src/types.ts';
import { addDays } from '../lib/dates';
import type { DistanceUnit } from '../lib/geo';
import {
  applyTableFees,
  buildSeasonOptions,
  buildWeekendOptions,
  NO_OVERRIDES,
  hasOverrides,
  sanitizeSeasonForm,
  sanitizeWeekendForm,
  settingsForPlan,
  type PlanOverrides,
  type SeasonForm,
  type WeekendForm,
} from '../lib/plan-options';
import { currenciesNeedingRate, rateKey, runSeason, runWeekend, sanitizeRates, type PlanEntry, type RunOutput } from '../lib/plan-run';
import { linkFromHash, openShare, type ShareSource } from '../lib/plan-share';
import { historyFromMyShows, seriesFromShowId, toPlannerSettings } from '../lib/planner-settings';
import { browserStore, readJson, STORAGE_KEYS, writeJson } from '../lib/storage';
import { labelMap } from '../lib/vendor-rank';
import { withBase } from '../lib/urls';
import type { Vocab } from '../lib/types';
import { DEFAULT_VOCAB } from '../lib/vocab';
import { useMyShows, usePersistedState, useToday, useVendorSettings } from './hooks';
import { PlanCard, type CheckState } from './PlanCard';
import { SeasonFormView, WeekendFormView } from './PlanForms';
import { isStopped, loadPlannerFile, PlannerSession, plainError } from './plannerSession';

type Tab = 'weekend' | 'season';
type Status = 'loading' | 'ready' | 'planning' | 'failed';

const PLAN_KEY = 'csa.plan.v1';

function Spinner() {
  return <span class="spinner" aria-hidden="true" />;
}

function RateBox({ currency, vendorCurrency, left, rates, onApply }: { currency: string; vendorCurrency: string; left: number; rates: Record<string, number>; onApply: (key: string, v: number | null) => void }) {
  const key = rateKey(currency, vendorCurrency);
  const [text, setText] = useState(rates[key] ? String(rates[key]) : '');
  return (
    <div class="notice notice-warn rate-box">
      <p>
        <strong>
          {left} {left === 1 ? 'show lists' : 'shows list'} prices in {currency}
        </strong>{' '}
        and {left === 1 ? 'was' : 'were'} left out. Enter an exchange rate to include {left === 1 ? 'it' : 'them'}. The rate is yours: we do not look one up.
      </p>
      <div class="input-row">
        <label for={`rate-${currency}`} class="rate-label">
          1 {currency} =
        </label>
        <input id={`rate-${currency}`} type="number" inputMode="decimal" min="0" step="0.0001" value={text} onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)} aria-label={`How many ${vendorCurrency} for one ${currency}`} />
        <span class="rate-label">{vendorCurrency}</span>
        <button type="button" class="btn btn-primary" disabled={!(Number(text) > 0)} onClick={() => onApply(key, Number(text))}>
          Plan again
        </button>
      </div>
    </div>
  );
}

export default function PlanApp() {
  const vendor = useVendorSettings();
  const today = useToday();
  const my = useMyShows();
  const [status, setStatus] = useState<Status>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rows, setRows] = useState<PlannerShow[]>([]);
  const [vocab, setVocab] = useState<Vocab>(DEFAULT_VOCAB);
  const [fixture, setFixture] = useState(false);
  const sessionRef = useRef<PlannerSession | null>(null);

  const [tab, setTab] = useState<Tab>('weekend');
  const [weekend, setWeekend] = useState<WeekendForm | null>(null);
  const [season, setSeason] = useState<SeasonForm | null>(null);
  const [overrides, setOverrides] = useState<PlanOverrides>(NO_OVERRIDES);
  const [rates, setRates] = usePersistedState<Record<string, number>>(STORAGE_KEYS.rates, {}, sanitizeRates);
  const [mustInclude, setMustInclude] = useState<{ id: string; name: string } | null>(null);
  const [shared, setShared] = useState<{ onlyIds: string[] } | null>(null);
  const [pendingShared, setPendingShared] = useState(false);
  const [run, setRun] = useState<RunOutput | null>(null);
  const [checks, setChecks] = useState<Record<string, CheckState>>({});
  const [checking, setChecking] = useState<string | null>(null);
  const [knownLegs, setKnownLegs] = useState<LegMatrix[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  // ---- load the planner rows and set up the worker
  useEffect(() => {
    let alive = true;
    loadPlannerFile().then(
      (file) => {
        if (!alive) return;
        import('../lib/planner-rows').then(({ plannerShowsFrom }) => {
          if (!alive) return;
          const r = plannerShowsFrom(file);
          setRows(r);
          setVocab(file.vocab ?? DEFAULT_VOCAB);
          setFixture(file.fixture === true);
          sessionRef.current = new PlannerSession(r);
          setStatus('ready');
        });
      },
      () => {
        if (!alive) return;
        setLoadError('The list of shows could not be loaded. Check your connection and reload the page.');
        setStatus('failed');
      },
    );
    return () => {
      alive = false;
      sessionRef.current?.dispose();
    };
  }, []);

  // ---- starting state: saved forms, a show from ?show=, or a shared plan
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !today || status !== 'ready' || !vendor.ready) return;
    started.current = true;
    const saved = readJson(browserStore(), PLAN_KEY) as { tab?: Tab; weekend?: unknown; season?: unknown } | null;
    let w = sanitizeWeekendForm(saved?.weekend, today);
    const s = sanitizeSeasonForm(saved?.season, today);
    let t: Tab = saved?.tab === 'season' ? 'season' : 'weekend';
    const params = new URLSearchParams(window.location.search);
    const showId = params.get('show');
    const link = linkFromHash(window.location.hash);
    const session = sessionRef.current;
    if (link && session) {
      void openShare(session, link, today).then((res) => {
        if (!res.ok) {
          setError(res.error);
          setWeekend(w);
          setSeason(s);
          setTab(t);
          return;
        }
        setWeekend(res.value.weekend);
        setSeason(res.value.season);
        setTab(res.value.tab);
        setShared({ onlyIds: res.value.onlyIds });
        setPendingShared(true);
      });
      return;
    }
    if (showId) {
      const row = rows.find((r) => r.id === showId);
      if (row) {
        const first = row.days[0]?.date ?? today;
        const last = row.days[row.days.length - 1]?.date ?? first;
        const start = addDays(first, -1) < today ? today : addDays(first, -1);
        w = { ...w, start, end: addDays(last, 1) < start ? start : addDays(last, 1), mustIncludeId: row.id };
        setMustInclude({ id: row.id, name: row.name });
        t = 'weekend';
      } else {
        setNotice('We could not find that show in the current list. It may have been removed or may be in the past.');
      }
    }
    setWeekend(w);
    setSeason(s);
    setTab(t);
  }, [today, status, vendor.ready, rows]);

  // remember the forms
  useEffect(() => {
    if (!weekend || !season || shared) return;
    writeJson(browserStore(), PLAN_KEY, { tab, weekend: { ...weekend, mustIncludeId: null }, season });
  }, [tab, weekend, season, shared]);

  // ---- settings for the planner
  const form = tab === 'weekend' ? weekend : season;
  const startPlace = form?.startPlace ?? null;
  const siteSettings = useMemo(
    () => settingsForPlan(vendor.settings, { maxDriveHours: form?.maxDriveHours ?? null, sells: form?.sells ?? null }, overrides),
    [vendor.settings, form?.maxDriveHours, form?.sells, overrides],
  );
  const vendorHistory = useMemo(() => historyFromMyShows(my.store, (id) => byId.get(id)?.series_id ?? seriesFromShowId(id)), [my.store, byId]);
  const ps = useMemo(
    () => toPlannerSettings(siteSettings, { home: startPlace ? { lat: startPlace.lat, lon: startPlace.lon, name: startPlace.label } : null, history: vendorHistory }),
    [siteSettings, startPlace, vendorHistory],
  );
  const unit: DistanceUnit = (startPlace?.country ?? vendor.settings.home.country) === 'CA' ? 'km' : 'mi';
  const hasHome = vendor.settings.home.lat !== null;

  // ---- planning
  async function runPlan(opts: { keepShared?: boolean } = {}) {
    const session = sessionRef.current;
    if (!session || !today || !weekend || !season) return;
    setStatus('planning');
    setError(null);
    setNotice(null);
    setChecks({});
    const onlyIds = shared && opts.keepShared !== false ? shared.onlyIds : undefined;
    try {
      await session.replaceRows(applyTableFees(rows, overrides.tableFees));
      const home = ps.settings.home ? { lat: ps.settings.home.lat, lon: ps.settings.home.lon } : null;
      const ctx = { today, rates, labels: labelMap(vocab), knownLegs: knownLegs.length > 0 ? knownLegs : undefined, home };
      const out =
        tab === 'weekend'
          ? await runWeekend(session, {
              settings: ps.settings,
              options: buildWeekendOptions(weekend, ctx, onlyIds ? { onlyIds, alternatives: 0 } : {}),
              mustInclude: onlyIds ? null : mustInclude,
            })
          : await runSeason(session, { settings: ps.settings, options: buildSeasonOptions(season, ctx, onlyIds ? { onlyIds } : {}) });
      setRun(out);
      setStatus('ready');
      setTimeout(() => resultsRef.current?.scrollIntoView({ block: 'start' }), 50);
    } catch (e) {
      if (isStopped(e)) {
        setNotice('Planning was stopped.');
      } else {
        setError(plainError(e));
      }
      setStatus('ready');
    }
  }

  function cancel() {
    sessionRef.current?.cancel();
  }

  // a shared plan runs by itself as soon as there is a place to start from
  useEffect(() => {
    if (pendingShared && ps.hasHome && status === 'ready' && weekend && season) {
      setPendingShared(false);
      void runPlan();
    }
  }, [pendingShared, ps.hasHome, status, weekend, season]);

  async function checkDrive(entry: PlanEntry) {
    const session = sessionRef.current;
    if (!session || !run) return;
    setChecking(entry.id);
    try {
      const res = await session.call('checkDriveTimes', { plan: entry.plan, kind: run.kind, settings: run.settings, options: run.options });
      if (res.plan) {
        const updated = { ...res.plan, title: entry.plan.title, note: entry.plan.note };
        setRun({ ...run, plans: run.plans.map((e) => (e.id === entry.id ? { ...e, plan: updated } : e)) });
      }
      if (res.matrix) setKnownLegs((prev) => [...prev, res.matrix as LegMatrix]);
      setChecks((c) => ({ ...c, [entry.id]: { ok: res.ok, label: res.label, changes: res.changes, problems: res.problems } }));
    } catch (e) {
      if (!isStopped(e)) setChecks((c) => ({ ...c, [entry.id]: { ok: false, label: 'Real drive times are not available right now, so the estimates stand.', changes: [], problems: [] } }));
    } finally {
      setChecking(null);
    }
  }

  function applyRate(key: string, value: number | null) {
    const next = { ...rates };
    if (value === null) delete next[key];
    else next[key] = value;
    setRates(next);
    // plan again with the new rate on the next tick, once it has been saved
    setTimeout(() => void runPlanWith(next), 0);
  }

  async function runPlanWith(newRates: Record<string, number>) {
    const session = sessionRef.current;
    if (!session || !today || !weekend || !season) return;
    setStatus('planning');
    setError(null);
    try {
      const home = ps.settings.home ? { lat: ps.settings.home.lat, lon: ps.settings.home.lon } : null;
      const ctx = { today, rates: newRates, labels: labelMap(vocab), knownLegs: knownLegs.length > 0 ? knownLegs : undefined, home };
      const onlyIds = shared?.onlyIds;
      const out =
        tab === 'weekend'
          ? await runWeekend(session, { settings: ps.settings, options: buildWeekendOptions(weekend, ctx, onlyIds ? { onlyIds, alternatives: 0 } : {}), mustInclude: onlyIds ? null : mustInclude })
          : await runSeason(session, { settings: ps.settings, options: buildSeasonOptions(season, ctx, onlyIds ? { onlyIds } : {}) });
      setRun(out);
    } catch (e) {
      if (!isStopped(e)) setError(plainError(e));
    }
    setStatus('ready');
  }

  function clearShared() {
    setShared(null);
    setRun(null);
    setPendingShared(false);
    window.history.replaceState(null, '', withBase('plan/'));
  }

  // ---- what the share button needs
  const shareSource: ShareSource | null = useMemo(() => {
    if (!run || !weekend || !season) return null;
    const startPoint = form?.startPlace ?? (ps.settings.home ? { lat: ps.settings.home.lat, lon: ps.settings.home.lon } : null);
    if (run.kind === 'weekend') return { kind: 'weekend', form: weekend, startPoint };
    const range = (run.options as { range: { start: string; end: string } }).range;
    return { kind: 'season', form: season, range, startPoint };
  }, [run, weekend, season, form?.startPlace, ps.settings.home]);

  // ---- rendering
  if (status === 'failed') {
    return (
      <div class="notice notice-warn" role="alert">
        {loadError}
      </div>
    );
  }
  if (status === 'loading' || !today || !weekend || !season || !vendor.ready) {
    return (
      <p class="loading" role="status">
        <Spinner /> Loading the shows...
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <div class="card empty" role="status">
        <h2>Shows are being added</h2>
        <p>The planner needs shows to work with. Check back soon.</p>
      </div>
    );
  }

  const planning = status === 'planning';
  const vendorCurrency = vendor.settings.currency;
  const needRate = run ? currenciesNeedingRate(run.excluded, vendorCurrency) : [];
  const dirty = hasOverrides(overrides);

  return (
    <div class="plan-app">
      {fixture && (
        <p class="notice notice-bad" role="note">
          These are made up sample shows. Do not plan a real trip from them.
        </p>
      )}
      {notice && (
        <p class="notice" role="status">
          {notice}
        </p>
      )}

      {shared && (
        <div class="notice notice-ok" role="status">
          <p>
            <strong>This is a shared plan.</strong> Someone sent you these {shared.onlyIds.length} {shared.onlyIds.length === 1 ? 'show' : 'shows'}. It was planned again with your own settings and start point, so the costs and profit are yours.
            {!ps.hasHome && ' Add a start point below, or your home in your settings, to see it.'}
          </p>
          <button type="button" class="btn btn-small" onClick={clearShared}>
            Plan something else
          </button>
        </div>
      )}

      {ps.missing.length > 0 && (
        <div class="notice notice-warn" role="note">
          <p>
            <strong>{ps.profit ? '' : 'Some of your settings are empty.'}</strong>{' '}
            {ps.missing.some((m) => m.needed === 'profit')
              ? 'Until they are filled in, plans are made by priority score instead of expected profit.'
              : ''}
          </p>
          <ul>
            {ps.missing.map((m) => (
              <li>
                <a href={withBase(`my-shows/#${m.fieldId}`)}>{m.label}</a>
                {m.needed === 'plan' ? ': needed to plan, or type a start point below' : ': needed for profit'}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div class="tabs" role="tablist" aria-label="Kind of plan">
        <button type="button" role="tab" id="tab-weekend" aria-selected={tab === 'weekend'} aria-controls="panel-plan" class="tab" onClick={() => setTab('weekend')}>
          Weekend run
        </button>
        <button type="button" role="tab" id="tab-season" aria-selected={tab === 'season'} aria-controls="panel-plan" class="tab" onClick={() => setTab('season')}>
          Season planner
        </button>
      </div>

      <section class="card" role="tabpanel" id="panel-plan" aria-labelledby={`tab-${tab}`}>
        <p class="muted" style={{ marginTop: 0 }}>
          {tab === 'weekend'
            ? 'One trip with several shows over a few days.'
            : 'The best set of shows across a stretch of months, each trip starting from home.'}
        </p>
        {tab === 'weekend' ? (
          <WeekendFormView
            form={weekend}
            onChange={setWeekend}
            vocab={vocab}
            settings={vendor.settings}
            hasHome={hasHome}
            today={today}
            mustInclude={mustInclude}
            onClearMust={() => setMustInclude(null)}
          />
        ) : (
          <SeasonFormView form={season} onChange={setSeason} vocab={vocab} settings={vendor.settings} hasHome={hasHome} today={today} />
        )}

        <div class="run-row">
          {planning ? (
            <>
              <p class="progress" role="status" aria-live="polite">
                <Spinner /> Planning{tab === 'season' ? ' your season' : ' your trip'}... This can take a few seconds for a long stretch of dates.
              </p>
              <button type="button" class="btn btn-danger" onClick={cancel}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" class="btn btn-primary btn-big" onClick={() => runPlan()} disabled={!ps.hasHome}>
              {shared ? 'Plan these shows again' : tab === 'weekend' ? 'Plan my weekend' : 'Plan my season'}
            </button>
          )}
          {!ps.hasHome && !planning && <p class="hint">Set a start point above, or add your home in your vendor settings.</p>}
        </div>
        {error && (
          <p class="notice notice-bad" role="alert">
            {error}
          </p>
        )}
      </section>

      <div ref={resultsRef} class="results-anchor" tabIndex={-1}>
        {run && (
          <section aria-label="Results" class="plan-results">
            <h2>{run.kind === 'weekend' ? 'Your weekend' : 'Your season'}</h2>
            <p class="muted">
              {run.candidates} {run.candidates === 1 ? 'show was' : 'shows were'} considered. Everything below is an estimate.
            </p>
            {run.notices.map((n) => (
              <p class="notice notice-warn">{n}</p>
            ))}
            {needRate.map((c) => (
              <RateBox currency={c} vendorCurrency={vendorCurrency} left={run.excluded.filter((x) => new RegExp(`in ${c}\\b`).test(x.reason) && /exchange rate/i.test(x.reason)).length} rates={rates} onApply={applyRate} />
            ))}
            {run.plans.length === 0 && (
              <div class="card empty">
                <h3>No plan fits</h3>
                <p>{run.warnings.find((w) => /no show|no plan|not expected/i.test(w)) ?? 'Try more dates, a longer drive, or fewer limits.'}</p>
              </div>
            )}
            {run.plans.map((entry) =>
              shareSource ? (
                <PlanCard
                  key={entry.id}
                  entry={entry}
                  run={run}
                  unit={unit}
                  rows={byId}
                  today={today}
                  settings={siteSettings}
                  profitReady={ps.profit}
                  placeholders={ps.placeholders}
                  overrides={overrides}
                  onOverrides={setOverrides}
                  onRecalculate={() => void runPlan()}
                  planning={planning}
                  check={checks[entry.id]}
                  checking={checking === entry.id}
                  onCheck={() => void checkDrive(entry)}
                  shareSource={shareSource}
                  planner={sessionRef.current as PlannerSession}
                  my={my}
                />
              ) : null,
            )}
            {run.warnings.length > 0 && run.plans.length > 0 && (
              <details class="card">
                <summary>Notes from the planner ({run.warnings.length})</summary>
                <ul>
                  {run.warnings.map((w) => (
                    <li>{w}</li>
                  ))}
                </ul>
              </details>
            )}
            {run.excluded.length > 0 && (
              <details class="card">
                <summary>Shows left out ({run.excluded.length})</summary>
                <ul class="excluded-list">
                  {run.excluded.slice(0, 60).map((x) => (
                    <li>
                      <strong>{x.name}</strong>: {x.reason}
                    </li>
                  ))}
                  {run.excluded.length > 60 && <li class="muted">and {run.excluded.length - 60} more.</li>}
                </ul>
              </details>
            )}
            {dirty && <p class="hint">You have changed numbers in a plan. Tap "Plan again with these numbers" in the plan to use them.</p>}
          </section>
        )}
      </div>
    </div>
  );
}
