import { describe, expect, it, vi } from 'vitest';
import { TTLCache, searchCacheKey } from '../src/cache.js';

describe('TTLCache', () => {
  it('stores and retrieves values', () => {
    const cache = new TTLCache<string>(1000, 100);
    cache.set('a', 'value-a');
    expect(cache.get('a')).toBe('value-a');
    expect(cache.get('missing')).toBeUndefined();
  });

  it('expires entries after TTL', () => {
    vi.useFakeTimers();
    const cache = new TTLCache<string>(1000, 100);
    cache.set('a', 'value');
    vi.advanceTimersByTime(1100);
    expect(cache.get('a')).toBeUndefined();
    vi.useRealTimers();
  });

  it('evicts LRU entries beyond maxEntries', () => {
    const cache = new TTLCache<number>(10_000, 3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    // Touch 'a' so it is most-recently used.
    cache.get('a');
    cache.set('d', 4);
    expect(cache.get('b')).toBeUndefined(); // LRU evicted
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
    expect(cache.stats().evictions).toBe(1);
  });

  it('coalesces concurrent computations (stampede protection)', async () => {
    const cache = new TTLCache<number>(10_000, 100);
    let computations = 0;
    const compute = async () => {
      computations++;
      await new Promise((r) => setTimeout(r, 30));
      return 42;
    };

    const results = await Promise.all([
      cache.getOrCompute('k', compute),
      cache.getOrCompute('k', compute),
      cache.getOrCompute('k', compute),
      cache.getOrCompute('k', compute),
    ]);

    expect(results).toEqual([42, 42, 42, 42]);
    expect(computations).toBe(1);
    expect(cache.stats().stampedesPrevented).toBe(3);
  });

  it('does not cache failed computations', async () => {
    const cache = new TTLCache<number>(10_000, 100);
    let attempts = 0;
    const failing = async () => {
      attempts++;
      throw new Error('boom');
    };
    await expect(cache.getOrCompute('k', failing)).rejects.toThrow('boom');
    // Cache miss on retry, not a cached rejection.
    await expect(cache.getOrCompute('k', failing)).rejects.toThrow('boom');
    expect(attempts).toBe(2);
  });

  it('serves from cache after first computation', async () => {
    const cache = new TTLCache<string>(10_000, 100);
    let computations = 0;
    const compute = async () => {
      computations++;
      return 'result';
    };
    await cache.getOrCompute('k', compute);
    await cache.getOrCompute('k', compute);
    expect(computations).toBe(1);
    expect(cache.stats().hits).toBe(1);
  });

  it('sweep removes expired entries', () => {
    vi.useFakeTimers();
    const cache = new TTLCache<string>(500, 100);
    cache.set('a', 'x');
    vi.advanceTimersByTime(600);
    expect(cache.sweep()).toBe(1);
    expect(cache.stats().size).toBe(0);
    vi.useRealTimers();
  });

  it('reports hit rate', async () => {
    const cache = new TTLCache<string>(10_000, 100);
    cache.set('k', 'v');
    cache.get('k');
    cache.get('other');
    const stats = cache.stats();
    expect(stats.hitRate).toBeCloseTo(0.5);
  });
});

describe('searchCacheKey', () => {
  it('is order-insensitive for domain lists', () => {
    const a = searchCacheKey({ query: 'q', maxResults: 5, includeDomains: ['a.com', 'b.com'] });
    const b = searchCacheKey({ query: 'q', maxResults: 5, includeDomains: ['B.com', 'A.com'] });
    expect(a).toBe(b);
  });

  it('normalizes query case and whitespace', () => {
    const a = searchCacheKey({ query: '  PostgreSQL MVCC ', maxResults: 5 });
    const b = searchCacheKey({ query: 'postgresql mvcc', maxResults: 5 });
    expect(a).toBe(b);
  });

  it('distinguishes different parameters', () => {
    const a = searchCacheKey({ query: 'q', maxResults: 5, freshness: 'week' });
    const b = searchCacheKey({ query: 'q', maxResults: 5, freshness: 'day' });
    expect(a).not.toBe(b);
  });
});
