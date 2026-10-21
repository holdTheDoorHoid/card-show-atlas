// Vendor settings: saved in this browser and read later by the route planner.
import { useState } from 'preact/hooks';
import { toggled } from '../lib/filters';
import { postalErrorMessage } from '../lib/postal';
import { lookupPostalInBrowser } from '../lib/postal-client';
import { MAX_DRIVING_HOURS_LIMITS, normalizeSettings, type VendorSettings } from '../lib/settings';
import type { Vocab } from '../lib/types';
import { allVocabEntries } from '../lib/vocab';

interface Props {
  settings: VendorSettings;
  vocab: Vocab;
  onSave: (s: VendorSettings) => boolean;
}

function numberOrNull(value: string): number | null {
  if (value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function NumberField(props: { id: string; label: string; hint?: string; value: number | null; onValue: (n: number | null) => void; step?: string; min?: number; max?: number; prefix?: string }) {
  return (
    <div class="field">
      <label for={props.id}>{props.label}</label>
      <input
        id={props.id}
        type="number"
        inputMode="decimal"
        min={props.min ?? 0}
        max={props.max}
        step={props.step ?? 'any'}
        value={props.value ?? ''}
        onInput={(e) => props.onValue(numberOrNull((e.currentTarget as HTMLInputElement).value))}
        aria-describedby={props.hint ? `${props.id}-hint` : undefined}
      />
      {props.hint && (
        <span class="hint" id={`${props.id}-hint`}>
          {props.hint}
        </span>
      )}
    </div>
  );
}

export function SettingsForm({ settings, vocab, onSave }: Props) {
  const [s, setS] = useState<VendorSettings>(settings);
  const [saved, setSaved] = useState<'idle' | 'ok' | 'failed'>('idle');
  const [postal, setPostal] = useState(settings.home.postal);
  const [homeMsg, setHomeMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  function change(patch: Partial<VendorSettings>) {
    const next = normalizeSettings({ ...s, ...patch });
    // keep what the person is typing as typed: only store the cleaned copy
    setS({ ...s, ...patch });
    setSaved(onSave(next) ? 'ok' : 'failed');
  }

  async function lookupHome(e: Event) {
    e.preventDefault();
    const r = await lookupPostalInBrowser(postal);
    if (!r.ok) {
      setHomeMsg({ kind: 'error', text: postalErrorMessage(r.reason) });
      return;
    }
    change({ home: { postal: r.display, lat: r.lat, lon: r.lon, country: r.country } });
    setHomeMsg({ kind: 'ok', text: `Home set to ${r.display}.` });
  }

  const mpg = s.fuelEconomyUnit === 'mpg';
  const sales = s.typicalSales;

  return (
    <form onSubmit={(e) => e.preventDefault()} aria-label="Vendor settings">
      <p class="muted">
        These stay on this device. The route planner will use them to estimate costs and profit. Use dollars everywhere, US or Canadian, whichever you
        deal in.
      </p>

      <div class="card" style={{ marginBottom: '1rem' }}>
        <h3 style={{ marginTop: 0 }}>Home base</h3>
        <div class="field">
          <label for="home-postal">Postal code or ZIP code</label>
          <div class="input-row">
            <input id="home-postal" type="text" autoComplete="postal-code" value={postal} maxLength={12} onInput={(e) => setPostal((e.currentTarget as HTMLInputElement).value)} />
            <button type="button" class="btn" onClick={lookupHome}>
              Look up
            </button>
          </div>
          <p class={`hint ${homeMsg?.kind === 'error' ? 'error' : homeMsg?.kind === 'ok' ? 'ok-text' : ''}`} role="status">
            {homeMsg
              ? homeMsg.text
              : s.home.lat !== null
                ? `Saved: ${s.home.postal || 'your coordinates'} (${s.home.lat.toFixed(2)}, ${s.home.lon?.toFixed(2)}).`
                : 'Not set yet.'}
          </p>
        </div>
        <details>
          <summary style={{ cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center' }}>Enter coordinates instead</summary>
          <div class="field-grid">
            <NumberField id="home-lat" label="Latitude" min={-90} max={90} value={s.home.lat} onValue={(n) => change({ home: { ...s.home, lat: n, country: s.home.country } })} />
            <NumberField id="home-lon" label="Longitude" min={-180} max={180} value={s.home.lon} onValue={(n) => change({ home: { ...s.home, lon: n, country: s.home.country } })} />
          </div>
        </details>
      </div>

      <div class="card" style={{ marginBottom: '1rem' }}>
        <h3 style={{ marginTop: 0 }}>Driving</h3>
        <div class="field-grid">
          <div class="field">
            <label for="fuel-unit">Fuel economy is in</label>
            <select id="fuel-unit" value={s.fuelEconomyUnit} onChange={(e) => change({ fuelEconomyUnit: (e.currentTarget as HTMLSelectElement).value as VendorSettings['fuelEconomyUnit'] })}>
              <option value="mpg">Miles per gallon (mpg)</option>
              <option value="l_per_100km">Litres per 100 km</option>
            </select>
          </div>
          <NumberField id="fuel-economy" label={mpg ? 'Fuel economy (mpg)' : 'Fuel economy (L per 100 km)'} min={0.1} value={s.fuelEconomy} onValue={(n) => change({ fuelEconomy: n })} />
          <NumberField id="fuel-price" label={mpg ? 'Fuel price per gallon' : 'Fuel price per litre'} step="0.01" value={s.fuelPrice} onValue={(n) => change({ fuelPrice: n })} />
          <NumberField
            id="max-hours"
            label="Most hours you will drive in a day"
            min={MAX_DRIVING_HOURS_LIMITS.min}
            max={MAX_DRIVING_HOURS_LIMITS.max}
            step="0.5"
            value={s.maxDrivingHoursPerDay}
            onValue={(n) => change({ maxDrivingHoursPerDay: n ?? 8 })}
          />
        </div>
      </div>

      <div class="card" style={{ marginBottom: '1rem' }}>
        <h3 style={{ marginTop: 0 }}>Staying away</h3>
        <div class="field-grid">
          <NumberField id="hotel" label="Hotel per night" step="1" value={s.hotelPerNight} onValue={(n) => change({ hotelPerNight: n })} />
          <NumberField id="food" label="Food per day" step="1" value={s.foodPerDay} onValue={(n) => change({ foodPerDay: n })} />
        </div>
      </div>

      <div class="card" style={{ marginBottom: '1rem' }}>
        <h3 style={{ marginTop: 0 }}>What a show usually brings in</h3>
        <p class="hint">Your typical gross sales at a show of each size. Leave a box empty if you have not done one that size.</p>
        <div class="field-grid cols-4">
          <NumberField id="sales-small" label="Small show" step="50" value={sales.small} onValue={(n) => change({ typicalSales: { ...sales, small: n } })} />
          <NumberField id="sales-medium" label="Medium show" step="50" value={sales.medium} onValue={(n) => change({ typicalSales: { ...sales, medium: n } })} />
          <NumberField id="sales-large" label="Large show" step="50" value={sales.large} onValue={(n) => change({ typicalSales: { ...sales, large: n } })} />
          <NumberField id="sales-major" label="Major show" step="50" value={sales.major} onValue={(n) => change({ typicalSales: { ...sales, major: n } })} />
        </div>
        <NumberField
          id="margin"
          label="Margin on sales (percent)"
          hint="If you sell a card for $10 that cost you $6, your margin is 40."
          min={0}
          max={100}
          step="1"
          value={s.marginPercent}
          onValue={(n) => change({ marginPercent: n })}
        />
      </div>

      <div class="card">
        <h3 style={{ marginTop: 0 }} id="sells-title">
          What you sell
        </h3>
        <div class="chips" role="group" aria-labelledby="sells-title">
          {allVocabEntries(vocab).map((v) => (
            <button type="button" class="chip" aria-pressed={s.sells.includes(v.id)} onClick={() => change({ sells: toggled(s.sells, v.id) })}>
              {v.label}
            </button>
          ))}
        </div>
      </div>

      <p role="status" class={saved === 'failed' ? 'error' : 'ok-text'} style={{ marginTop: '0.8rem' }}>
        {saved === 'ok' && 'Saved on this device.'}
        {saved === 'failed' && 'This browser would not save your settings. Private windows often block saving.'}
      </p>
    </form>
  );
}
