// The filter chips shared by the Find page and the Map page.
import { useEffect, useState } from 'preact/hooks';
import { countActiveFilters, DEFAULT_FILTERS, describeFilters, toggled, type Filters } from '../lib/filters';
import { EVENT_TYPE_INFO, SHOW_EVENT_TYPES, SIZE_INFO, SIZE_ORDER } from '../lib/labels';
import type { Vocab } from '../lib/types';
import { browserStore, readJson, STORAGE_KEYS, writeJson } from '../lib/storage';
import { allVocabEntries, labelFor, SPORTS_ANY, TOP_SELL_CHIPS } from '../lib/vocab';
import { ShapeIcon } from './ui';

interface Props {
  filters: Filters;
  onChange: (f: Filters) => void;
  vocab: Vocab;
  /** the page this bar is on ("find" or "map"): used for element ids and to remember whether the panel is open */
  idPrefix: string;
  /** told when the panel opens or closes, so the page can make room */
  onOpenChange?: (open: boolean) => void;
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

export function FilterBar({ filters, onChange, vocab, idPrefix, storeLayer, onOpenChange }: Props) {
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  // Closed by default so the results (or the map) stay in view. Whether it is open is remembered per page.
  useEffect(() => {
    const saved = readJson(browserStore(), STORAGE_KEYS.filtersOpen);
    const isOpen = !!saved && typeof saved === 'object' && (saved as Record<string, unknown>)[idPrefix] === true;
    setOpen(isOpen);
    onOpenChange?.(isOpen);
  }, []);
  function setOpenRemembered(next: boolean) {
    setOpen(next);
    onOpenChange?.(next);
    const saved = readJson(browserStore(), STORAGE_KEYS.filtersOpen);
    const all = saved && typeof saved === 'object' ? { ...(saved as Record<string, boolean>) } : {};
    all[idPrefix] = next;
    writeJson(browserStore(), STORAGE_KEYS.filtersOpen, all);
  }
  const active = countActiveFilters(filters) + (storeLayer?.on ? 1 : 0);
  const summary = describeFilters(filters, vocab, { storeEvents: storeLayer?.on });
  function clearAll() {
    onChange({ ...DEFAULT_FILTERS });
    storeLayer?.onChange(false);
  }
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });

  const topIds = TOP_SELL_CHIPS.filter((id) => allVocabEntries(vocab).some((v) => v.id === id));
  const restEntries = allVocabEntries(vocab).filter((v) => !topIds.includes(v.id));

  return (
    <div class="filters">
      <div class="filters-bar">
        <button type="button" class="btn filters-toggle" aria-expanded={open} aria-controls={`${idPrefix}-filter-panel`} onClick={() => setOpenRemembered(!open)}>
          Filters{active > 0 ? ` (${active})` : ''}
          <span aria-hidden="true">{open ? '\u25B4' : '\u25BE'}</span>
        </button>
        {active > 0 && (
          <span class="filters-summary" title={summary}>
            {summary}
          </span>
        )}
        {active > 0 && (
          <button type="button" class="link-button" onClick={clearAll} aria-label="Clear all filters">
            Clear
          </button>
        )}
      </div>
      {open && (
      <div class="filter-body card" id={`${idPrefix}-filter-panel`}>
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
            <button type="button" class="btn btn-small" onClick={clearAll}>
              Clear all filters
            </button>
          </div>
        )}
      </div>
      )}
    </div>
  );
}
