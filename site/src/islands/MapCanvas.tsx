// The Leaflet map: OpenStreetMap tiles, clustered markers (supercluster copes with 10,000+ points),
// marker shape and colour by event type, softer markers for approximate places.
// This file is loaded on demand (see LazyMap.tsx) so Leaflet stays out of pages that never show a map.
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import Supercluster from 'supercluster';
import { useEffect, useRef } from 'preact/hooks';
import { DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM, TILE_ATTRIBUTION, TILE_MAX_ZOOM, TILE_URL } from '../lib/config';
import { markerSvg } from '../lib/labels';
import { groupPlaces, popupHtml, type Place } from '../lib/map-data';
import type { IndexRow } from '../lib/types';
import { showPath, withBase } from '../lib/urls';
import { isDarkNow } from './hooks';

export type MapView = { kind: 'default' } | { kind: 'center'; center: [number, number]; zoom: number } | { kind: 'bounds'; bounds: [[number, number], [number, number]] };

export interface MapCanvasProps {
  rows: IndexRow[];
  /** store events layer, drawn only when given */
  storeRows?: IndexRow[];
  /** where the visitor is, drawn as a blue dot */
  origin?: { lat: number; lon: number } | null;
  view: MapView;
  /** the view is applied again whenever this changes */
  viewKey: string;
  tall?: boolean;
  label: string;
}

interface LayerPlace extends Place {
  store: boolean;
}

const CLUSTER_MAX_ZOOM = 17;
const iconCache = new Map<string, L.DivIcon>();

function pinIcon(place: LayerPlace): L.DivIcon {
  const count = Math.min(place.rows.length, 99);
  const key = `${place.type}|${place.soft}|${count}`;
  let icon = iconCache.get(key);
  if (!icon) {
    const badge = count > 1 ? `<span class="count">${count}</span>` : '';
    icon = L.divIcon({
      className: 'csa-pin',
      html: markerSvg(place.type, { soft: place.soft, size: 30 }) + badge,
      iconSize: [30, 30],
      iconAnchor: [15, 15],
      popupAnchor: [0, -13],
    });
    iconCache.set(key, icon);
  }
  return icon;
}

function clusterIcon(count: number): L.DivIcon {
  const size = count >= 1000 ? 56 : count >= 100 ? 50 : count >= 10 ? 44 : 38;
  const label = count >= 1000 ? `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(count);
  const tier = count >= 100 ? 'big' : count >= 10 ? 'mid' : '';
  return L.divIcon({
    className: '',
    html: `<div class="csa-cluster ${tier}" style="width:${size}px;height:${size}px">${label}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function placeLabel(place: LayerPlace): string {
  const first = place.rows[0] as IndexRow;
  return place.rows.length === 1 ? `${first.n}, ${first.c}, ${first.r}` : `${place.rows.length} shows in ${first.c}, ${first.r}`;
}

function applyView(map: L.Map, view: MapView): void {
  if (view.kind === 'center') map.setView(view.center, view.zoom, { animate: false });
  else if (view.kind === 'bounds') map.fitBounds(view.bounds, { padding: [34, 34], maxZoom: 11, animate: false });
  else map.setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM, { animate: false });
}

