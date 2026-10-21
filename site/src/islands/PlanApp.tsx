// The Plan page. The route planner is being built separately; this page says what it will do and
// shows the show it was opened from (?show=<id>) and which vendor settings are still missing.
import { useEffect, useState } from 'preact/hooks';
import { formatRowDate } from '../lib/dates';
import { missingForProfit } from '../lib/settings';
import { showPath, withBase } from '../lib/urls';
import type { IndexRow } from '../lib/types';
import { loadIndex, useVendorSettings } from './hooks';

export default function PlanApp() {
  const { settings, ready } = useVendorSettings();
  const [showId, setShowId] = useState<string | null>(null);
  const [row, setRow] = useState<IndexRow | null>(null);
  const [lookup, setLookup] = useState<'idle' | 'loading' | 'missing'>('idle');

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('show');
    setShowId(id);
    if (!id) return;
    setLookup('loading');
    loadIndex().then(
      (index) => {
        const found = index.rows.find((r) => r.i === id) ?? null;
        setRow(found);
        setLookup(found ? 'idle' : 'missing');
      },
      () => setLookup('missing'),
    );
  }, []);

  const missing = ready ? missingForProfit(settings) : [];

  return (
    <div>
      {showId && (
        <section class="card" aria-live="polite">
          <h2 style={{ marginTop: 0 }}>Starting from this show</h2>
          {lookup === 'loading' && <p class="loading">Looking up the show...</p>}
          {row && (
            <p>
              <strong>{row.n}</strong>
              <br />
              {formatRowDate(row.d, row.e ?? row.d, new Date().getFullYear())}, {row.c}, {row.r}
              <br />
              <a href={withBase(showPath(row.i))}>Back to the show page</a>
            </p>
          )}
          {lookup === 'missing' && (
            <p>
              We could not find that show in the current list. It may have been removed or may be too far in the past.{' '}
              {showId && <a href={withBase(showPath(showId))}>Try its page</a>}.
            </p>
          )}
          <p class="muted">When the planner arrives, it will use this show as the first stop of a trip.</p>
        </section>
      )}

      <section class="card" style={{ marginTop: '1rem' }}>
        <h2 style={{ marginTop: 0 }}>Route planning is coming</h2>
        <p>
          We are building a planner that runs in your browser. Nothing you enter is sent to a server. It is not switched on yet, and
          this page will start working as soon as it is.
        </p>
        <div class="cols-2">
          <div>
            <h3>Weekend run</h3>
            <p>
              One trip with several shows over a few days. Choose whether you are vending or shopping, how many hours you will drive a day, and whether you
              sleep away or come home each night. You get the best chain of shows, day by day, with the drive for each leg, where you stay, and a few
              alternatives such as "one fewer show, home Saturday night".
            </p>
          </div>
          <div>
            <h3>Season planner</h3>
            <p>
              The best set of shows across a stretch of months, each trip starting from home. Tell it your blackout dates, how many shows a month you
              want, and the longest stretch you will be away. It lists every application deadline in the plan, in date order.
            </p>
          </div>
        </div>
        <h3>Profit estimate on every plan</h3>
        <p>
          Each plan shows what it may cost and earn: the table fee, fuel, hotel and food against your typical sales and margin. Every number can be
          edited in place, and it is always labeled as an estimate, not a promise.
        </p>
        <h3>Share and export</h3>
        <p>
          Export the plan to your calendar, open the route in a maps app, or share a link. A share link leaves out your start point unless you tick a box
          to include it.
        </p>
      </section>

      <section class="card" style={{ marginTop: '1rem' }}>
        <h2 style={{ marginTop: 0 }}>What the planner will use</h2>
        <p>The planner reads the vendor settings you save on the My shows page. They stay on this device.</p>
        {ready && missing.length === 0 && <p class="ok-text">Your vendor settings have what a profit estimate needs.</p>}
        {ready && missing.length > 0 && (
          <p>
            Still missing for a profit estimate: {missing.join(', ')}. <a href={withBase('my-shows/#settings')}>Fill them in</a>.
          </p>
        )}
        <p>
          <a class="btn" href={withBase('my-shows/#settings')}>
            Open vendor settings
          </a>
        </p>
      </section>
    </div>
  );
}
