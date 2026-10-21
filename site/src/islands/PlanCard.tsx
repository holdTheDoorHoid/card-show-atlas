// One plan: the map, the day by day itinerary, the legs, the money, the deadlines and the exports.
import { lazy } from 'preact/compat';
import { Suspense } from 'preact/compat';
import { useEffect, useState } from 'preact/hooks';
import type { PlannerShow } from '../../../planner/src/types.ts';
import type { MapsLink } from '../../../planner/src/links.ts';
import { formatShortDate } from '../../../planner/src/format.ts';
import { formatMonthDay } from '../lib/dates';
import { fileNameFor } from '../lib/ics';
import { snapshotFromPlanner } from '../lib/myshows';
import { planCalendar } from '../lib/plan-ics';
import { hasOverrides, type PlanOverrides } from '../lib/plan-options';
import type { PlanEntry, PlannerCaller, RunOutput } from '../lib/plan-run';
import { makeShareLink, shareUrl, type ShareSource } from '../lib/plan-share';
import { deadlinesInOrder, legText, legTitle, money, orderedCosts, stopsByMonth, summaryText } from '../lib/plan-view';
import type { DistanceUnit } from '../lib/geo';
import type { VendorSettings } from '../lib/settings';
import { showPath, withBase } from '../lib/urls';
import { downloadText, type MyShowsApi } from './hooks';

const PlanMap = lazy(() => import('./PlanMap'));

export interface CheckState {
  ok: boolean;
  label: string;
  changes: string[];
  problems: string[];
}

interface Props {
  entry: PlanEntry;
  run: RunOutput;
  unit: DistanceUnit;
  rows: Map<string, PlannerShow>;
  today: string;
  settings: VendorSettings;
  profitReady: boolean;
  placeholders: string[];
  overrides: PlanOverrides;
  onOverrides: (o: PlanOverrides) => void;
  onRecalculate: () => void;
  planning: boolean;
  check: CheckState | undefined;
  checking: boolean;
  onCheck: () => void;
  shareSource: ShareSource;
  planner: PlannerCaller;
  my: MyShowsApi;
}

