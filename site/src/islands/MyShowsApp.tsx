// My shows: the vendor tracker. A board, deadlines, calendar export, backup and restore, settings.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { formatMonthDay, formatRange, todayISO } from '../lib/dates';
import { fileNameFor } from '../lib/ics';
import {
  backupFileName,
  byStage,
  calendarFor,
  createBackup,
  daysLeftText,
  deadlines,
  deadlineText,
  mergeStores,
  needsBackup,
  parseBackup,
  serializeBackup,
  snapshotFromRow,
  STAGES,
  trackedCount,
  type MyShow,
  type ParsedBackup,
  type Stage,
} from '../lib/myshows';
import { formatMoney, plural } from '../lib/format';
import { showPath, withBase } from '../lib/urls';
import type { IndexRow, Vocab } from '../lib/types';
import { DEFAULT_VOCAB } from '../lib/vocab';
import { downloadText, lastBackup, markBackedUp, useIndex, useMyShows, useToday, useVendorSettings, type MyShowsApi } from './hooks';
import { SettingsForm } from './SettingsForm';

function nOrNull(v: string): number | null {
  if (v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function TrackedCard({ entry, my, today }: { entry: MyShow; my: MyShowsApi; today: string }) {
  const s = entry.snapshot;
  const over = s.last < today;
  const id = `c-${entry.id}`;
  return (
    <article class="tracked" aria-labelledby={`${id}-name`}>
      <h4 id={`${id}-name`}>
        <a href={withBase(showPath(entry.id))}>{s.name}</a>
      </h4>
      <p class="muted small" style={{ margin: '0.1rem 0 0.4rem' }}>
        {formatRange(s.first, s.last, new Date().getFullYear())}, {s.city}, {s.region}
        {over && ' (over)'}
      </p>
      <div class="badges" style={{ marginBottom: '0.4rem' }}>
        {entry.stage === 'watching' && entry.deadline && <span class="badge badge-warn">Apply by {formatMonthDay(entry.deadline)}</span>}
        {entry.paymentDue && entry.stage !== 'paid' && entry.stage !== 'done' && entry.stage !== 'skipped' && (
          <span class="badge badge-warn">Pay by {formatMonthDay(entry.paymentDue)}</span>
        )}
        {entry.tablePrice !== null && <span class="badge">Table {formatMoney(entry.tablePrice)}</span>}
        {entry.grossSales !== null && <span class="badge badge-ok">Sold {formatMoney(entry.grossSales)}</span>}
        {entry.wouldDoAgain !== null && <span class="badge">Again: {entry.wouldDoAgain} of 5</span>}
      </div>
      <label class="sr-only" for={`${id}-stage`}>
        Move {s.name} to
      </label>
      <select id={`${id}-stage`} value={entry.stage} onChange={(e) => my.move(entry.id, (e.currentTarget as HTMLSelectElement).value as Stage)}>
        {STAGES.map((st) => (
          <option value={st.id}>{st.id === entry.stage ? `Stage: ${st.label}` : `Move to ${st.label}`}</option>
        ))}
      </select>
      <details>
        <summary>Details and notes</summary>
        <div class="field">
          <label for={`${id}-ttype`}>Table type</label>
          <input id={`${id}-ttype`} type="text" value={entry.tableType} placeholder="8 ft table" onInput={(e) => my.update(entry.id, { tableType: (e.currentTarget as HTMLInputElement).value })} />
        </div>
        <div class="field">
          <label for={`${id}-tprice`}>Table price paid</label>
          <input id={`${id}-tprice`} type="number" inputMode="decimal" min="0" step="any" value={entry.tablePrice ?? ''} onInput={(e) => my.update(entry.id, { tablePrice: nOrNull((e.currentTarget as HTMLInputElement).value) })} />
        </div>
        <div class="field">
          <label for={`${id}-applied`}>Date you applied</label>
          <input id={`${id}-applied`} type="date" value={entry.appliedOn ?? ''} onInput={(e) => my.update(entry.id, { appliedOn: (e.currentTarget as HTMLInputElement).value || null })} />
        </div>
        <div class="field">
          <label for={`${id}-deadline`}>Apply by</label>
          <input id={`${id}-deadline`} type="date" value={entry.deadline ?? ''} onInput={(e) => my.update(entry.id, { deadline: (e.currentTarget as HTMLInputElement).value || null })} />
        </div>
        <div class="field">
          <label for={`${id}-pay`}>Payment due</label>
          <input id={`${id}-pay`} type="date" value={entry.paymentDue ?? ''} onInput={(e) => my.update(entry.id, { paymentDue: (e.currentTarget as HTMLInputElement).value || null })} />
        </div>
        <div class="field">
          <label for={`${id}-notes`}>Notes</label>
          <textarea id={`${id}-notes`} value={entry.notes} onInput={(e) => my.update(entry.id, { notes: (e.currentTarget as HTMLTextAreaElement).value })} />
        </div>
        <h5 style={{ margin: '0.6rem 0 0.4rem' }}>After the show</h5>
        <div class="field">
          <label for={`${id}-sales`}>Actual gross sales</label>
          <input id={`${id}-sales`} type="number" inputMode="decimal" min="0" step="any" value={entry.grossSales ?? ''} onInput={(e) => my.update(entry.id, { grossSales: nOrNull((e.currentTarget as HTMLInputElement).value) })} />
        </div>
        <div class="field">
          <div class="label" id={`${id}-again`}>
            Would you do it again?
          </div>
          <div class="stars" role="group" aria-labelledby={`${id}-again`}>
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                type="button"
                aria-pressed={entry.wouldDoAgain === n}
                aria-label={`${n} of 5`}
                onClick={() => my.update(entry.id, { wouldDoAgain: entry.wouldDoAgain === n ? null : n })}
              >
                {n}
              </button>
            ))}
          </div>
          <span class="hint">1 is never again, 5 is definitely.</span>
        </div>
        <button
          type="button"
          class="btn btn-small btn-danger"
          onClick={() => {
            if (window.confirm(`Remove ${s.name} from My shows? This cannot be undone.`)) my.remove(entry.id);
          }}
        >
          Remove from My shows
        </button>
      </details>
    </article>
  );
}

