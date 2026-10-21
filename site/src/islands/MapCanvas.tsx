// The Leaflet map: OpenStreetMap tiles, clustered markers (grid clustering, see lib/cluster.ts, copes with 10,000+ points),
// marker shape and colour by event type, softer markers for approximate places.
// This file is loaded on demand (see LazyMap.tsx) so Leaflet stays out of pages that never show a map.
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'preact/hooks';
import { DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM, TILE_ATTRIBUTION, TILE_MAX_ZOOM, TILE_URL } from '../lib/config';
import { markerSvg } from '../lib/labels';
import { clusterPoints, itemsInView, type ClusterItem, type PlacePoint } from '../lib/cluster';
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
    places: LayerPlace[];
    points: PlacePoint[];
    items: ClusterItem[];
    itemsZoom: number;
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

    const state = { map, markers, here, places: [] as LayerPlace[], points: [] as PlacePoint[], items: [] as ClusterItem[], itemsZoom: -1, render: () => {} };
    live.current = state;

    // Markers are reused from one render to the next, so dragging the time window only adds and
    // removes the markers that really changed instead of rebuilding them all.
    interface Slot {
      marker: L.Marker;
      iconKey: string;
      /** the current place or cluster: read by the click handlers, so a reused marker stays correct */
      ref: { place?: LayerPlace; cluster?: Extract<ClusterItem, { kind: 'cluster' }> };
    }
    const slots = new Map<string, Slot>();

    const render = () => {
      if (state.places.length === 0) {
        markers.clearLayers();
        slots.clear();
        return;
      }
      const zoom = Math.round(map.getZoom());
      if (state.itemsZoom !== zoom) {
        state.items = clusterPoints(state.points, zoom);
        state.itemsZoom = zoom;
      }
      const b = map.getBounds();
      const visible = itemsInView(state.items, state.points, { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() });
      const keep = new Set<string>();
      for (const item of visible) {
        if (item.kind === 'cluster') {
          const key = `c${item.lat.toFixed(4)},${item.lon.toFixed(4)}`;
          keep.add(key);
          const iconKey = `c${item.count}`;
          const slot = slots.get(key);
          if (slot) {
            slot.ref.cluster = item;
            if (slot.iconKey !== iconKey) {
              slot.marker.setIcon(clusterIcon(item.count));
              slot.iconKey = iconKey;
            }
            continue;
          }
          const ref: Slot['ref'] = { cluster: item };
          const m = L.marker([item.lat, item.lon], { icon: clusterIcon(item.count), keyboard: true, title: `${item.count} shows. Zoom in.`, alt: `${item.count} shows, zoom in` });
          m.on('click', () => {
            const c = ref.cluster;
            if (!c) return;
            const [[s, w], [n, e]] = c.bounds;
            if (s === n && w === e) map.setView([c.lat, c.lon], Math.min(map.getZoom() + 2, TILE_MAX_ZOOM - 1));
            else map.fitBounds([[s, w], [n, e]], { padding: [48, 48], maxZoom: TILE_MAX_ZOOM - 1 });
          });
          m.addTo(markers);
          slots.set(key, { marker: m, iconKey, ref });
        } else {
          const place = state.places[item.index];
          if (!place) continue;
          const key = `p${place.key}`;
          keep.add(key);
          const iconKey = `${place.type}|${place.soft}|${Math.min(place.rows.length, 99)}`;
          const slot = slots.get(key);
          if (slot) {
            slot.ref.place = place;
            if (slot.iconKey !== iconKey) {
              slot.marker.setIcon(pinIcon(place));
              slot.iconKey = iconKey;
            }
            slot.marker.options.title = placeLabel(place);
            continue;
          }
          const ref: Slot['ref'] = { place };
          const m = L.marker([place.lat, place.lon], { icon: pinIcon(place), keyboard: true, title: placeLabel(place), alt: placeLabel(place), riseOnHover: true });
          // The card is built only when it is opened.
          m.bindPopup(
            () => {
              const p = ref.place;
              return p ? popupHtml(p, { showHref: (id) => withBase(showPath(id)), isStoreLayer: p.store, refYear: new Date().getFullYear() }) : '';
            },
            { maxWidth: 290, autoPanPadding: [30, 30] },
          );
          m.addTo(markers);
          slots.set(key, { marker: m, iconKey, ref });
        }
      }
      for (const [key, slot] of slots) {
        if (!keep.has(key)) {
          markers.removeLayer(slot.marker);
          slots.delete(key);
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
    state.points = places.map((pl) => ({ lat: pl.lat, lon: pl.lon, count: pl.rows.length }));
    state.itemsZoom = -1;
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