function numberOrNull(v: string): number | null {
  if (v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function PlanCard(p: Props) {
  const { entry, run, unit, rows, today, settings } = p;
  const plan = entry.plan;
  const isSeason = run.kind === 'season';
  const [links, setLinks] = useState<MapsLink[] | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [includeStart, setIncludeStart] = useState(false);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  // Alternatives are drawn only when opened, so their maps are not built for nothing.
  const [opened, setOpened] = useState(false);

  // Google Maps links, made once per plan. The start point is left out, so the link does not carry a home address.
  useEffect(() => {
    let alive = true;
    p.planner.call('mapsLinks', { plan, options: { includeStart: false } }).then(
      (l) => alive && setLinks(l),
      () => alive && setLinks([]),
    );
    return () => {
      alive = false;
    };
  }, [plan]);

  useEffect(() => {
    if (!shareOpen) return;
    let alive = true;
    setShareLink(null);
    makeShareLink(p.planner, p.shareSource, plan, includeStart).then(
      (l) => alive && setShareLink(shareUrl(l)),
      () => alive && setShareMsg('The link could not be made.'),
    );
    return () => {
      alive = false;
    };
  }, [shareOpen, includeStart, plan]);

  function downloadCalendar() {
    downloadText(fileNameFor(`card show plan ${plan.departDate ?? today}`, 'ics'), 'text/calendar;charset=utf-8', planCalendar(plan, rows, { today, now: new Date(), name: plan.title }));
  }

  async function copy() {
    if (!shareLink) return;
    try {
      await navigator.clipboard.writeText(shareLink);
      setShareMsg('Link copied.');
    } catch {
      setShareMsg('Select the link and copy it.');
      (document.getElementById(`share-${entry.id}`) as HTMLInputElement | null)?.select();
    }
  }

  async function nativeShare() {
    if (!shareLink || !('share' in navigator)) return;
    try {
      await navigator.share({ title: 'A card show plan', url: shareLink });
    } catch {
      /* closed without sharing */
    }
  }

  function addAll() {
    let n = 0;
    for (const s of plan.stops) {
      const row = rows.get(s.showId);
      if (!row || s.showId in p.my.store.shows) continue;
      p.my.add(s.showId, snapshotFromPlanner(row), { deadline: s.deadline, tablePrice: s.table && !s.table.assumed ? s.table.amount : null });
      n++;
    }
    setAdded(n === 0 ? 'Everything in this plan is already on My shows.' : `Added ${n} ${n === 1 ? 'show' : 'shows'} to My shows as Watching.`);
  }

  const m = plan.money;
  const sales = m.sales;
  const fuelUnit = settings.fuelEconomyUnit === 'mpg' ? 'gallon' : 'litre';
  const deadlines = deadlinesInOrder(plan);
  const open = entry.role === 'best' || entry.role === 'forced' || entry.role === 'season';
  const costs = orderedCosts(m.costs);
  const sizeOf = (s: (typeof plan.stops)[number]) => rows.get(s.showId);

  const body = (
    <div class="plan-body">
      {entry.plan.note && <p class="notice">{entry.plan.note}</p>}

      <div class="btn-row">
        <button type="button" class="btn" onClick={p.onCheck} disabled={p.checking}>
          {p.checking ? 'Checking...' : 'Check real drive times'}
        </button>
        <button type="button" class="btn" onClick={downloadCalendar}>
          Add to calendar (.ics)
        </button>
        {links && links.length === 1 && (
          <a class="btn" href={links[0]!.url} target="_blank" rel="noopener noreferrer">
            Directions in Google Maps
          </a>
        )}
        <button type="button" class="btn" aria-expanded={shareOpen} onClick={() => setShareOpen(!shareOpen)}>
          Share this plan
        </button>
        <button type="button" class="btn" onClick={addAll}>
          Add all to My shows
        </button>
      </div>
      {links && links.length > 1 && (
        <p class="small">
          Directions in Google Maps:{' '}
          {links.map((l, i) => (
            <>
              {i > 0 && ' '}
              <a class="btn btn-small" href={l.url} target="_blank" rel="noopener noreferrer">
                {l.label}
              </a>
            </>
          ))}
        </p>
      )}
      {links && links.length > 0 && <p class="hint">Google Maps starts from where you are, so the link does not contain your home.</p>}
      {added && (
        <p class="notice notice-ok" role="status">
          {added} <a href={withBase('my-shows/')}>Open My shows</a>
        </p>
      )}

      {shareOpen && (
        <div class="card share-box">
          <label class="check">
            <input type="checkbox" checked={includeStart} onChange={(e) => setIncludeStart((e.currentTarget as HTMLInputElement).checked)} />
            Include my start point
          </label>
          <p class="hint">Anyone with the link could see roughly where you start, which may be your home. Leave this off to share only the shows and your settings for the plan.</p>
          <div class="input-row">
            <input id={`share-${entry.id}`} type="text" readOnly value={shareLink ?? 'Making the link...'} onFocus={(e) => (e.currentTarget as HTMLInputElement).select()} aria-label="Share link" />
            <button type="button" class="btn" onClick={copy} disabled={!shareLink}>
              Copy
            </button>
            {typeof navigator !== 'undefined' && 'share' in navigator && (
              <button type="button" class="btn" onClick={nativeShare} disabled={!shareLink}>
                Share
              </button>
            )}
          </div>
          <p class="hint" role="status">
            {shareMsg ?? 'Your sales, margin and costs are never put in a link.'}
          </p>
        </div>
      )}

      {p.check && (
        <div class={`notice ${p.check.ok ? 'notice-ok' : 'notice-warn'}`} role="status">
          <strong>{p.check.label}</strong>
          {p.check.changes.length > 0 && (
            <ul>
              {p.check.changes.map((c) => (
                <li>{c}</li>
              ))}
            </ul>
          )}
          {p.check.problems.length > 0 && (
            <ul>
              {p.check.problems.map((c) => (
                <li>{c}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <Suspense fallback={<div class="plan-map-loading">Loading the map...</div>}>
        <PlanMap plan={plan} label={`Map of ${plan.title}: ${plan.stops.length} stops`} />
      </Suspense>
      <p class="hint">Numbers are the order of the shows. Dashed lines are straight lines between stops, not the road.</p>

      {isSeason && (
        <section aria-label="Totals">
          <h4>Totals</h4>
          <dl class="dl">
            <dt>Shows</dt>
            <dd>{plan.stops.length}</dd>
            <dt>Trips</dt>
            <dd>{plan.trips.length}</dd>
            <dt>Hotel nights</dt>
            <dd>{plan.hotelNights}</dd>
            <dt>Driving</dt>
            <dd>
              {unit === 'km' ? `${Math.round(plan.miles * 1.609344)} km` : `${Math.round(plan.miles)} mi`}, {Math.round(plan.driveHours * 10) / 10} hours
            </dd>
          </dl>
        </section>
      )}

      <section aria-label="Shows in this plan">
        <h4>{isSeason ? 'Shows by month' : 'Shows'}</h4>
        {(isSeason ? stopsByMonth(plan) : [{ month: '', stops: plan.stops }]).map((g) => (
          <div>
            {g.month && <h5 class="month-head">{g.month}</h5>}
            <ol class="stop-list" start={isSeason ? undefined : 1}>
              {g.stops.map((s) => {
                const row = sizeOf(s);
                const fee = p.overrides.tableFees[s.showId];
                return (
                  <li class="stop" value={plan.stops.indexOf(s) + 1}>
                    <div>
                      <strong>
                        <a href={withBase(showPath(s.showId))}>{s.name}</a>
                      </strong>
                      <span class="muted">
                        {' '}
                        {s.town}
                      </span>
                    </div>
                    <div class="small">{s.hoursLabel}</div>
                    {s.waitlist && <span class="badge badge-warn">Waitlist only</span>}
                    {s.notes
                      .filter((n) => !(s.waitlist && /^waitlist only$/i.test(n)))
                      .map((n) => (
                        <div class="small muted">{n}</div>
                      ))}
                    {s.table && (
                      <div class="fee-row">
                        <label for={`fee-${entry.id}-${s.showId}`}>Table fee</label>
                        <input
                          id={`fee-${entry.id}-${s.showId}`}
                          type="number"
                          inputMode="decimal"
                          min={0}
                          step="any"
                          value={fee ?? Math.round(s.table.amount * 100) / 100}
                          onInput={(e) => {
                            const v = numberOrNull((e.currentTarget as HTMLInputElement).value);
                            const next = { ...p.overrides.tableFees };
                            if (v === null) delete next[s.showId];
                            else next[s.showId] = v;
                            p.onOverrides({ ...p.overrides, tableFees: next });
                          }}
                        />
                        <span class="muted small">
                          {s.table.currency}
                          {s.table.assumed && fee === undefined ? ', assumed because it is not listed' : ''}
                        </span>
                      </div>
                    )}
                    {s.sales && p.profitReady && (
                      <div class="small">
                        Expected sales about {money(s.sales.mid, s.sales.currency)} ({money(s.sales.low, s.sales.currency)} to {money(s.sales.high, s.sales.currency)})
                      </div>
                    )}
                    {s.score !== null && !p.profitReady && <div class="small">Priority score {s.score} of 100</div>}
                    {s.reasons.length > 0 && !p.profitReady && <div class="small muted">{s.reasons.slice(0, 3).join('. ')}</div>}
                    {row && row.estimate === null && <div class="small muted">Size not known.</div>}
                  </li>
                );
              })}
            </ol>
          </div>
        ))}
      </section>

      {isSeason && plan.trips.length > 0 && (
        <section aria-label="Trips">
          <h4>Trips</h4>
          <ul>
            {plan.trips.map((t) => (
              <li>
                {t.label}
                <span class="muted small">
                  {' '}
                  ({t.hotelNights} {t.hotelNights === 1 ? 'hotel night' : 'hotel nights'}, {unit === 'km' ? `${Math.round(t.miles * 1.609344)} km` : `${Math.round(t.miles)} mi`})
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="Day by day">
        <details open={!isSeason}>
          <summary>
            <h4 style={{ display: 'inline' }}>Day by day</h4>
            {isSeason && <span class="muted small"> ({plan.days.length} days)</span>}
          </summary>
          {plan.days.map((d) => (
            <div class="day">
              <h5>
                {d.label}
                {!d.away && <span class="badge" style={{ marginLeft: '0.5rem' }}>At home</span>}
              </h5>
              <ul class="day-items">
                {d.items.map((it) => (
                  <li>{it}</li>
                ))}
                {d.night && <li class="night">Night: {d.night.label}</li>}
              </ul>
            </div>
          ))}
        </details>
      </section>

      <section aria-label="Drives">
        <details open={!isSeason}>
          <summary>
            <h4 style={{ display: 'inline' }}>The drives</h4>
            {isSeason && <span class="muted small"> ({plan.legs.length})</span>}
          </summary>
          <p class="hint">Drive times: {plan.driveTimes.label}</p>
          <ul class="leg-list">
            {plan.legs.map((l) => (
              <li>
                <strong>{legTitle(l)}</strong>
                <span>{legText(l, unit)}</span>
              </li>
            ))}
          </ul>
        </details>
      </section>

      <section aria-label="Money">
        <h4>Money (an estimate, not a promise)</h4>
        {p.placeholders.length > 0 && (
          <p class="notice notice-warn">
            These numbers use placeholders ({p.placeholders.join(', ')}) because your vendor settings are not complete. <a href={withBase('my-shows/#settings')}>Fill them in</a> for real costs.
          </p>
        )}
        {sales && p.profitReady ? (
          <dl class="dl money-dl">
            <dt>Expected sales</dt>
            <dd>
              about {money(sales.mid, sales.currency)} <span class="muted">(range {money(sales.low, sales.currency)} to {money(sales.high, sales.currency)})</span>
            </dd>
            {m.contribution && (
              <>
                <dt>After your {Math.round(m.marginPercent)}% margin</dt>
                <dd>about {money(m.contribution.mid, m.currency)}</dd>
              </>
            )}
          </dl>
        ) : (
          <p class="muted">
            {p.profitReady ? 'No sales estimate for this plan.' : 'Expected sales and profit need your typical sales, margin, fuel, hotel and food in your vendor settings. This plan was made by priority score.'}
          </p>
        )}
        <table class="price-table cost-table">
          <caption class="sr-only">Costs</caption>
          <thead>
            <tr>
              <th scope="col">Cost</th>
              <th scope="col">Amount</th>
            </tr>
          </thead>
          <tbody>
            {costs.map((c) => (
              <tr>
                <td>
                  {c.label}
                  {c.assumed && <span class="badge" style={{ marginLeft: '0.4rem' }}>assumed</span>}
                  {c.detail && <div class="muted small">{c.detail}</div>}
                </td>
                <td>{c.converted ? money(c.amount, c.currency) : `${money(c.amount, c.currency)} (not converted)`}</td>
              </tr>
            ))}
            {m.totalCost !== null && (
              <tr class="total-row">
                <th scope="row">Total costs</th>
                <td>{money(m.totalCost, m.currency)}</td>
              </tr>
            )}
          </tbody>
        </table>
        <p class="money-label" role="status">
          <strong>{m.label}</strong>
        </p>
        {m.conversions.map((c) => (
          <p class="hint">{c}</p>
        ))}
        {sales && p.profitReady && (
          <details>
            <summary>How the sales are estimated</summary>
            <ul>
              {sales.explain.map((e) => (
                <li>{e}</li>
              ))}
            </ul>
          </details>
        )}
        <div class="edit-box">
          <h5>Change a number and plan again</h5>
          <div class="field-grid">
            <div class="field">
              <label for={`hotel-${entry.id}`}>Hotel per night ({settings.currency})</label>
              <input
                id={`hotel-${entry.id}`}
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                value={p.overrides.hotel ?? settings.hotelPerNight ?? ''}
                placeholder="0"
                onInput={(e) => p.onOverrides({ ...p.overrides, hotel: numberOrNull((e.currentTarget as HTMLInputElement).value) })}
              />
            </div>
            <div class="field">
              <label for={`fuel-${entry.id}`}>
                Fuel price per {fuelUnit} ({settings.currency})
              </label>
              <input
                id={`fuel-${entry.id}`}
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={p.overrides.fuelPrice ?? settings.fuelPrice ?? ''}
                onInput={(e) => p.onOverrides({ ...p.overrides, fuelPrice: numberOrNull((e.currentTarget as HTMLInputElement).value) })}
              />
            </div>
          </div>
          <p class="hint">Table fees are in the shows list above. Changes here are for this plan only. To keep them, change your <a href={withBase('my-shows/#settings')}>vendor settings</a>.</p>
          <button type="button" class="btn btn-primary" onClick={p.onRecalculate} disabled={p.planning || !hasOverrides(p.overrides)}>
            Plan again with these numbers
          </button>
        </div>
      </section>

      <section aria-label="Application deadlines">
        <h4>Application deadlines</h4>
        {deadlines.length === 0 ? (
          <p class="muted">No deadlines to track in this plan.</p>
        ) : (
          <ul class="deadline-plain">
            {deadlines.map((d) => (
              <li class={d.passed ? 'passed' : ''}>
                <strong>{d.date ? formatShortDate(d.date) : 'No date'}</strong>: <a href={withBase(showPath(d.showId))}>{d.name}</a>, {d.label}
                {d.waitlist && <span class="badge badge-warn" style={{ marginLeft: '0.4rem' }}>Waitlist</span>}
              </li>
            ))}
          </ul>
        )}
        <p class="hint">The calendar file reminds you a week and a day before each date.</p>
      </section>

      {(plan.warnings.length > 0) && (
        <section aria-label="Things to know">
          <h4>Things to know</h4>
          <ul>
            {plan.warnings.map((w) => (
              <li>{w}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );

  return (
    <article class="card plan-card" aria-label={plan.title}>
      {open ? (
        <>
          <header class="plan-head">
            <h3>{plan.title}</h3>
            <p class="plan-summary">{summaryText(plan.summary, unit)}</p>
            <p class="plan-profit">{m.label}</p>
            <p class="hint">Drive times: {plan.driveTimes.label}. {formatMonthDay(plan.departDate ?? today)}{plan.returnDate && plan.returnDate !== plan.departDate ? ` to ${formatMonthDay(plan.returnDate)}` : ''}</p>
          </header>
          {body}
        </>
      ) : (
        <details onToggle={(e) => setOpened((e.currentTarget as HTMLDetailsElement).open)}>
          <summary class="plan-summary-row">
            <span class="plan-title">{plan.title}</span>
            <span class="plan-summary">{summaryText(plan.summary, unit)}</span>
            <span class="plan-profit">{m.label}</span>
            {plan.note && <span class="muted small">{plan.note}</span>}
          </summary>
          {opened && body}
        </details>
      )}
    </article>
  );
}
