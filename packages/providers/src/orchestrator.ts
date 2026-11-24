/**
 * Federated search orchestrator.
 *
 * Executes queries across configured providers concurrently under
 * bounded concurrency and per-provider circuit breakers, normalizes
 * and merges results with Reciprocal Rank Fusion, deduplicates by
 * canonical URL and content fingerprint, applies domain filters,
 * and degrades gracefully when providers fail.
 */

import type {
  SearchProvider,
  SearchQuery,
  SearchResult,
  SearchResponse,
  ProviderSearchAttempt,
  ProviderHealth,
} from '@querynx/types';
import {
  CircuitBreaker,
  CircuitOpenError,
  Semaphore,
  canonicalDedupeKey,
  fingerprintText,
  fingerprintSimilarity,
  mapWithConcurrency,
  passesDomainFilters,
} from '@querynx/shared';

export interface OrchestratorOptions {
  /** Hard cap on simultaneous provider requests. */
  maxProviderConcurrency?: number;
  /** Circuit breaker failure threshold per provider. */
  breakerThreshold?: number;
  /** Circuit breaker reset window. */
  breakerResetMs?: number;
  /** Per-provider timeout in ms. */
  providerTimeoutMs?: number;
  /** Similarity above which two results are content-duplicates. */
  duplicateSimilarityThreshold?: number;
}

/** Rolling per-provider health tracking for GET /v1/providers. */
class ProviderHealthTracker {
  private readonly windowSize = 20;
  private readonly latencies = new Map<string, number[]>();
  private readonly outcomes = new Map<string, boolean[]>();
  readonly breakers = new Map<string, CircuitBreaker>();

  recordLatency(name: string, ms: number): void {
    const arr = this.latencies.get(name) ?? [];
    arr.push(ms);
    if (arr.length > this.windowSize) arr.shift();
    this.latencies.set(name, arr);
  }

  recordOutcome(name: string, ok: boolean): void {
    const arr = this.outcomes.get(name) ?? [];
    arr.push(ok);
    if (arr.length > this.windowSize) arr.shift();
    this.outcomes.set(name, arr);
  }

  getBreaker(name: string, threshold: number, resetMs: number): CircuitBreaker {
    let breaker = this.breakers.get(name);
    if (!breaker) {
      breaker = new CircuitBreaker(threshold, resetMs);
      this.breakers.set(name, breaker);
    }
    return breaker;
  }

  snapshot(providers: readonly SearchProvider[]): ProviderHealth[] {
    return providers.map((p) => {
      const outcomes = this.outcomes.get(p.name) ?? [];
      const latencies = this.latencies.get(p.name) ?? [];
      const successes = outcomes.filter(Boolean).length;
      const breaker = this.breakers.get(p.name);
      const sorted = [...latencies].sort((a, b) => a - b);
      const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)]! : 0;
      return {
        name: p.name,
        state: breaker?.status ?? 'closed',
        consecutiveFailures: breaker ? (breaker.status === 'open' ? breakerThresholdDefault : 0) : 0,
        successRate: outcomes.length > 0 ? successes / outcomes.length : 1,
        medianLatencyMs: median,
        configured: p.isConfigured(),
        note: breaker?.status === 'open' ? 'circuit open (recent failures)' : undefined,
      };
    });
  }
}

const breakerThresholdDefault = 3;

export class SearchOrchestrator {
  private readonly providers: SearchProvider[];
  private readonly options: Required<OrchestratorOptions>;
  private readonly healthTracker = new ProviderHealthTracker();
  private readonly providerSemaphore: Semaphore;

