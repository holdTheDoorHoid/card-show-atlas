// The two forms on the Plan page: Weekend run and Season planner.
import { useState } from 'preact/hooks';
import { addDays, formatMonthDay } from '../lib/dates';
import { toggled } from '../lib/filters';
import type { PlanPlace, SeasonForm, SeasonSpan, WeekendForm } from '../lib/plan-options';
import type { VendorSettings } from '../lib/settings';
import type { Vocab } from '../lib/types';
import { allVocabEntries } from '../lib/vocab';
import { WEIGHT_PRESETS, type WeightPreset } from '../lib/weights';
import { PlaceField } from './PlaceField';

function Choice<T extends string>({ label, value, options, onChange, name }: { label: string; value: T; options: { id: T; title: string; text: string }[]; onChange: (v: T) => void; name: string }) {
  return (
    <div class="field">
      <div class="label" id={`${name}-label`}>
        {label}
      </div>
      <div class="choice-cards" role="radiogroup" aria-labelledby={`${name}-label`}>
        {options.map((o) => (
          <button type="button" role="radio" aria-checked={value === o.id} class="choice-card" onClick={() => onChange(o.id)}>
            <strong>{o.title}</strong>
            <span>{o.text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function WeightChips({ value, onChange }: { value: WeightPreset; onChange: (w: WeightPreset) => void }) {
  return (
    <div class="field">
      <div class="label" id="weights-label">
        What matters most
      </div>
      <div class="chips" role="group" aria-labelledby="weights-label">
        {WEIGHT_PRESETS.map((p) => (
          <button type="button" class="chip" aria-pressed={value === p.id} title={p.help} onClick={() => onChange(p.id)}>
            {p.label}
          </button>
        ))}
      </div>
      <span class="hint">Used to rank shows when expected profit is not available, and for the score on each show.</span>
    </div>
  );
}

function SellsPicker({ vocab, value, fromSettings, onChange }: { vocab: Vocab; value: string[] | null; fromSettings: string[]; onChange: (v: string[] | null) => void }) {
  const [open, setOpen] = useState(false);
  const current = value ?? fromSettings;
  const all = allVocabEntries(vocab);
  const shown = open ? all : all.filter((v) => current.includes(v.id) || ['pokemon', 'mtg', 'yugioh', 'one_piece', 'lorcana', 'baseball', 'basketball', 'football', 'hockey'].includes(v.id));
  return (
    <div class="field">
      <div class="label" id="plan-sells-label">
        What I sell
      </div>
      <div class="chips" role="group" aria-labelledby="plan-sells-label">
        {shown.map((v) => (
          <button type="button" class="chip" aria-pressed={current.includes(v.id)} onClick={() => onChange(toggled(current, v.id))}>
            {v.label}
          </button>
        ))}
        <button type="button" class="chip" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Fewer' : 'More...'}
        </button>
      </div>
      <span class="hint">{value === null ? 'Taken from your vendor settings.' : 'Changed for this plan only.'}</span>
    </div>
  );
}

function DriveHours({ value, fromSettings, onChange }: { value: number | null; fromSettings: number; onChange: (n: number | null) => void }) {
  return (
    <div class="field">
      <label for="plan-hours">Most hours I will drive in a day</label>
      <input
        id="plan-hours"
        type="number"
        inputMode="decimal"
        min={1}
        max={16}
        step={0.5}
        value={value ?? ''}
        placeholder={String(fromSettings)}
        onInput={(e) => {
          const v = (e.currentTarget as HTMLInputElement).value;
          onChange(v === '' || !Number.isFinite(Number(v)) ? null : Math.min(16, Math.max(1, Number(v))));
        }}
      />
      <span class="hint">Empty means the {fromSettings} hours in your vendor settings.</span>
    </div>
  );
}

interface CommonProps {
  vocab: Vocab;
  settings: VendorSettings;
  hasHome: boolean;
  today: string;
}

export function WeekendFormView({
  form,
  onChange,
  vocab,
  settings,
  hasHome,
  today,
  mustInclude,
  onClearMust,
}: CommonProps & { form: WeekendForm; onChange: (f: WeekendForm) => void; mustInclude: { id: string; name: string } | null; onClearMust: () => void }) {
  const set = (patch: Partial<WeekendForm>) => onChange({ ...form, ...patch });
  return (
    <div class="plan-form">
      {mustInclude && (
        <div class="field">
          <div class="label">Must include</div>
          <div class="chips">
            <span class="chip chip-static">
              {mustInclude.name}
              <button type="button" class="chip-x" onClick={onClearMust} aria-label={`Remove ${mustInclude.name} from this plan`}>
                {'×'}
              </button>
            </span>
          </div>
          <span class="hint">The dates start the day before and end the day after this show. If the best plans leave it out, you get a plan with just this show first.</span>
        </div>
      )}

      <div class="field-grid">
        <div class="field">
          <label for="wk-from">From</label>
          <input
            id="wk-from"
            type="date"
            min={today}
            value={form.start}
            onInput={(e) => {
              const v = (e.currentTarget as HTMLInputElement).value;
              if (v) set({ start: v, end: form.end < v ? v : form.end });
            }}
          />
        </div>
        <div class="field">
          <label for="wk-to">To</label>
          <input
            id="wk-to"
            type="date"
            min={form.start}
            max={addDays(form.start, 13)}
            value={form.end}
            onInput={(e) => {
              const v = (e.currentTarget as HTMLInputElement).value;
              if (v) set({ end: v });
            }}
          />
          <span class="hint">Up to 14 days. Use the season planner for longer.</span>
        </div>
      </div>

      <Choice
        label="How are you going?"
        name="wk-mode"
        value={form.mode}
        onChange={(mode) => set({ mode })}
        options={[
          { id: 'vending', title: 'Vending', text: 'You have a table all day. One show a day, and a long show takes all its days.' },
          { id: 'shopping', title: 'Shopping', text: 'You walk the floor. Several shows in one day, about an hour and a half at each, inside opening hours.' },
        ]}
      />
      {form.mode === 'shopping' && (
        <div class="field">
          <label for="wk-dwell">Time at each show</label>
          <select id="wk-dwell" value={String(form.dwellMinutes)} onChange={(e) => set({ dwellMinutes: Number((e.currentTarget as HTMLSelectElement).value) })}>
            {[45, 60, 90, 120, 180].map((m) => (
              <option value={String(m)}>{m < 120 ? `${m} minutes` : `${m / 60} hours`}</option>
            ))}
          </select>
        </div>
      )}

      <div class="field-grid">
        <PlaceField id="wk-start" label="Start from" fallbackLabel="Home" hasFallback={hasHome} value={form.startPlace} onChange={(startPlace) => set({ startPlace })} />
        <div>
          <label class="check end-same">
            <input type="checkbox" checked={form.endSame} onChange={(e) => set({ endSame: (e.currentTarget as HTMLInputElement).checked })} />
            End where I start
          </label>
          {!form.endSame && <PlaceField id="wk-end" label="End at" fallbackLabel="Home" hasFallback={hasHome} value={form.endPlace} onChange={(endPlace) => set({ endPlace })} />}
        </div>
      </div>

      <Choice
        label="Nights"
        name="wk-night"
        value={form.overnight}
        onChange={(overnight) => set({ overnight })}
        options={[
          { id: 'stay', title: 'Stay overnight when it helps', text: 'Hotels are allowed. Home is used whenever it is cheaper and fits.' },
          { id: 'home', title: 'Come home each night', text: 'Every night at home. A show too far away for that is left out.' },
        ]}
      />
      <DriveHours value={form.maxDriveHours} fromSettings={settings.maxDrivingHoursPerDay} onChange={(maxDriveHours) => set({ maxDriveHours })} />
      <SellsPicker vocab={vocab} value={form.sells} fromSettings={settings.sells} onChange={(sells) => set({ sells })} />
      <WeightChips value={form.weights} onChange={(weights) => set({ weights })} />
    </div>
  );
}

const SPANS: { id: SeasonSpan; label: string }[] = [
  { id: '3m', label: 'Next 3 months' },
  { id: '6m', label: 'Next 6 months' },
  { id: 'custom', label: 'Pick dates' },
];

function NumberOrNone({ id, label, value, onChange, max, hint, noneLabel }: { id: string; label: string; value: number | null; onChange: (n: number | null) => void; max: number; hint: string; noneLabel: string }) {
  return (
    <div class="field">
      <label for={id}>{label}</label>
      <div class="input-row">
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={0}
          max={max}
          step={1}
          disabled={value === null}
          value={value ?? ''}
          onInput={(e) => {
            const v = (e.currentTarget as HTMLInputElement).value;
            onChange(v === '' ? 0 : Math.min(max, Math.max(0, Math.round(Number(v)))));
          }}
        />
      </div>
      <label class="check">
        <input type="checkbox" checked={value === null} onChange={(e) => onChange((e.currentTarget as HTMLInputElement).checked ? null : Math.min(max, 3))} />
        {noneLabel}
      </label>
      <span class="hint">{hint}</span>
    </div>
  );
}

export function SeasonFormView({ form, onChange, vocab, settings, hasHome, today }: CommonProps & { form: SeasonForm; onChange: (f: SeasonForm) => void }) {
  const set = (patch: Partial<SeasonForm>) => onChange({ ...form, ...patch });
  const [blackoutText, setBlackoutText] = useState('');
  const addBlackout = () => {
    if (!blackoutText) return;
    set({ blackout: [...new Set([...form.blackout, blackoutText])].sort() });
    setBlackoutText('');
  };
  return (
    <div class="plan-form">
      <div class="field">
        <div class="label" id="se-span-label">
          Dates
        </div>
        <div class="chips" role="group" aria-labelledby="se-span-label">
          {SPANS.map((s) => (
            <button type="button" class="chip" aria-pressed={form.span === s.id} onClick={() => set({ span: s.id })}>
              {s.label}
            </button>
          ))}
        </div>
        {form.span === 'custom' && (
          <div class="field-grid" style={{ marginTop: '0.6rem' }}>
            <div class="field">
              <label for="se-from">From</label>
              <input id="se-from" type="date" min={today} value={form.start} onInput={(e) => { const v = (e.currentTarget as HTMLInputElement).value; if (v) set({ start: v, end: form.end < v ? v : form.end }); }} />
            </div>
            <div class="field">
              <label for="se-to">To</label>
              <input id="se-to" type="date" min={form.start} max={addDays(form.start, 395)} value={form.end} onInput={(e) => { const v = (e.currentTarget as HTMLInputElement).value; if (v) set({ end: v }); }} />
              <span class="hint">Up to about 13 months.</span>
            </div>
          </div>
        )}
      </div>

      <PlaceField id="se-start" label="Trips start and end at" fallbackLabel="Home" hasFallback={hasHome} value={form.startPlace} onChange={(startPlace) => set({ startPlace })} />

      <div class="field">
        <label for="se-blackout">Days I cannot be away</label>
        <div class="input-row">
          <input id="se-blackout" type="date" min={today} value={blackoutText} onInput={(e) => setBlackoutText((e.currentTarget as HTMLInputElement).value)} />
          <button type="button" class="btn" onClick={addBlackout} disabled={!blackoutText}>
            Add
          </button>
        </div>
        {form.blackout.length > 0 ? (
          <div class="chips" style={{ marginTop: '0.5rem' }}>
            {form.blackout.map((d) => (
              <span class="chip chip-static">
                {formatMonthDay(d, true)}
                <button type="button" class="chip-x" aria-label={`Remove ${formatMonthDay(d, true)}`} onClick={() => set({ blackout: form.blackout.filter((x) => x !== d) })}>
                  {'×'}
                </button>
              </span>
            ))}
          </div>
        ) : (
          <span class="hint">Your day job, family time, holidays. No show and no travel on these days.</span>
        )}
      </div>

      <div class="field">
        <label class="check">
          <input type="checkbox" checked={form.weekendsOnly} onChange={(e) => set({ weekendsOnly: (e.currentTarget as HTMLInputElement).checked })} />
          Weekends only
        </label>
        {form.weekendsOnly && (
          <label class="check">
            <input type="checkbox" checked={form.fridayCounts} onChange={(e) => set({ fridayCounts: (e.currentTarget as HTMLInputElement).checked })} />
            Count Friday as part of the weekend
          </label>
        )}
      </div>

      <div class="field-grid">
        <NumberOrNone id="se-month" label="Most shows in a month" value={form.maxShowsPerMonth} onChange={(maxShowsPerMonth) => set({ maxShowsPerMonth })} max={60} noneLabel="No limit" hint="A show counts in the month it starts." />
        <NumberOrNone id="se-nights" label="Longest stretch away (nights in a row)" value={form.maxNightsAway} onChange={(maxNightsAway) => set({ maxNightsAway })} max={30} noneLabel="No limit" hint="Zero means you are home every night." />
      </div>

      <Choice
        label="Trips"
        name="se-chain"
        value={form.chain ? 'chain' : 'home'}
        onChange={(v) => set({ chain: v === 'chain' })}
        options={[
          { id: 'chain', title: 'Chain shows into trips', text: 'Drive from one show straight to the next when it saves money and fits your limits.' },
          { id: 'home', title: 'Go home between shows', text: 'Every show is its own trip from home.' },
        ]}
      />
      <Choice
        label="Shows whose application deadline has passed"
        name="se-passed"
        value={form.keepPastDeadline ? 'keep' : 'drop'}
        onChange={(v) => set({ keepPastDeadline: v === 'keep' })}
        options={[
          { id: 'drop', title: 'Leave them out', text: 'Only plan shows you can still apply to.' },
          { id: 'keep', title: 'Keep them, marked waitlist only', text: 'Some organizers keep a waitlist. These are planned and clearly marked.' },
        ]}
      />
      <DriveHours value={form.maxDriveHours} fromSettings={settings.maxDrivingHoursPerDay} onChange={(maxDriveHours) => set({ maxDriveHours })} />
      <SellsPicker vocab={vocab} value={form.sells} fromSettings={settings.sells} onChange={(sells) => set({ sells })} />
      <WeightChips value={form.weights} onChange={(weights) => set({ weights })} />
    </div>
  );
}

export type { PlanPlace };
