// Small presentational pieces used by both the interactive parts and the static pages.
import { EVENT_TYPE_INFO, markerSvg, SIZE_INFO } from '../lib/labels';
import { labelFor } from '../lib/vocab';
import type { EventType, SizeClass, Vocab } from '../lib/types';

export function SizeBars({ size }: { size: SizeClass }) {
  const bars = SIZE_INFO[size].bars;
  return (
    <span class="size-bars" aria-hidden="true">
      {[1, 2, 3, 4].map((n) => (
        <i class={n <= bars ? 'on' : ''} />
      ))}
    </span>
  );
}

/** Size as words plus bars, so it never relies on colour. */
export function SizeBadge({ size }: { size: SizeClass | null | undefined }) {
  if (!size) return <span class="badge">Size unknown</span>;
  return (
    <span class="badge badge-accent" title={SIZE_INFO[size].blurb}>
      <SizeBars size={size} />
      {SIZE_INFO[size].label}
    </span>
  );
}

export function ShapeIcon({ type, soft = false, size = 20 }: { type: EventType; soft?: boolean; size?: number }) {
  return <span class="shape-icon" aria-hidden="true" style={{ display: 'inline-flex' }} dangerouslySetInnerHTML={{ __html: markerSvg(type, { soft, size }) }} />;
}

export function TypeBadge({ type }: { type: EventType }) {
  return (
    <span class="badge">
      <ShapeIcon type={type} size={16} />
      {EVENT_TYPE_INFO[type].label}
    </span>
  );
}

export function SellsChips({ ids, vocab, max = 5 }: { ids: string[] | undefined; vocab: Vocab; max?: number }) {
  if (!ids || ids.length === 0) return <span class="muted">What is sold: not listed</span>;
  const shown = ids.slice(0, max);
  const more = ids.length - shown.length;
  return (
    <span class="sells">
      {shown.map((id) => (
        <span class="sell">{labelFor(vocab, id)}</span>
      ))}
      {more > 0 && <span class="sell">+{more} more</span>}
    </span>
  );
}

export function Legend({ types }: { types: EventType[] }) {
  return (
    <div class="legend" aria-label="Map symbols">
      {types.map((t) => (
        <span>
          <ShapeIcon type={t} size={22} />
          {EVENT_TYPE_INFO[t].label}
        </span>
      ))}
      <span>
        <ShapeIcon type="card_show" soft size={22} />
        Faded: approximate place
      </span>
    </div>
  );
}
