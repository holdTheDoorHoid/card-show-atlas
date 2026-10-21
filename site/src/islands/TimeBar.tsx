// The map's time window bar: a 12 month timeline with a bar chart of shows per day, and a window you
// drag along it. Works with a mouse, a finger and the keyboard.
import { useRef } from 'preact/hooks';
import { MAX_WINDOW_DAYS, TIMELINE_DAYS } from '../lib/config';
import { plural } from '../lib/format';
import {
  clampWindow,
  dayFromPointer,
  describeWindow,
  dragTo,
  monthMarks,
  moveWindow,
  resizeWindow,
  WIDTH_PRESETS,
  type TimeWindow,
} from '../lib/timewindow';

interface Props {
  today: string;
  counts: number[];
  win: TimeWindow;
  onChange: (w: TimeWindow) => void;
  playing: boolean;
  onPlayToggle: () => void;
  /** shows inside the window right now */
  matching: number;
}

export function TimeBar({ today, counts, win, onChange, playing, onPlayToggle, matching }: Props) {
  const total = TIMELINE_DAYS;
  const trackRef = useRef<HTMLDivElement>(null);
  const winRef = useRef(win);
  winRef.current = win;
  const grab = useRef<number | null>(null);
  const max = Math.max(1, ...counts);

  const bars: string[] = [];
  counts.forEach((c, i) => {
    if (c > 0) {
      const h = 6 + (c / max) * 90;
      bars.push(`M${i} ${100 - h}h0.82v${h}h-0.82z`);
    }
  });

  const dayAt = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    return rect ? dayFromPointer(clientX, rect.left, rect.width, total) : 0;
  };

  const onDown = (e: PointerEvent) => {
    const w = winRef.current;
    const day = dayAt(e.clientX);
    const inside = day >= w.start && day < w.start + w.width;
    const g = inside ? day - w.start : Math.floor(w.width / 2);
    grab.current = g;
    if (!inside) onChange(dragTo(w, day, g, total));
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const onMove = (e: PointerEvent) => {
    if (grab.current === null) return;
    const w = winRef.current;
    const next = dragTo(w, dayAt(e.clientX), grab.current, total);
    if (next.start !== w.start) onChange(next);
  };
  const onUp = () => {
    grab.current = null;
  };

  const onKey = (e: KeyboardEvent) => {
    const w = winRef.current;
    let next: TimeWindow | null = null;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        next = moveWindow(w, e.shiftKey ? 7 : 1, total);
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        next = moveWindow(w, e.shiftKey ? -7 : -1, total);
        break;
      case 'PageUp':
        next = moveWindow(w, 7, total);
        break;
      case 'PageDown':
        next = moveWindow(w, -7, total);
        break;
      case 'Home':
        next = clampWindow({ start: 0, width: w.width }, total);
        break;
      case 'End':
        next = clampWindow({ start: total, width: w.width }, total);
        break;
      case '+':
      case '=':
        next = resizeWindow(w, w.width + (w.width >= 14 ? 7 : 1), total);
        break;
      case '-':
      case '_':
        next = resizeWindow(w, w.width - (w.width > 14 ? 7 : 1), total);
        break;
    }
    if (next) {
      e.preventDefault();
      onChange(next);
    }
  };

  const marks = monthMarks(today, total);
  // When the next month starts within days, its label would sit on top of the first one.
  const labels = marks.filter((_, i) => !(i === 0 && marks[1] && marks[1].offset < 12));
  const summary = describeWindow(today, win);
  const left = (win.start / total) * 100;
  const width = (win.width / total) * 100;

  return (
    <section class="timebar" aria-label="Time window">
      <div class="timebar-top">
        <div class="timebar-summary" role="status" aria-live={grab.current === null ? 'polite' : 'off'}>
          {summary}: {plural(matching, 'show')}
        </div>
        <div class="timebar-controls">
          <button type="button" class="btn btn-small" onClick={() => onChange(moveWindow(win, -7, total))} aria-label="Move the window one week earlier">
            Earlier
          </button>
          <button type="button" class="btn btn-small btn-primary" aria-pressed={playing} onClick={onPlayToggle}>
            {playing ? 'Pause' : 'Play'}
          </button>
          <button type="button" class="btn btn-small" onClick={() => onChange(moveWindow(win, 7, total))} aria-label="Move the window one week later">
            Later
          </button>
          <button type="button" class="btn btn-small" onClick={() => onChange(clampWindow({ start: 0, width: win.width }, total))}>
            Today
          </button>
        </div>
      </div>

      <div class="timeline" ref={trackRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <svg class="bars" viewBox={`0 0 ${total} 100`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <path d={bars.join('')} fill="currentColor" style={{ fill: 'var(--muted)', opacity: 0.8 }} />
        </svg>
        <div
          class="window"
          role="slider"
          tabIndex={0}
          aria-label="Time window start. Use the arrow keys to move it by a day, hold shift or use page up and down for a week, plus and minus to change its width."
          aria-valuemin={0}
          aria-valuemax={total - win.width}
          aria-valuenow={win.start}
          aria-valuetext={`${summary}, ${plural(matching, 'show')}`}
          style={{ left: `${left}%`, width: `${width}%` }}
          onKeyDown={onKey}
        />
      </div>
      <div class="month-labels" aria-hidden="true">
        {labels.map((m, i) => {
          const [month, year] = m.label.split(' ');
          return (
            <span class={i % 2 === 1 && !year ? 'minor' : ''} style={{ left: `${(m.offset / total) * 100}%` }}>
              {month}
              {year && <span class="yr"> {year}</span>}
            </span>
          );
        })}
      </div>
      <div class="width-row">
        <label for="win-width" style={{ margin: 0 }}>
          Width: {win.width === 1 ? '1 day' : `${win.width} days`}
        </label>
          <input
            id="win-width"
            type="range"
            min={1}
            max={MAX_WINDOW_DAYS}
            value={win.width}
            onInput={(e) => onChange(resizeWindow(winRef.current, Number((e.currentTarget as HTMLInputElement).value), total))}
          />
          <div class="chips">
            {WIDTH_PRESETS.map((p) => (
              <button type="button" class="chip" aria-pressed={win.width === p.days} onClick={() => onChange(resizeWindow(win, p.days, total))}>
                {p.label}
              </button>
            ))}
          </div>
      </div>
    </section>
  );
}
