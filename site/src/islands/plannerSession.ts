// The route planner runs in a Web Worker (planner/src/worker.ts), off the main thread, so a big
// season plan never freezes the page. This file owns that worker: it loads the planner rows, starts
// the worker, sends the rows once, and can stop it ("Cancel") and start a fresh one.
import { createPlannerClient, PlannerCallError, type PlannerClient } from '../../../planner/src/protocol.ts';
import type { PlannerCalls, RequestType } from '../../../planner/src/protocol.ts';
import type { PlannerCaller } from '../lib/plan-run';
import { plannerShowsFrom, type PlannerFile, type PlannerShow } from '../lib/planner-rows';
import { dataUrl } from '../lib/urls';

let filePromise: Promise<PlannerFile> | null = null;
let rowsPromise: Promise<PlannerShow[]> | null = null;

/** planner.json: fetched once, only by pages that plan or score for a vendor. */
export function loadPlannerFile(): Promise<PlannerFile> {
  if (!filePromise) {
    filePromise = fetch(dataUrl('planner.json'))
      .then((r) => {
        if (!r.ok) throw new Error(`planner.json ${r.status}`);
        return r.json() as Promise<PlannerFile>;
      })
      .catch((err) => {
        filePromise = null;
        throw err;
      });
  }
  return filePromise;
}

export function loadPlannerRows(): Promise<PlannerShow[]> {
  if (!rowsPromise) rowsPromise = loadPlannerFile().then(plannerShowsFrom);
  return rowsPromise;
}

export class PlannerSession implements PlannerCaller {
  private client: PlannerClient | null = null;
  private starting: Promise<PlannerClient> | null = null;
  private rows: PlannerShow[];

  constructor(rows: PlannerShow[]) {
    this.rows = rows;
  }

  private start(): Promise<PlannerClient> {
    if (this.client) return Promise.resolve(this.client);
    if (!this.starting) {
      const worker = new Worker(new URL('../../../planner/src/worker.ts', import.meta.url), { type: 'module' });
      const client = createPlannerClient(worker);
      this.client = client;
      this.starting = client
        .call('setShows', { shows: this.rows })
        .then(() => client)
        .catch((e) => {
          this.discard();
          throw e;
        });
    }
    return this.starting;
  }

  private discard() {
    this.client?.terminate();
    this.client = null;
    this.starting = null;
  }

  async call<K extends RequestType>(type: K, args: PlannerCalls[K]['args']): Promise<PlannerCalls[K]['result']> {
    const client = await this.start();
    return client.call(type, args);
  }

  /** Use different rows (for example with table fees the vendor edited). They are sent to the worker before the next call. */
  async replaceRows(rows: PlannerShow[]): Promise<void> {
    if (rows === this.rows) return;
    this.rows = rows;
    if (this.client) {
      const client = await this.start();
      await client.call('setShows', { shows: rows });
    }
  }

  /** Stop whatever is running: the worker is ended and a new one starts with the next call. */
  cancel(): void {
    this.discard();
  }

  dispose(): void {
    this.discard();
  }
}

export function isStopped(e: unknown): boolean {
  return e instanceof PlannerCallError && e.code === 'terminated';
}

export function plainError(e: unknown): string {
  if (e instanceof PlannerCallError) return e.message;
  if (e instanceof Error && e.message) return 'Something went wrong while planning. Try again.';
  return 'Something went wrong while planning. Try again.';
}

let shared: PlannerSession | null = null;

/** One worker for pages that only score shows (the Find page), so it is started once and reused. */
export function sharedSession(rows: PlannerShow[]): PlannerSession {
  if (!shared) shared = new PlannerSession(rows);
  return shared;
}