function AddShow({ rows, my }: { rows: IndexRow[]; my: MyShowsApi }) {
  const [q, setQ] = useState('');
  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (t.length < 2) return [];
    return rows.filter((r) => r.n.toLowerCase().includes(t) || r.c.toLowerCase().includes(t) || r.r.toLowerCase() === t).slice(0, 8);
  }, [q, rows]);
  return (
    <div class="card" style={{ marginTop: '1rem' }}>
      <h2 style={{ marginTop: 0 }}>Add a show</h2>
      <label for="add-q">Search by show name or town</label>
      <input id="add-q" type="search" value={q} onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} placeholder="For example: Edison" />
      {q.trim().length >= 2 && matches.length === 0 && <p class="muted">No upcoming show matches that.</p>}
      {matches.length > 0 && (
        <ul class="plain-list" style={{ marginTop: '0.5rem' }}>
          {matches.map((r) => {
            const tracked = r.i in my.store.shows;
            return (
              <li style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ padding: '0.5rem 0' }}>
                  <strong>{r.n}</strong>
                  <br />
                  <span class="muted small">
                    {formatRange(r.d, r.e ?? r.d, new Date().getFullYear())}, {r.c}, {r.r}
                  </span>
                </span>
                <button type="button" class="btn btn-small" disabled={tracked} onClick={() => my.add(r.i, snapshotFromRow(r), { deadline: r.vd ?? null })}>
                  {tracked ? 'Added' : 'Add'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default function MyShowsApp() {
  const my = useMyShows();
  const today = useToday() ?? todayISO();
  const idx = useIndex();
  const settingsApi = useVendorSettings();
  const [backedUpAt, setBackedUpAt] = useState<string | null>(null);
  const [pending, setPending] = useState<{ parsed: Extract<ParsedBackup, { ok: true }> } | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [settingsVersion, setSettingsVersion] = useState(0);

  useEffect(() => setBackedUpAt(lastBackup()), [my.ready]);

  const vocab: Vocab = idx.status === 'ready' ? idx.index.vocab : DEFAULT_VOCAB;
  const columns = useMemo(() => byStage(my.store), [my.store]);
  const dl = useMemo(() => deadlines(my.store, today), [my.store, today]);
  const count = trackedCount(my.store);
  const nudge = my.ready && needsBackup(my.store, backedUpAt);

  function downloadBackup() {
    const now = new Date();
    downloadText(backupFileName(now), 'application/json', serializeBackup(createBackup(my.store, settingsApi.settings, now)));
    markBackedUp(now);
    setBackedUpAt(now.toISOString());
    setMessage({ kind: 'ok', text: 'Backup downloaded. Keep the file somewhere safe, such as your cloud drive or email.' });
  }

  function exportCalendar() {
    downloadText(fileNameFor('my-card-shows', 'ics'), 'text/calendar;charset=utf-8', calendarFor(my.store, today, new Date()));
    setMessage({ kind: 'ok', text: 'Calendar file downloaded. Open it to add your shows and deadline reminders (a week and a day before each).' });
  }

  async function onFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const text = await file.text();
    const parsed = parseBackup(text);
    if (!parsed.ok) {
      setPending(null);
      setMessage({ kind: 'error', text: parsed.error });
      return;
    }
    setMessage(null);
    setPending({ parsed });
  }

  function restore(mode: 'replace' | 'merge') {
    if (!pending) return;
    const { store, settings } = pending.parsed;
    if (mode === 'replace') {
      my.replace(store);
      settingsApi.save(settings);
      setSettingsVersion((v) => v + 1);
    } else {
      my.replace(mergeStores(my.store, store));
    }
    markBackedUp(new Date());
    setBackedUpAt(new Date().toISOString());
    setPending(null);
    setMessage({ kind: 'ok', text: mode === 'replace' ? 'Your list and settings were restored from the backup.' : 'The backup was merged into your list.' });
  }

  return (
    <div>
      <div class="notice notice-warn" role="note">
        <strong>Saved in this browser only.</strong> Clearing your browser data (cookies, site data or history) deletes this list and your settings. Download
        a backup after you make changes, and use it to move your list between your phone and your laptop.
      </div>

      {!my.persistent && (
        <div class="notice notice-bad" role="alert">
          This browser is not saving anything (a private window, or blocked site data). What you enter now will be lost when you close the page. Download a
          backup before you leave.
        </div>
      )}
      {my.saveFailed && (
        <div class="notice notice-bad" role="alert">
          The last change could not be saved. Download a backup now.
        </div>
      )}

      {nudge && (
        <div class="notice notice-ok" role="status">
          <p>
            <strong>You have changes that are not in a backup yet.</strong> {backedUpAt ? `Your last backup was ${formatMonthDay(backedUpAt.slice(0, 10))}.` : 'You have not made a backup yet.'}
          </p>
          <button type="button" class="btn btn-primary" onClick={downloadBackup}>
            Download a backup
          </button>
        </div>
      )}

      {message && (
        <p class={message.kind === 'error' ? 'notice notice-bad' : 'notice notice-ok'} role={message.kind === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}

      <div class="btn-row">
        <button type="button" class="btn" onClick={downloadBackup}>
          Download backup
        </button>
        <button type="button" class="btn" onClick={() => fileInput.current?.click()}>
          Restore from file
        </button>
        <button type="button" class="btn" onClick={exportCalendar} disabled={count === 0}>
          Export calendar (.ics)
        </button>
        <input ref={fileInput} type="file" accept="application/json,.json" class="sr-only" tabIndex={-1} onChange={onFile} aria-label="Choose a backup file to restore" />
      </div>

      {pending && (
        <div class="card" role="alertdialog" aria-labelledby="restore-title" style={{ marginBottom: '1rem' }}>
          <h2 id="restore-title" style={{ marginTop: 0 }}>
            Restore this backup?
          </h2>
          <p>
            It has {plural(trackedCount(pending.parsed.store), 'show')}
            {pending.parsed.exported ? `, made on ${formatMonthDay(pending.parsed.exported.slice(0, 10), true)}` : ''}. You have {plural(count, 'show')} now.
          </p>
          <div class="btn-row">
            <button type="button" class="btn btn-primary" onClick={() => restore('merge')}>
              Merge into my list
            </button>
            <button type="button" class="btn btn-danger" onClick={() => restore('replace')}>
              Replace my list and settings
            </button>
            <button type="button" class="btn" onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
          <p class="hint">Merging keeps both lists and, for a show in both, the copy changed most recently. Replacing throws away what is here now.</p>
        </div>
      )}

      <section class="card" aria-labelledby="deadlines-title">
        <h2 id="deadlines-title" style={{ marginTop: 0 }}>
          Deadlines
        </h2>
        {dl.upcoming.length === 0 && dl.passed.length === 0 ? (
          <p class="muted">
            No deadlines yet. When you add a show with an application deadline, it shows up here, soonest first. Add dates for payments in a show's details.
          </p>
        ) : (
          <>
            {dl.upcoming.length > 0 ? (
              <ol class="deadline-list">
                {dl.upcoming.map((d, i) => (
                  <li class={i === 0 ? 'soonest' : ''}>
                    <span>
                      <strong>{deadlineText(d)}</strong>
                      {': '}
                      <a href={withBase(showPath(d.id))}>{d.name}</a>
                    </span>
                    <span class={i === 0 ? 'badge badge-warn' : 'muted'}>{daysLeftText(d.daysLeft)}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p class="muted">Nothing coming up.</p>
            )}
            {dl.passed.length > 0 && (
              <details>
                <summary style={{ cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center' }}>Dates that have passed ({dl.passed.length})</summary>
                <ul class="deadline-list">
                  {dl.passed.map((d) => (
                    <li>
                      <span>
                        {deadlineText(d)}: <a href={withBase(showPath(d.id))}>{d.name}</a>
                      </span>
                      <span class="muted">{daysLeftText(d.daysLeft)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </section>

      {idx.status === 'ready' && <AddShow rows={idx.index.rows} my={my} />}

      <h2>Your board</h2>
      {my.ready && count === 0 && (
        <div class="card empty">
          <h3>Nothing here yet</h3>
          <p>
            Add shows with the Add button above, or open any show and tap "Add to My shows". Start with <a href={withBase('')}>shows near you</a>.
          </p>
        </div>
      )}
      <div class="board">
        {STAGES.map((st) => (
          <section class="column" aria-labelledby={`col-${st.id}`}>
            <h3 id={`col-${st.id}`}>
              <span>{st.label}</span>
              <span class="badge">{columns[st.id].length}</span>
            </h3>
            <div class="col-help">{st.help}</div>
            {columns[st.id].map((e) => (
              <TrackedCard entry={e} my={my} today={today} key={e.id} />
            ))}
          </section>
        ))}
      </div>

      <h2 id="settings" class="tabs-note">
        Vendor settings
      </h2>
      {settingsApi.ready ? (
        <SettingsForm key={settingsVersion} settings={settingsApi.settings} vocab={vocab} onSave={settingsApi.save} />
      ) : (
        <p class="loading">Loading your settings...</p>
      )}
    </div>
  );
}
