/**
 * Web Worker entry. Load it with
 *
 *   new Worker(new URL('@card-show-atlas/planner/worker', import.meta.url), { type: 'module' })
 *
 * and talk to it with `createPlannerClient` from the main entry. Nothing here touches the
 * network except a "check real drive times" request, which makes one request to the routing
 * service through the worker's own `fetch`.
 */
import type { FetchLike } from './osrm.js';
import { createWorkerState, handlePlannerRequest } from './protocol.js';
import { isValidTimeZone } from './time.js';

interface WorkerScope {
  onmessage: ((ev: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
  fetch?: FetchLike;
}

const scope = globalThis as unknown as WorkerScope;
const state = createWorkerState();

// Load the time zone data now, while the page is still busy, rather than on the first plan.
isValidTimeZone('America/New_York');

scope.onmessage = (ev) => {
  const fetchFn: FetchLike | undefined = typeof scope.fetch === 'function' ? (url, init) => scope.fetch!(url, init) : undefined;
  void handlePlannerRequest(ev.data, state, { fetch: fetchFn }).then((res) => scope.postMessage(res));
};
