// A place for a plan to start or end: a ZIP or postal code, or the device's location.
import { useState } from 'preact/hooks';
import type { PlanPlace } from '../lib/plan-options';
import { postalErrorMessage } from '../lib/postal';
import { lookupPostalInBrowser } from '../lib/postal-client';

interface Props {
  id: string;
  label: string;
  /** what "no place chosen" means, shown as the placeholder: "Home" */
  fallbackLabel: string;
  value: PlanPlace | null;
  onChange: (p: PlanPlace | null) => void;
  /** false when there is no home to fall back to */
  hasFallback: boolean;
}

export function PlaceField({ id, label, fallbackLabel, value, onChange, hasFallback }: Props) {
  const [text, setText] = useState(value && value.label !== 'your location' ? value.label : '');
  const [msg, setMsg] = useState<{ kind: 'error' | 'ok' | 'busy'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Enter, the Set button and leaving the field all set the place. Enter is handled on the input
  // itself rather than left to the browser's implicit form submit, so it works wherever the field
  // sits on the page.
  async function commit() {
    const typed = text.trim();
    if (typed === '') {
      if (value) {
        onChange(null);
        setMsg(null);
      }
      return;
    }
    if (value && value.label === typed) {
      setMsg({ kind: 'ok', text: `Set to ${value.label}.` });
      return;
    }
    setBusy(true);
    setMsg({ kind: 'busy', text: `Looking up ${typed}...` });
    const r = await lookupPostalInBrowser(typed);
    setBusy(false);
    if (!r.ok) {
      setMsg({ kind: 'error', text: postalErrorMessage(r.reason) });
      return;
    }
    onChange({ lat: r.lat, lon: r.lon, label: r.display, country: r.country });
    setText(r.display);
    setMsg({ kind: 'ok', text: `Set to ${r.display}.` });
  }

  function set(e: Event) {
    e.preventDefault();
    void commit();
  }

  function here() {
    if (!('geolocation' in navigator)) {
      setMsg({ kind: 'error', text: 'Your browser cannot share a location. Type a ZIP or postal code.' });
      return;
    }
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setBusy(false);
        const lat = Math.round(pos.coords.latitude * 100) / 100;
        const lon = Math.round(pos.coords.longitude * 100) / 100;
        onChange({ lat, lon, label: 'your location', country: null });
        setText('');
        setMsg({ kind: 'ok', text: 'Using your location. It stays on this device.' });
      },
      () => {
        setBusy(false);
        setMsg({ kind: 'error', text: 'We could not get your location. Type a ZIP or postal code.' });
      },
      { timeout: 15000, maximumAge: 10 * 60 * 1000 },
    );
  }

  return (
    <div class="field">
      <label for={id}>{label}</label>
      <form class="input-row" onSubmit={set}>
        <input
          id={id}
          type="text"
          autoComplete="postal-code"
          maxLength={12}
          placeholder="ZIP or postal code"
          value={text}
          onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void commit();
            }
          }}
          onBlur={() => {
            if (text.trim() !== '' && text.trim() !== (value?.label ?? '')) void commit();
          }}
          aria-describedby={`${id}-msg`}
        />
        <button class="btn" type="submit" disabled={busy}>
          Set
        </button>
      </form>
      <div class="btn-row" style={{ margin: '0.3rem 0 0' }}>
        <button type="button" class="btn btn-small" onClick={here} disabled={busy}>
          Use my location
        </button>
        {value && hasFallback && (
          <button
            type="button"
            class="btn btn-small btn-quiet"
            onClick={() => {
              onChange(null);
              setText('');
              setMsg(null);
            }}
          >
            Use {fallbackLabel.toLowerCase()} instead
          </button>
        )}
      </div>
      <p id={`${id}-msg`} class={`hint ${msg?.kind === 'error' ? 'error' : msg?.kind === 'ok' ? 'ok-text' : ''}`} role="status">
        {msg ? msg.text : value ? `Using ${value.label}.` : hasFallback ? `Using ${fallbackLabel.toLowerCase()}.` : 'Not set yet.'}
      </p>
    </div>
  );
}
