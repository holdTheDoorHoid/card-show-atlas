// A small map of one plan: numbered stops joined by straight lines (trip by trip), and the start point.
// Leaflet is loaded only when a plan is on screen.
import { useEffect, useRef } from 'preact/hooks';
import { TILE_ATTRIBUTION, TILE_MAX_ZOOM, TILE_URL } from '../lib/config';
import { escapeHtml } from '../lib/format';
import { tripStops } from '../lib/plan-view';
import type { Plan } from '../../../planner/src/vending.ts';
import { isDarkNow } from './hooks';

const TRIP_COLORS = ['#0b4f9e', '#a3361c', '#007a5a', '#7a3d9e', '#9a6a00', '#b0408a'];

export default function PlanMap({ plan, label }: { plan: Plan; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let alive = true;
    let cleanup: (() => void) | null = null;
    (async () => {
      const [{ default: L }] = await Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')]);
      if (!alive) return;
      const map = L.map(el, { scrollWheelZoom: false, zoomControl: true });
      L.tileLayer(TILE_URL, { attribution: TILE_ATTRIBUTION, maxZoom: TILE_MAX_ZOOM }).addTo(map);
      const bounds = L.latLngBounds([]);
      const trips = tripStops(plan);
      trips.forEach((t, i) => {
        const color = TRIP_COLORS[i % TRIP_COLORS.length] as string;
        const pts: [number, number][] = [[plan.start.lat, plan.start.lon], ...t.stops.map((s) => [s.lat, s.lon] as [number, number]), [plan.end.lat, plan.end.lon]];
        L.polyline(pts, { color, weight: 3, opacity: 0.85, dashArray: '8 6' }).addTo(map);
        pts.forEach((p) => bounds.extend(p));
      });
      L.marker([plan.start.lat, plan.start.lon], {
        icon: L.divIcon({ className: '', html: '<div class="csa-start" title="Start">S</div>', iconSize: [26, 26], iconAnchor: [13, 13] }),
        interactive: false,
        keyboard: false,
      }).addTo(map);
      plan.stops.forEach((s, i) => {
        const m = L.marker([s.lat, s.lon], {
          icon: L.divIcon({ className: '', html: `<div class="csa-stop">${i + 1}</div>`, iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -14] }),
          keyboard: false,
          title: `${i + 1}. ${s.name}`,
        });
        m.bindPopup(`<div class="pop-name">${i + 1}. ${escapeHtml(s.name)}</div><div class="pop-when">${escapeHtml(s.hoursLabel)}</div><div class="pop-where">${escapeHtml(s.town)}</div>`, { maxWidth: 260 });
        m.addTo(map);
        bounds.extend([s.lat, s.lon]);
      });
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 11 });
      else map.setView([39.5, -98.35], 4);
      const syncTheme = () => wrap.current?.classList.toggle('dark-tiles', isDarkNow());
      syncTheme();
      window.addEventListener('csa-theme', syncTheme);
      const ro = new ResizeObserver(() => map.invalidateSize());
      ro.observe(el);
      cleanup = () => {
        window.removeEventListener('csa-theme', syncTheme);
        ro.disconnect();
        map.remove();
      };
    })();
    return () => {
      alive = false;
      cleanup?.();
    };
  }, [plan]);
  return (
    <div class="map-wrap" ref={wrap}>
      <div class="plan-map" ref={ref} role="img" aria-label={label} />
    </div>
  );
}