export function MapCanvas(props: MapCanvasProps) {
  const box = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const live = useRef<{
    map: L.Map;
    markers: L.LayerGroup;
    here: L.LayerGroup;
    index: Supercluster<{ n: number }, { n: number }> | null;
    places: LayerPlace[];
    render: () => void;
  } | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  // create the map once
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const map = L.map(el, { zoomControl: true, worldCopyJump: true, minZoom: 2, maxZoom: TILE_MAX_ZOOM, preferCanvas: false });
    L.tileLayer(TILE_URL, { attribution: TILE_ATTRIBUTION, maxZoom: TILE_MAX_ZOOM, crossOrigin: false }).addTo(map);
    const markers = L.layerGroup().addTo(map);
    const here = L.layerGroup().addTo(map);
    applyView(map, propsRef.current.view);

    const state = { map, markers, here, index: null as Supercluster<{ n: number }, { n: number }> | null, places: [] as LayerPlace[], render: () => {} };
    live.current = state;

    const render = () => {
      markers.clearLayers();
      if (!state.index) return;
      const b = map.getBounds();
      const bbox: [number, number, number, number] = [Math.max(-180, b.getWest()), Math.max(-85, b.getSouth()), Math.min(180, b.getEast()), Math.min(85, b.getNorth())];
      const clusters = state.index.getClusters(bbox, Math.round(map.getZoom()));
      for (const c of clusters) {
        const [lon, lat] = c.geometry.coordinates as [number, number];
        const props = c.properties as { cluster?: boolean; cluster_id?: number; n: number; idx?: number };
        if (props.cluster && props.cluster_id !== undefined) {
          const id = props.cluster_id;
          const m = L.marker([lat, lon], { icon: clusterIcon(props.n), keyboard: true, title: `${props.n} shows. Zoom in.`, alt: `${props.n} shows, zoom in` });
          m.on('click', () => {
            const z = Math.min(state.index?.getClusterExpansionZoom(id) ?? map.getZoom() + 2, TILE_MAX_ZOOM - 1);
            map.setView([lat, lon], z);
          });
          m.addTo(markers);
        } else if (props.idx !== undefined) {
          const place = state.places[props.idx];
          if (!place) continue;
          const m = L.marker([lat, lon], { icon: pinIcon(place), keyboard: true, title: placeLabel(place), alt: placeLabel(place), riseOnHover: true });
          m.bindPopup(popupHtml(place, { showHref: (id) => withBase(showPath(id)), isStoreLayer: place.store, refYear: new Date().getFullYear() }), { maxWidth: 290, autoPanPadding: [30, 30] });
          m.addTo(markers);
        }
      }
    };
    state.render = render;
    map.on('moveend', render);

    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(el);

    const syncTheme = () => wrap.current?.classList.toggle('dark-tiles', isDarkNow());
    syncTheme();
    window.addEventListener('csa-theme', syncTheme);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', syncTheme);

    // data may have arrived before the map existed
    loadData();

    return () => {
      window.removeEventListener('csa-theme', syncTheme);
      mq.removeEventListener('change', syncTheme);
      ro.disconnect();
      map.remove();
      live.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function loadData() {
    const state = live.current;
    if (!state) return;
    const p = propsRef.current;
    const shows: LayerPlace[] = groupPlaces(p.rows).map((x) => ({ ...x, store: false }));
    const stores: LayerPlace[] = p.storeRows ? groupPlaces(p.storeRows).map((x) => ({ ...x, store: true })) : [];
    const places = [...shows, ...stores];
    state.places = places;
    const index = new Supercluster<{ n: number }, { n: number }>({
      radius: 56,
      maxZoom: CLUSTER_MAX_ZOOM,
      minPoints: 3,
      map: (pr) => ({ n: pr.n }),
      reduce: (acc, pr) => {
        acc.n += pr.n;
      },
    });
    index.load(
      places.map((pl, idx) => ({
        type: 'Feature' as const,
        properties: { n: pl.rows.length, idx } as { n: number },
        geometry: { type: 'Point' as const, coordinates: [pl.lon, pl.lat] },
      })),
    );
    state.index = index;
    state.render();
  }

  // data changes: rebuild on the next frame so dragging the time window stays smooth
  const frame = useRef(0);
  useEffect(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(loadData);
    return () => cancelAnimationFrame(frame.current);
  }, [props.rows, props.storeRows]);

  // where the visitor is
  useEffect(() => {
    const state = live.current;
    if (!state) return;
    state.here.clearLayers();
    if (props.origin) {
      L.marker([props.origin.lat, props.origin.lon], {
        icon: L.divIcon({ className: '', html: '<div class="csa-here"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
        interactive: false,
        keyboard: false,
        zIndexOffset: -500,
      }).addTo(state.here);
    }
  }, [props.origin?.lat, props.origin?.lon]);

  // move the view when asked
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const state = live.current;
    if (state) applyView(state.map, propsRef.current.view);
  }, [props.viewKey]);

  return (
    <div class="map-wrap" ref={wrap}>
      <div class={`map-box${props.tall ? ' tall' : ''}`} ref={box} role="application" aria-label={props.label} />
    </div>
  );
}

export default MapCanvas;
