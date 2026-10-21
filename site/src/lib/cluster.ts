// Marker clustering for the map. Places are binned into a grid of screen sized cells at the current
// zoom level, so one pass over the places is all it takes: about a millisecond for 10,000 places.
// That keeps the map smooth while the time window is dragged and the set of markers changes every
// frame. (Indexes that are built once per data set, such as supercluster's, cost 100 to 800 ms to
// rebuild at this size, far too slow to redo for every pointer move.)
//
// Cells are fixed in world pixel space for each zoom level, so panning never changes which places
// are grouped together.

export interface PlacePoint {
  lat: number;
  lon: number;
  /** how many shows are at this place */
  count: number;
}

export type ClusterItem =
  | { kind: 'place'; index: number }
  | {
      kind: 'cluster';
      lat: number;
      lon: number;
      /** shows in the cluster */
      count: number;
      /** indexes of the places in the cluster */
      indexes: number[];
      /** [[south, west], [north, east]] */
      bounds: [[number, number], [number, number]];
    };

export interface ClusterOptions {
  /** cell size in screen pixels */
  cellPx?: number;
  /** a cell with fewer places than this is shown as separate markers */
  minPlaces?: number;
  /** at this zoom and closer, nothing is clustered */
  noClusterFromZoom?: number;
}

const TILE = 256;

/** Web Mercator world pixel position at a zoom level. */
export function worldPixel(lat: number, lon: number, zoom: number): { x: number; y: number } {
  const scale = TILE * 2 ** zoom;
  const clamped = Math.max(-85.0511, Math.min(85.0511, lat));
  const sin = Math.sin((clamped * Math.PI) / 180);
  return {
    x: ((lon + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  };
}

export function clusterPoints(points: readonly PlacePoint[], zoom: number, opts: ClusterOptions = {}): ClusterItem[] {
  const cell = opts.cellPx ?? 60;
  const minPlaces = opts.minPlaces ?? 2;
  const z = Math.round(zoom);
  if (z >= (opts.noClusterFromZoom ?? 18)) return points.map((_, index) => ({ kind: 'place', index }));

  const cells = new Map<number, number[]>();
  const stride = Math.ceil((TILE * 2 ** z) / cell) + 2;
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as PlacePoint;
    const { x, y } = worldPixel(p.lat, p.lon, z);
    const key = Math.floor(x / cell) * stride + Math.floor(y / cell);
    const list = cells.get(key);
    if (list) list.push(i);
    else cells.set(key, [i]);
  }

  const out: ClusterItem[] = [];
  for (const indexes of cells.values()) {
    if (indexes.length < minPlaces) {
      for (const index of indexes) out.push({ kind: 'place', index });
      continue;
    }
    let count = 0;
    let lat = 0;
    let lon = 0;
    let s = 90;
    let n = -90;
    let w = 180;
    let e = -180;
    for (const i of indexes) {
      const p = points[i] as PlacePoint;
      count += p.count;
      lat += p.lat;
      lon += p.lon;
      s = Math.min(s, p.lat);
      n = Math.max(n, p.lat);
      w = Math.min(w, p.lon);
      e = Math.max(e, p.lon);
    }
    out.push({ kind: 'cluster', lat: lat / indexes.length, lon: lon / indexes.length, count, indexes, bounds: [[s, w], [n, e]] });
  }
  return out;
}

/** Keep only the items inside a padded view: [south, west, north, east], padded by a fraction of its size. */
export function itemsInView(
  items: readonly ClusterItem[],
  points: readonly PlacePoint[],
  view: { south: number; west: number; north: number; east: number },
  pad = 0.15,
): ClusterItem[] {
  const dLat = (view.north - view.south) * pad;
  const dLon = (view.east - view.west) * pad;
  const s = view.south - dLat;
  const n = view.north + dLat;
  const w = view.west - dLon;
  const e = view.east + dLon;
  return items.filter((it) => {
    const lat = it.kind === 'place' ? (points[it.index] as PlacePoint).lat : it.lat;
    const lon = it.kind === 'place' ? (points[it.index] as PlacePoint).lon : it.lon;
    return lat >= s && lat <= n && lon >= w && lon <= e;
  });
}
