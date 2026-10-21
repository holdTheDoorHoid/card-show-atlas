// Loads the map code only when a map is actually shown, so pages that never open the map stay light.
import { useEffect, useState } from 'preact/hooks';
import type { MapCanvasProps } from './MapCanvas';

type Loaded = typeof import('./MapCanvas');

export function LazyMap(props: MapCanvasProps) {
  const [mod, setMod] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    import('./MapCanvas').then(
      (m) => alive && setMod(m),
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, []);
  if (failed) {
    return (
      <div class="notice notice-warn" role="alert">
        The map could not be loaded. Check your connection and reload the page. The list below still works.
      </div>
    );
  }
  if (!mod) {
    return (
      <div class="map-wrap">
        <div class={`map-box${props.tall ? ' tall' : ''}`} aria-busy="true">
          <p class="loading" style={{ padding: '1rem' }}>Loading the map...</p>
        </div>
      </div>
    );
  }
  const Map = mod.MapCanvas;
  return <Map {...props} />;
}
