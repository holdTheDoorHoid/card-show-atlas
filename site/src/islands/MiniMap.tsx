// A small map with one marker, on a show page. Leaflet is loaded only when the map scrolls into view
// (the component is hydrated with client:visible and then imports Leaflet itself).
import { useEffect, useRef } from 'preact/hooks';
import { TILE_ATTRIBUTION, TILE_MAX_ZOOM, TILE_URL } from '../lib/config';
import { isApproximate, markerSvg } from '../lib/labels';
import type { EventType, GeoPrecision } from '../lib/types';

interface Props {
  lat: number;
  lon: number;
  type: EventType;
  precision: GeoPrecision;
  name: string;
}

export default function MiniMap({ lat, lon, type, precision, name }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let alive = true;
    let cleanup: (() => void) | null = null;
    (async () => {
      const [{ default: L }] = await Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')]);
      if (!alive) return;
      const soft = isApproximate(precision);
      const zoom = precision === 'city' ? 10 : precision === 'postal' ? 12 : 15;
      const map = L.map(el, { scrollWheelZoom: false, zoomControl: true }).setView([lat, lon], zoom);
      L.tileLayer(TILE_URL, { attribution: TILE_ATTRIBUTION, maxZoom: TILE_MAX_ZOOM }).addTo(map);
      L.marker([lat, lon], {
        icon: L.divIcon({ className: 'csa-pin', html: markerSvg(type, { soft, size: 34 }), iconSize: [34, 34], iconAnchor: [17, 17] }),
        title: name,
        alt: name,
        keyboard: false,
      }).addTo(map);
      cleanup = () => map.remove();
    })();
    return () => {
      alive = false;
      cleanup?.();
    };
  }, [lat, lon, type, precision, name]);
  return <div class="mini-map" ref={ref} role="img" aria-label={`Map showing where ${name} is`} />;
}
