// The filter chips shared by the Find page and the Map page.
import { useEffect, useState } from 'preact/hooks';
import { countActiveFilters, DEFAULT_FILTERS, toggled, type Filters } from '../lib/filters';
import { EVENT_TYPE_INFO, SHOW_EVENT_TYPES, SIZE_INFO, SIZE_ORDER } from '../lib/labels';
import type { Vocab } from '../lib/types';
import { allVocabEntries, labelFor, SPORTS_ANY, TOP_SELL_CHIPS } from '../lib/vocab';
import { ShapeIcon } from './ui';

interface Props {
  filters: Filters;
  onChange: (f: Filters) => void;
  vocab: Vocab;
  /** unique prefix for element ids when two bars are on one page */
  idPrefix: string;
  /** Map page only: the store events layer switch */
  storeLayer?: { on: boolean; loading: boolean; missing: boolean; onChange: (on: boolean) => void };
}

function Chip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: preact.ComponentChildren }) {
  return (
    <button type="button" class="chip" aria-pressed={pressed} onClick={onClick}>
      {children}
    </button>
  );
}

export function FilterBar({ filters, onChange, vocab, idPrefix, storeLayer }: Props) {
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  useEffect(() => {
    // Open by default on wide screens, closed on phones where space is short.
    setOpen(window.matchMedia('(min-width: 62rem)').matches);
  }, []);
  const active = countActiveFilters(filters) + (storeLayer?.on ? 1 : 0);
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });

  const topIds = TOP_SELL_CHIPS.filter((id) => allVocabEntries(vocab).some((v) => v.id === id));
  const restEntries = allVocabEntries(vocab).filter((v) => !topIds.includes(v.id));

  return (
    <details class="filters" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        Filters
        {active > 0 && <span class="badge badge-accent">{active} on</span>}
      </summary>
      <div class="filter-body card">
        <div class="filter-group">
          <div class="label" id={`${idPrefix}-sells`}>What is sold</div>
          <div class="chips" role="group" aria-labelledby={`${idPrefix}-sells`}>
            {topIds.map((id) => (
              <Chip pressed={filters.sells.includes(id)} onClick={() => set({ sells: toggled(filters.sells, id) })}>
                {labelFor(vocab, id)}
              </Chip>
            ))}
            <Chip pressed={filters.sells.includes(SPORTS_ANY)} onClick={() => set({ sells: toggled(filters.sells, SPORTS_ANY) })}>
              Sports cards
            </Chip>
            <button type="button" class="chip" aria-expanded={more} onClick={() => setMore(!more)}>
              {more ? 'Fewer' : 'More...'}
            </button>
          </div>
          {more && (
            <div class="chips" role="group" aria-label="More things that are sold" style={{ marginTop: '0.5rem' }}>
              {restEntries.map((v) => (
                <Chip pressed={filters.sells.includes(v.id)} onClick={() => set({ sells: toggled(filters.sells, v.id) })}>
                  {v.label}
                </Chip>
              ))}
            </div>
          )}
          {filters.sells.length > 0 && (
            <label class="check" style={{ marginTop: '0.4rem' }}>
              <input type="checkbox" checked={filters.sellsKnownOnly} onChange={(e) => set({ sellsKnownOnly: (e.currentTarget as HTMLInputElement).checked })} />
              Only shows that say what they sell
            </label>
          )}
          <label class="check">
            <input type="checkbox" checked={filters.hideSportsOnly} onChange={(e) => set({ hideSportsOnly: (e.currentTarget as HTMLInputElement).checked })} />
            Hide shows that only sell sports cards
          </label>
        </div>

        <div class="filter-group">
          <div class="label" id={`${idPrefix}-type`}>Kind of event</div>
          <div class="chips" role="group" aria-labelledby={`${idPrefix}-type`}>
            {SHOW_EVENT_TYPES.map((t) => (
              <Chip pressed={filters.types.includes(t)} onClick={() => set({ types: toggled(filters.types, t) })}>
                <ShapeIcon type={t} size={18} />
                {EVENT_TYPE_INFO[t].plural}
              </Chip>
            ))}
          </div>
        </div>

        <div class="filter-group">
          <div class="label" id={`${idPrefix}-size`}>Size</div>
          <div class="chips" role="group" aria-labelledby={`${idPrefix}-size`}>
            {SIZE_ORDER.map((s) => (
              <Chip pressed={filters.sizes.includes(s)} onClick={() => set({ sizes: toggled(filters.sizes, s) })}>
                {SIZE_INFO[s].label}
              </Chip>
            ))}
          </div>
          <p class="hint" style={{ marginTop: '0.3rem' }}>Sizes are estimates. Shows with no estimate are hidden when you pick a size.</p>
        </div>

        <div class="filter-group">
          <div class="label" id={`${idPrefix}-more`}>Entry and vendors</div>
          <div class="chips" role="group" aria-labelledby={`${idPrefix}-more`}>
            <Chip pressed={filters.free} onClick={() => set({ free: !filters.free })}>
              Free entry
            </Chip>
            <Chip pressed={filters.vendorOpen} onClick={() => set({ vendorOpen: !filters.vendorOpen })}>
              Vendor tables open
            </Chip>
          </div>
        </div>

        {storeLayer && (
          <div class="filter-group">
            <div class="label">Store events</div>
            <label class="check">
              <input type="checkbox" checked={storeLayer.on} onChange={(e) => storeLayer.onChange((e.currentTarget as HTMLInputElement).checked)} />
              Show store events (prereleases, leagues, weekly tournaments)
            </label>
            <p class="hint">
              Off by default. They are loaded only when you switch this on, and they never count as shows near you.
              {storeLayer.on && storeLayer.loading && ' Loading...'}
              {storeLayer.on && storeLayer.missing && ' No store events are listed yet.'}
            </p>
          </div>
        )}

        {active > 0 && (
          <div>
            <button
              type="button"
              class="btn btn-small"
              onClick={() => {
                onChange({ ...DEFAULT_FILTERS });
                storeLayer?.onChange(false);
              }}
            >
              Clear all filters
            </button>
          </div>
        )}
      </div>
    </details>
  );
}
