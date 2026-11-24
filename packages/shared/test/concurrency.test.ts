import { describe, expect, it, vi } from 'vitest';
import {
  CircuitBreaker,
  CircuitOpenError,
  Semaphore,
  TokenBucketRateLimiter,
  backoffDelayMs,
  mapWithConcurrency,
  retryWithBackoff,
} from '../src/concurrency.js';

describe('mapWithConcurrency', () => {
  it('never exceeds the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 50 }, (_, i) => i);
    await mapWithConcurrency(items, 5, async (i) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return i * 2;
    });
    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBeGreaterThan(1);
  });

  it('preserves order of results', async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await mapWithConcurrency(items, 2, async (i) => {
      await new Promise((r) => setTimeout(r, (6 - i) * 5));
      return i * 10;
    });
    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  it('handles empty input', async () => {
    expect(await mapWithConcurrency([], 3, async (x) => x)).toEqual([]);
  });

  it('propagates errors and stops starting new work', async () => {
    const started: number[] = [];
    let next = 0;
    await expect(
      mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async () => {
        const i = next++;
        started.push(i);
        await new Promise((r) => setTimeout(r, 10));
        throw new Error(`boom ${i}`);
      })
    ).rejects.toThrow(/boom/);
  });

  it('supports cancellation', async () => {
    const controller = new AbortController();
    const items = Array.from({ length: 20 }, (_, i) => i);
    const promise = mapWithConcurrency(
      items,
      2,
      async (i) => {
        await new Promise((r) => setTimeout(r, 20));
        return i;
      },
      controller.signal
    );
    setTimeout(() => controller.abort(), 30);
    await expect(promise).rejects.toThrow();
  });
});

describe('Semaphore', () => {
  it('serializes when limit is 1', async () => {
    const sem = new Semaphore(1);
    const order: string[] = [];
    const task = async (name: string) => {
      const ok = await sem.acquire();
      if (!ok) throw new Error('unexpected timeout');
      order.push(`start:${name}`);
      await new Promise((r) => setTimeout(r, 10));
      order.push(`end:${name}`);
      sem.release();
    };
    await Promise.all([task('a'), task('b'), task('c')]);
    expect(order).toEqual([
      'start:a', 'end:a',
      'start:b', 'end:b',
      'start:c', 'end:c',
    ]);
  });

  it('times out when capacity is exhausted', async () => {
    const sem = new Semaphore(1);
    expect(await sem.acquire()).toBe(true);
    expect(await sem.acquire(50)).toBe(false);
    sem.release();
    expect(await sem.acquire(50)).toBe(true);
  });
});

describe('TokenBucketRateLimiter', () => {
  it('limits bursts and refills over time', () => {
    const rl = new TokenBucketRateLimiter(3, 1);
    expect(rl.tryConsume('k')).toBe(true);
    expect(rl.tryConsume('k')).toBe(true);
    expect(rl.tryConsume('k')).toBe(true);
    expect(rl.tryConsume('k')).toBe(false);
    // Advance time by 1.2s worth of refill.
    const later = Date.now() + 1200;
    expect(rl.tryConsume('k', later)).toBe(true);
  });

  it('tracks keys independently', () => {
    const rl = new TokenBucketRateLimiter(1, 1);
    expect(rl.tryConsume('a')).toBe(true);
    expect(rl.tryConsume('a')).toBe(false);
    expect(rl.tryConsume('b')).toBe(true);
  });
});

describe('CircuitBreaker', () => {
  it('opens after threshold failures and half-opens after reset', () => {
    vi.useFakeTimers();
    const breaker = new CircuitBreaker(3, 1000);
    breaker.failure();
    breaker.failure();
    expect(breaker.allowed).toBe(true);
    breaker.failure();
    expect(breaker.allowed).toBe(false);
    expect(breaker.status).toBe('open');
    vi.advanceTimersByTime(1500);
    expect(breaker.status).toBe('half-open');
    breaker.success();
    expect(breaker.status).toBe('closed');
    vi.useRealTimers();
  });

  it('withCircuitBreaker throws CircuitOpenError when open', async () => {
    const breaker = new CircuitBreaker(1, 10_000);
    breaker.failure();
    await expect(
      (async () => {
        if (!breaker.allowed) throw new CircuitOpenError('test');
        return 1;
      })()
    ).rejects.toThrow(CircuitOpenError);
  });
});

describe('retryWithBackoff', () => {
  it('retries until success', async () => {
    let attempts = 0;
    const result = await retryWithBackoff(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error('transient');
        return 'ok';
      },
      { maxAttempts: 5, baseMs: 1 }
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('gives up after maxAttempts', async () => {
    let attempts = 0;
    await expect(
      retryWithBackoff(
        async () => {
          attempts++;
          throw new Error('always fails');
        },
        { maxAttempts: 3, baseMs: 1 }
      )
    ).rejects.toThrow('always fails');
    expect(attempts).toBe(3);
  });

  it('respects retryOn predicate', async () => {
    let attempts = 0;
    await expect(
      retryWithBackoff(
        async () => {
          attempts++;
          throw new Error('fatal');
        },
        { maxAttempts: 5, baseMs: 1, retryOn: () => false }
      )
    ).rejects.toThrow('fatal');
    expect(attempts).toBe(1);
  });
});

describe('backoffDelayMs', () => {
  it('stays within exponential bounds', () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const delay = backoffDelayMs(attempt, 100, 5000);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(5000);
    }
  });
});
