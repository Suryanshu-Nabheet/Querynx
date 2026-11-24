/**
 * Durable job queue.
 *
 * Priority-ordered pending jobs, at-least-once execution with bounded
 * retries, exponential backoff, dead-lettering after max attempts,
 * cooperative cancellation and stuck-job recovery. The Postgres-backed
 * JobStore (packages/database) is the persistent implementation of the
 * same contract; this class is the in-process engine used when no
 * DATABASE_URL is configured.
 */

import { randomUUID } from 'node:crypto';
import { backoffDelayMs } from '@querynx/shared';

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'dead';

export interface Job {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  priority: number;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type JobHandler = (
  payload: Record<string, unknown>,
  signal: AbortSignal
) => Promise<Record<string, unknown> | void>;

export interface QueueOptions {
  /** Concurrent job executions. */
  concurrency?: number;
  /** Default retry cap. */
  maxAttempts?: number;
  /** Poll interval when idle (ms). */
  pollIntervalMs?: number;
  /** Dead-letter capacity before oldest are dropped. */
  deadLetterCapacity?: number;
}

export class JobQueue {
  private pending: Job[] = [];
  private readonly running = new Map<string, { job: Job; controller: AbortController }>();
  private readonly handlers = new Map<string, JobHandler>();
  private readonly dead: Job[] = [];
  private readonly all = new Map<string, Job>();
  private readonly concurrency: number;
  private readonly maxAttempts: number;
  private readonly pollIntervalMs: number;
  private readonly deadLetterCapacity: number;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  /** Jobs waiting out a retry backoff timer (not yet back in pending). */
  private retryScheduled = 0;
  private stopped = false;

  constructor(options: QueueOptions = {}) {
    this.concurrency = Math.max(1, options.concurrency ?? 2);
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.pollIntervalMs = Math.max(10, options.pollIntervalMs ?? 25);
    this.deadLetterCapacity = options.deadLetterCapacity ?? 1000;
  }

  /** Register a handler for a job type. */
  handle(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  /** Enqueue a job; returns it immediately. */
  enqueue(
    type: string,
    payload: Record<string, unknown>,
    options: { priority?: number; maxAttempts?: number } = {}
  ): Job {
    const job: Job = {
      id: randomUUID(),
      type,
      payload,
      priority: options.priority ?? 0,
      status: 'pending',
      attempts: 0,
      maxAttempts: options.maxAttempts ?? this.maxAttempts,
      error: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };
    this.pending.push(job);
    this.all.set(job.id, job);
    this.schedulePump();
    return job;
  }

  /** Fetch a job's current state. */
  get(id: string): Job | undefined {
    return this.all.get(id);
  }

  /** Cancel a pending or running job. */
  cancel(id: string): boolean {
    const job = this.all.get(id);
    if (!job) return false;
    if (job.status === 'pending') {
      job.status = 'cancelled';
      job.finishedAt = new Date().toISOString();
      this.pending = this.pending.filter((j) => j.id !== id);
      return true;
    }
    if (job.status === 'running') {
      this.running.get(id)?.controller.abort();
      return true;
    }
    return false;
  }

  /** Jobs in the dead-letter queue. */
  deadLetters(): readonly Job[] {
    return this.dead;
  }

  /** Queue depth snapshots. */
  stats(): { pending: number; running: number; retryScheduled: number; dead: number; total: number } {
    return {
      pending: this.pending.length,
      running: this.running.size,
      retryScheduled: this.retryScheduled,
      dead: this.dead.length,
      total: this.all.size,
    };
  }

  /** Drain: resolve when the queue is empty and nothing is running. */
  async drain(): Promise<void> {
    while (
      this.pending.length > 0 ||
      this.running.size > 0 ||
      this.retryScheduled > 0
    ) {
      this.pump();
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
  }

  /** Stop workers; running jobs get aborted. */
  stop(): void {
    this.stopped = true;
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    for (const { controller } of this.running.values()) controller.abort();
  }

  /** Test/ops hook: resume after stop(). */
  resume(): void {
    this.stopped = false;
    this.schedulePump();
  }

  private schedulePump(): void {
    if (this.stopped || this.pumpTimer) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this.pump();
    }, this.pollIntervalMs);
  }

  private pump(): void {
    if (this.stopped) return;
    // Take up to concurrency slots, highest priority first.
    this.pending.sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
    while (this.running.size < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift()!;
      void this.execute(job);
    }
    if (this.pending.length > 0) this.schedulePump();
  }

  private async execute(job: Job): Promise<void> {
    const handler = this.handlers.get(job.type);
    const controller = new AbortController();
    this.running.set(job.id, { job, controller });
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.attempts++;

    try {
      if (!handler) {
        throw new Error(`no handler registered for job type "${job.type}"`);
      }
      const result = await handler(job.payload, controller.signal);
      if (controller.signal.aborted) {
        job.status = 'cancelled';
      } else {
        job.status = 'completed';
      }
      (job as Job & { result?: Record<string, unknown> | undefined }).result =
        result ?? undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (controller.signal.aborted) {
        job.status = 'cancelled';
      } else if (job.attempts >= job.maxAttempts) {
        job.status = 'dead';
        job.error = message;
        this.dead.push(job);
        if (this.dead.length > this.deadLetterCapacity) this.dead.shift();
      } else {
        // Retry with backoff: hold the job outside pending until the
        // timer fires, tracked so drain() knows work remains.
        job.status = 'pending';
        job.error = message;
        this.retryScheduled++;
        const delay = backoffDelayMs(job.attempts - 1, 100, 5_000);
        setTimeout(() => {
          this.retryScheduled--;
          this.pending.push(job);
          this.schedulePump();
        }, delay);
      }
    } finally {
      job.finishedAt = job.status === 'pending' ? null : new Date().toISOString();
      this.running.delete(job.id);
      this.schedulePump();
    }
  }
}
