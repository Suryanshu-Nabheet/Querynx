/**
 * TTL cache with stampede protection.
 *
 * Identical concurrent lookups share one in-flight computation instead of
 * hammering upstream providers ("request coalescing"). Entries expire by
 * TTL and the whole map is bounded by an LRU policy — an unbounded cache
 * is a memory leak.
 */

export interface CacheEntry<V> {
  value: V;
  expiresAt: number;
  /** Last-access time for LRU eviction. */
  lastAccessedAt: number;
}

export interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  stampedesPrevented: number;
  evictions: number;
  /** hits / (hits + misses), 0 when empty. */
  hitRate: number;
}

/** Compute the stable cache key for a variable-length argument list. */
function keyFrom(parts: ReadonlyArray<string>): string {
  return parts.join("\u0000");
}

export class TTLCache<V> {
  private readonly store = new Map<string, CacheEntry<V>>();
  private readonly inflight = new Map<string, Promise<V>>();
  private hits = 0;
  private misses = 0;
  private stampedesPrevented = 0;
  private evictions = 0;

  constructor(
    private readonly defaultTtlMs: number,
    private readonly maxEntries: number,
  ) {
    if (defaultTtlMs <= 0) throw new Error("TTL must be positive");
    if (maxEntries < 1) throw new Error("maxEntries must be >= 1");
  }

  /** Look up a key. Returns undefined on miss or expiry. */
  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      this.misses++;
      return undefined;
    }
    // Refresh recency: delete + reinsert moves the key to the end of the
    // Map's insertion order, making the oldest entry the true LRU victim.
    this.store.delete(key);
    entry.lastAccessedAt = Date.now();
    this.store.set(key, entry);
    this.hits++;
    return entry.value;
  }

  /** Insert or replace a value with an explicit TTL. */
  set(key: string, value: V, ttlMs?: number): void {
    const expiresAt = Date.now() + (ttlMs ?? this.defaultTtlMs);
    if (this.store.has(key)) {
      this.store.delete(key); // refresh insertion order for LRU
    }
    this.store.set(key, { value, expiresAt, lastAccessedAt: Date.now() });
    this.evictIfNeeded();
  }

  /**
   * Get-or-compute with stampede protection: concurrent callers for the
   * same key await the same in-flight promise. Errors are not cached;
   * every caller sees the failure and a retry recomputes.
   */
  async getOrCompute(
    key: string,
    compute: () => Promise<V>,
    ttlMs?: number,
  ): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const existing = this.inflight.get(key);
    if (existing) {
      this.stampedesPrevented++;
      return existing;
    }

    const promise = compute()
      .then((value) => {
        this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, promise);
    return promise;
  }

  /** Remove a key explicitly (e.g. after data invalidation). */
  delete(key: string): void {
    this.store.delete(key);
  }

  /** Clear everything. */
  clear(): void {
    this.store.clear();
    this.inflight.clear();
  }

  /** Live statistics snapshot. */
  stats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      size: this.store.size,
      hits: this.hits,
      misses: this.misses,
      stampedesPrevented: this.stampedesPrevented,
      evictions: this.evictions,
      hitRate: total === 0 ? 0 : this.hits / total,
    };
  }

  /** Drop expired entries; cheap enough to call periodically. */
  sweep(): number {
    let removed = 0;
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= now) {
        this.store.delete(key);
        removed++;
      }
    }
    return removed;
  }

  private evictIfNeeded(): void {
    while (this.store.size > this.maxEntries) {
      // Map preserves insertion order; the oldest entry is LRU-ish given
      // get() reinserts on access.
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
      this.evictions++;
    }
  }
}

/**
 * Deterministic cache key for search queries: canonicalized query params
 * so that trivially-different requests share cache entries.
 */
export function searchCacheKey(parts: {
  query: string;
  maxResults: number;
  includeDomains?: readonly string[];
  excludeDomains?: readonly string[];
  language?: string;
  region?: string;
  freshness?: string;
  category?: string;
  providers?: readonly string[];
}): string {
  const normalize = (list?: readonly string[]) =>
    list
      ? [...list]
          .map((s) => s.toLowerCase())
          .sort()
          .join(",")
      : "";
  return keyFrom([
    "search",
    parts.query.trim().toLowerCase(),
    String(parts.maxResults),
    normalize(parts.includeDomains),
    normalize(parts.excludeDomains),
    parts.language ?? "",
    parts.region ?? "",
    parts.freshness ?? "any",
    parts.category ?? "web",
    normalize(parts.providers),
  ]);
}
