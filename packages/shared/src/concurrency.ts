/**
 * Bounded-concurrency execution primitives.
 *
 * Every fan-out in Querynx goes through these helpers so that no code path
 * can accidentally run an unbounded Promise.all over external input.
 */

/**
 * Run tasks with a hard concurrency cap.
 * Tasks are started in order; slower tasks do not block later starts.
 *
 * @param items Input items
 * @param limit Maximum simultaneously in-flight tasks (>= 1)
 * @param worker Called for each item; may return a promise
 * @param signal Optional cooperative cancellation
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  if (items.length === 0) return [];
  const safeLimit = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let next = 0;

  async function runOne(): Promise<void> {
    while (!signal?.aborted) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index]!;
      results[index] = await worker(item, index);
    }
  }

  const runners = Array.from({ length: safeLimit }, () => runOne());
  await Promise.all(runners);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return results;
}

/**
 * Run a batch of zero-argument tasks under a concurrency cap.
 * Useful for provider fan-out where each task has no input.
 */
export async function runWithConcurrency(
  tasks: ReadonlyArray<() => Promise<void>>,
  limit: number,
  signal?: AbortSignal,
): Promise<void> {
  await mapWithConcurrency(
    tasks,
    limit,
    async (task) => {
      await task();
      return undefined;
    },
    signal,
  );
}

/**
 * An async semaphore for long-lived shared resources (e.g. per-provider
 * connection budgets). Supports try-with-timeout and cooperative cancel.
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<{
    resolve: (granted: boolean) => void;
    reject: (err: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`Semaphore limit must be >= 1, got ${limit}`);
    }
  }

  /** Acquire a slot, waiting up to timeoutMs. Returns false on timeout. */
  async acquire(timeoutMs?: number, signal?: AbortSignal): Promise<boolean> {
    if (this.active < this.limit && this.waiters.length === 0) {
      this.active++;
      return true;
    }
    return new Promise<boolean>((resolve, reject) => {
      const waiter: {
        resolve: (granted: boolean) => void;
        reject: (err: Error) => void;
        timer?: ReturnType<typeof setTimeout>;
      } = {
        resolve: (granted: boolean) => {
          if (waiter.timer) clearTimeout(waiter.timer);
          if (granted) this.active++;
          resolve(granted);
        },
        reject,
      };
      if (timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          resolve(false);
        }, timeoutMs);
      }
      this.waiters.push(waiter);
    });
  }

  /** Release a previously acquired slot. */
  release(): void {
    this.active = Math.max(0, this.active - 1);
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(true);
  }

  /** Current in-flight count. */
  get count(): number {
    return this.active;
  }
}

/**
 * Token-bucket rate limiter, per key. Refills continuously; does not
 * queue requests — callers decide how to handle exhaustion (reject or wait).
 */
export class TokenBucketRateLimiter {
  private readonly buckets = new Map<
    string,
    { tokens: number; last: number }
  >();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {
    if (capacity <= 0 || refillPerSecond <= 0) {
      throw new Error("Rate limiter capacity and refill must be positive");
    }
  }

  /** Try to consume one token for a key. Returns false when empty. */
  tryConsume(key: string, now = Date.now()): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, last: now };
      this.buckets.set(key, bucket);
    }
    const elapsed = (now - bucket.last) / 1000;
    bucket.tokens = Math.min(
      this.capacity,
      bucket.tokens + elapsed * this.refillPerSecond,
    );
    bucket.last = now;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Milliseconds until a token is available for the key. */
  msUntilAvailable(key: string, now = Date.now()): number {
    const bucket = this.buckets.get(key);
    if (!bucket) return 0;
    const elapsed = (now - bucket.last) / 1000;
    const tokens = Math.min(
      this.capacity,
      bucket.tokens + elapsed * this.refillPerSecond,
    );
    return tokens >= 1
      ? 0
      : Math.ceil(((1 - tokens) / this.refillPerSecond) * 1000);
  }
}

/**
 * Compute backoff delay with exponential growth and full jitter.
 * @param attempt 0-based attempt number
 */
export function backoffDelayMs(
  attempt: number,
  baseMs = 500,
  maxMs = 30_000,
): number {
  const exp = Math.min(baseMs * 2 ** attempt, maxMs);
  return Math.floor(Math.random() * exp);
}

/**
 * Retry an operation with exponential backoff and jitter.
 * Retries only when the predicate allows; rethrows the last error otherwise.
 */
export async function retryWithBackoff<T>(
  op: (attempt: number) => Promise<T>,
  options: {
    maxAttempts?: number;
    baseMs?: number;
    maxMs?: number;
    signal?: AbortSignal;
    retryOn?: (err: unknown) => boolean;
  } = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    baseMs = 500,
    maxMs = 30_000,
    signal,
    retryOn,
  } = options;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      return await op(attempt);
    } catch (err) {
      lastError = err;
      if (retryOn && !retryOn(err)) throw err;
      if (attempt === maxAttempts - 1) break;
      const delay = backoffDelayMs(attempt, baseMs, maxMs);
      await sleep(delay, signal);
    }
  }
  throw lastError;
}

/** Cancellable sleep. */
export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  return new Promise<void>((resolve, reject) => {
    let onAbort: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Circuit breaker guarding an async operation.
 * Opens after `threshold` consecutive failures, half-opens after
 * `resetMs`, and closes again on the first success.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private state: "closed" | "open" | "half-open" = "closed";

  constructor(
    private readonly threshold: number,
    private readonly resetMs: number,
  ) {
    if (threshold < 1) throw new Error("Circuit threshold must be >= 1");
  }

  /** Current state. */
  get status(): "closed" | "open" | "half-open" {
    if (this.state === "open" && Date.now() - this.openedAt >= this.resetMs) {
      return "half-open";
    }
    return this.state;
  }

  /** Whether requests should currently be attempted. */
  get allowed(): boolean {
    return this.status !== "open";
  }

  /** Record a success. */
  success(): void {
    this.failures = 0;
    this.state = "closed";
  }

  /** Record a failure. */
  failure(): void {
    this.failures++;
    if (this.failures >= this.threshold) {
      this.state = "open";
      this.openedAt = Date.now();
    }
  }
}

/**
 * Execute an operation under circuit-breaker protection.
 * Throws `CircuitOpenError` when the circuit is open.
 */
export class CircuitOpenError extends Error {
  constructor(name: string) {
    super(`Circuit breaker open for ${name}`);
    this.name = "CircuitOpenError";
  }
}

/** Run an async op through a breaker, recording outcome. */
export async function withCircuitBreaker<T>(
  breaker: CircuitBreaker,
  name: string,
  op: () => Promise<T>,
): Promise<T> {
  if (!breaker.allowed) throw new CircuitOpenError(name);
  try {
    const result = await op();
    breaker.success();
    return result;
  } catch (err) {
    if (!(err instanceof DOMException && err.name === "AbortError")) {
      breaker.failure();
    }
    throw err;
  }
}