  constructor(
    providers: readonly SearchProvider[],
    options: OrchestratorOptions = {}
  ) {
    if (providers.length === 0) {
      throw new Error('SearchOrchestrator requires at least one provider');
    }
    this.providers = [...providers];
    this.options = {
      maxProviderConcurrency: options.maxProviderConcurrency ?? 4,
      breakerThreshold: options.breakerThreshold ?? 3,
      breakerResetMs: options.breakerResetMs ?? 60_000,
      providerTimeoutMs: options.providerTimeoutMs ?? 12_000,
      duplicateSimilarityThreshold: options.duplicateSimilarityThreshold ?? 0.85,
    };
    this.providerSemaphore = new Semaphore(this.options.maxProviderConcurrency);
  }

  /** Provider health snapshot for the API and dashboard. */
  getProviderHealth(): ProviderHealth[] {
    return this.healthTracker.snapshot(this.providers);
  }

  /**
   * Execute a federated search. Never throws for individual provider
   * failures; throws only if every provider fails.
   */
  async search(
    query: SearchQuery,
    options: { signal?: AbortSignal; providers?: readonly string[] } = {}
  ): Promise<SearchResponse> {
    const started = Date.now();
    const { signal } = options;
    const providerFilter = options.providers;
    const candidates = this.providers.filter(
      (p) => p.isConfigured() && (!providerFilter || providerFilter.includes(p.name))
    );
    if (candidates.length === 0) {
      return emptyResponse(query.query, 'no configured providers available', started);
    }

    // Fan out across providers with a concurrency cap.
    const perProviderResults = await mapWithConcurrency(
      candidates,
      this.options.maxProviderConcurrency,
      async (provider): Promise<{ provider: string; results: SearchResult[]; attempt: ProviderSearchAttempt }> => {
        const breaker = this.healthTracker.getBreaker(
          provider.name,
          this.options.breakerThreshold,
          this.options.breakerResetMs
        );
        if (!breaker.allowed) {
          return {
            provider: provider.name,
            results: [],
            attempt: {
              provider: provider.name,
              status: 'skipped',
              resultCount: 0,
              durationMs: 0,
              error: 'circuit open',
            },
          };
        }

        const acquired = await this.providerSemaphore.acquire(5_000, signal);
        if (!acquired) {
          return {
            provider: provider.name,
            results: [],
            attempt: {
              provider: provider.name,
              status: 'skipped',
              resultCount: 0,
              durationMs: 0,
              error: 'timeout acquiring provider slot',
            },
          };
        }

        const t0 = Date.now();
        try {
          const timeoutController = new AbortController();
          const timer = setTimeout(
            () => timeoutController.abort(),
            this.options.providerTimeoutMs
          );
          const onOuterAbort = () => timeoutController.abort();
          signal?.addEventListener('abort', onOuterAbort, { once: true });
          try {
            const results = await provider.search(query, timeoutController.signal);
            const duration = Date.now() - t0;
            this.healthTracker.recordLatency(provider.name, duration);
            this.healthTracker.recordOutcome(provider.name, true);
            breaker.success();
            return {
              provider: provider.name,
              results,
              attempt: { provider: provider.name, status: 'ok', resultCount: results.length, durationMs: duration },
            };
          } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onOuterAbort);
          }
        } catch (err) {
          const duration = Date.now() - t0;
          const message = err instanceof Error ? err.message : String(err);
          const aborted = err instanceof DOMException && err.name === 'AbortError';
          if (!aborted) {
            this.healthTracker.recordOutcome(provider.name, false);
            breaker.failure();
          }
          return {
            provider: provider.name,
            results: [],
            attempt: {
              provider: provider.name,
              status: aborted ? 'skipped' : 'error',
              resultCount: 0,
              durationMs: duration,
              error: aborted ? 'cancelled' : message,
            },
          };
        } finally {
          this.providerSemaphore.release();
        }
      },
      signal
    );

    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const attempts = perProviderResults.map((r) => r.attempt);
    const succeeded = attempts.filter((a) => a.status === 'ok');
    const rawCount = perProviderResults.reduce((sum, r) => sum + r.results.length, 0);

    if (succeeded.length === 0) {
      return {
        results: [],
        query: query.query,
        generatedAt: new Date().toISOString(),
        diagnostics: {
          providersQueried: attempts.length,
          providersSucceeded: 0,
          cacheHit: false,
          rawResultCount: 0,
          duplicateCount: 0,
          attempts,
        },
      };
    }

    // Merge with RRF + dedupe.
    const merged = this.mergeResults(perProviderResults, query);

    return {
      results: merged.slice(0, query.maxResults),
      query: query.query,
      generatedAt: new Date().toISOString(),
      diagnostics: {
        providersQueried: attempts.length,
        providersSucceeded: succeeded.length,
        cacheHit: false,
        rawResultCount: rawCount,
        duplicateCount: rawCount - merged.length,
        attempts,
      },
    };
  }

  /**
   * Reciprocal Rank Fusion across provider lists with cross-provider
   * dedupe (canonical URL, then content similarity on snippets).
   */
  private mergeResults(
    perProvider: ReadonlyArray<{ provider: string; results: SearchResult[] }>,
    query: SearchQuery
  ): SearchResult[] {
    const k = 60; // standard RRF constant
    const urlSeen = new Map<string, { result: SearchResult; rankSum: number; providers: Set<string> }>();
    const order: string[] = [];

    // Score by RRF over each provider's ordering.
    for (const { provider, results } of perProvider) {
      results.forEach((result, index) => {
        if (!passesDomainFilters(result.url, query.includeDomains, query.excludeDomains)) {
          return;
        }
        const key = canonicalDedupeKey(result.url);
        const existing = urlSeen.get(key);
        if (existing) {
          existing.rankSum += 1 / (k + index + 1);
          existing.providers.add(provider);
          // Prefer richer snippets across providers.
          if (result.snippet.length > existing.result.snippet.length) {
            existing.result.snippet = result.snippet;
          }
          if (result.publishedAt && !existing.result.publishedAt) {
            existing.result.publishedAt = result.publishedAt;
          }
        } else {
          order.push(key);
          urlSeen.set(key, {
            result: { ...result, fingerprint: fingerprintText(result.title + ' ' + result.snippet) },
            rankSum: 1 / (k + index + 1),
            providers: new Set([provider]),
          });
        }
      });
    }

    // Content-similarity dedupe pass across distinct URLs.
    const kept: Array<{ result: SearchResult; rankSum: number; providers: Set<string> }> = [];
    for (const key of order) {
      const entry = urlSeen.get(key)!;
      const isDup = kept.some((existing) => {
        if (existing.result.url === entry.result.url) return true;
        const sim = fingerprintSimilarity(
          existing.result.fingerprint ?? '',
          entry.result.fingerprint ?? ''
        );
        return sim >= this.options.duplicateSimilarityThreshold;
      });
      if (!isDup) kept.push(entry);
    }

    // Diversity boost: results confirmed by multiple providers rank higher.
    return kept
      .map(({ result, rankSum, providers }) => ({
        result: { ...result, score: rankSum, metadata: { ...result.metadata, providers: [...providers] } },
        rankSum,
        providerCount: providers.size,
      }))
      .sort((a, b) => {
        // Primary: RRF rank sum. Tie-break: provider corroboration.
        if (b.rankSum !== a.rankSum) return b.rankSum - a.rankSum;
        return b.providerCount - a.providerCount;
      })
      .map((entry) => entry.result);
  }
}

function emptyResponse(query: string, error: string, started: number): SearchResponse {
  return {
    results: [],
    query,
    generatedAt: new Date().toISOString(),
    diagnostics: {
      providersQueried: 0,
      providersSucceeded: 0,
      cacheHit: false,
      rawResultCount: 0,
      duplicateCount: 0,
      attempts: [
        {
          provider: 'none',
          status: 'error',
          resultCount: 0,
          durationMs: Date.now() - started,
          error,
        },
      ],
    },
  };
}
