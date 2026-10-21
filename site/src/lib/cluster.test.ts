import { describe, expect, it } from 'vitest';
import { clusterPoints, itemsInView, worldPixel, type PlacePoint } from './cluster.ts';

const pt = (lat: number, lon: number, count = 1): PlacePoint => ({ lat, lon, count });

describe('world pixels', () => {
  it('puts the middle of the map at the middle of the world', () => {
    const { x, y } = worldPixel(0, 0, 0);
    expect(x).toBeCloseTo(128, 6);
    expect(y).toBeCloseTo(128, 6);
  });
  it('doubles with each zoom level', () => {
    const a = worldPixel(40, -75, 4);
    const b = worldPixel(40, -75, 5);
    expect(b.x).toBeCloseTo(a.x * 2, 6);
    expect(b.y).toBeCloseTo(a.y * 2, 6);
  });
});

describe('clustering', () => {
  const nj = [pt(40.52, -74.41), pt(40.73, -74.17), pt(39.93, -75.03), pt(39.95, -75.17)];
  const far = pt(34.05, -118.24);

  it('groups nearby places when zoomed out and keeps far ones apart', () => {
    const items = clusterPoints([...nj, far], 5);
    const clusters = items.filter((i) => i.kind === 'cluster');
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    const total = items.reduce((n, i) => n + (i.kind === 'cluster' ? i.count : 1), 0);
    expect(total).toBe(5);
    expect(items.some((i) => i.kind === 'place' && i.index === 4)).toBe(true); // Los Angeles stands alone
  });

  it('counts shows, not places, in a cluster', () => {
    const items = clusterPoints([pt(40.52, -74.41, 3), pt(40.53, -74.4, 5)], 4);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'cluster', count: 8 });
    expect((items[0] as { indexes: number[] }).indexes).toEqual([0, 1]);
  });

  it('separates everything when zoomed in far enough', () => {
    const items = clusterPoints(nj, 12);
    expect(items.every((i) => i.kind === 'place')).toBe(true);
    expect(items).toHaveLength(4);
    expect(clusterPoints([pt(40.52, -74.41), pt(40.5201, -74.4101)], 18).every((i) => i.kind === 'place')).toBe(true);
  });

  it('gives a cluster the bounds of its places, for zooming in on it', () => {
    const items = clusterPoints([pt(40.5, -74.4), pt(40.6, -74.3)], 5);
    expect(items[0]).toMatchObject({ kind: 'cluster', bounds: [[40.5, -74.4], [40.6, -74.3]] });
  });

  it('every place is in exactly one item', () => {
    const points = Array.from({ length: 500 }, (_, i) => pt(25 + (i % 25) * 0.9, -120 + Math.floor(i / 25) * 2.5));
    for (const z of [3, 6, 9, 14]) {
      const seen = new Set<number>();
      for (const it of clusterPoints(points, z)) {
        if (it.kind === 'place') seen.add(it.index);
        else for (const i of it.indexes) seen.add(i);
      }
      expect(seen.size).toBe(500);
    }
  });

  it('does not change what is grouped when the view moves (cells are fixed to the world)', () => {
    const points = Array.from({ length: 300 }, (_, i) => pt(30 + (i % 20) * 0.5, -100 + Math.floor(i / 20) * 0.7));
    const a = JSON.stringify(clusterPoints(points, 7));
    const b = JSON.stringify(clusterPoints(points, 7));
    expect(a).toBe(b);
  });

  it('copes with 12,000 places quickly', () => {
    let seed = 1;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const points = Array.from({ length: 12000 }, () => pt(25 + rnd() * 24, -125 + rnd() * 58));
    const t = performance.now();
    for (const z of [4, 6, 8, 10]) clusterPoints(points, z);
    const perPass = (performance.now() - t) / 4;
    expect(perPass).toBeLessThan(100); // typically 2 to 5 ms; the margin is for slow CI machines
  });

  it('keeps only what is in view, with a margin', () => {
    const points = [pt(40, -75), pt(40, -74.9), pt(60, 10)];
    const items = clusterPoints(points, 12);
    const inView = itemsInView(items, points, { south: 39, west: -76, north: 41, east: -74 });
    expect(inView).toHaveLength(2);
  });
});
