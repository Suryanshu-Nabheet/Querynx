/**
 * Postgres jobs bridge: API-submitted jobs persist to the jobs table
 * where dedicated workers claim them via SKIP LOCKED.
 *
 * Two modes, chosen by configuration:
 *  - inProcess (default): the API's own queue runs the job locally.
 *  - delegated (QUERYNX_DELEGATE_JOBS=1 with DATABASE_URL): the job is
 *    written to Postgres and a fleet worker executes it. The API polls
 *    the same table for status.
 *
 * The bridge keeps one Job-shaped contract across both modes so the
 * /v1/jobs surface is identical for single- and multi-instance
 * deployments.
 */

import { randomUUID } from 'node:crypto';
import type { JobQueue, Job } from '@querynx/queue';

export interface PersistedJobView {
  id: string;
  type: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  priority: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** The delegation contract the API needs from a Postgres job store. */
export interface DelegatingJobStore {
  create(type: string, payload: Record<string, unknown>, priority?: number): Promise<PersistedJobView>;
  get(id: string): Promise<PersistedJobView | null>;
  cancel(id: string): Promise<boolean>;
}

export interface JobBridgeOptions {
  queue: JobQueue;
  store?: DelegatingJobStore;
}

export class JobBridge {
  constructor(private readonly options: JobBridgeOptions) {}

  get delegated(): boolean {
    return this.options.store !== undefined;
  }

  /** Submit a job: delegated to Postgres when configured. */
  async submit(
    type: string,
    payload: Record<string, unknown>,
    priority = 0
  ): Promise<PersistedJobView> {
    const store = this.options.store;
    if (store) {
      return store.create(type, payload, priority);
    }
    const job = this.options.queue.enqueue(type, payload, { priority });
    return this.toView(job);
  }

  /** Poll a job's status across both modes. */
  async get(id: string): Promise<PersistedJobView | null> {
    const store = this.options.store;
    if (store) {
      return store.get(id);
    }
    const job = this.options.queue.get(id);
    return job ? this.toView(job) : null;
  }

  /** Cancel: delegated jobs cancel in Postgres; local jobs abort. */
  async cancel(id: string): Promise<boolean> {
    const store = this.options.store;
    if (store) {
      return store.cancel(id);
    }
    return this.options.queue.cancel(id);
  }

  /** Queue stats (local mode only; delegated mode reads from /v1/jobs). */
  stats(): ReturnType<JobQueue['stats']> | null {
    if (this.options.store) return null;
    return this.options.queue.stats();
  }

  private toView(job: Job): PersistedJobView {
    const result = (job as Job & { result?: Record<string, unknown> }).result;
    return {
      id: job.id,
      type: job.type,
      status: job.status === 'dead' ? 'failed' : (job.status as PersistedJobView['status']),
      priority: job.priority,
      payload: job.payload,
      result: result ?? null,
      error: job.error,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    };
  }
}

/**
 * Adapter over the database package's JobStore presenting exactly the
 * DelegatingJobStore surface (uuid strings, view shapes).
 */
export function makeDelegatingStore(
  jobStore: {
    create(type: string, payload: Record<string, unknown>, priority?: number): Promise<{ id: string }>;
    get(id: string): Promise<unknown | null>;
    cancel(id: string): Promise<boolean>;
  }
): DelegatingJobStore {
  return {
    create: async (type, payload, priority) => {
      const record = await jobStore.create(type, payload, priority);
      const view = (await jobStore.get(record.id)) as PersistedJobView | null;
      return view ?? {
        id: record.id,
        type,
        status: 'pending' as const,
        priority: priority ?? 0,
        payload,
        result: null,
        error: null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
      };
    },
    get: async (id) => {
      const record = (await jobStore.get(id)) as PersistedJobView | null;
      return record;
    },
    cancel: (id) => jobStore.cancel(id),
  };
}

/** Stable id for bridge-created records (unused today; reserved for
 * idempotency keys in submit requests). */
export function bridgeId(): string {
  return randomUUID();
}
