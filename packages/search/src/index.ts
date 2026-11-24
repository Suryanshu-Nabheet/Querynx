/**
 * The search facade: one entrypoint composing the whole search stack.
 *
 * Pipeline: parse (normalize, classify, extract operators, decompose,
 * expand) -> federated retrieval across providers -> configurable
 * ranking signals -> cache with stampede protection.
 *
 * The API, research engine, worker and SDKs all consume search through
 * this facade so every caller gets identical understanding, ranking and
 * caching behavior.
 */

import type {
  SearchQuery,
  SearchResponse,
  SearchResult,
  ProviderSearchAttempt,
  ProviderHealth,
} from '@querynx/types';
import { parseQuery, type ParsedQuery } from '@querynx/parser';
import type { SearchOrchestrator } from '@querynx/providers';
import { rankResults, type RankingSignal, type RankingContext } from '@querynx/ranking';
import { TTLCache, searchCacheKey } from '@querynx/cache';
import { TokenBucketRateLimiter } from '@querynx/shared';

export interface SearchServiceOptions {
  orchestrator: SearchOrchestrator;
  /** Result cache TTL (default 5 min). */
  cacheTtlMs?: number;
  cacheMaxEntries?: number;
  /** Extra ranking signals beyond the defaults. */
  customSignals?: readonly RankingSignal[];
  /** Operator domain preferences (domain -> boost in [-1,1]). */
  domainPreferences?: Record<string, number>;
  /** Global search rate limiter; per-identity limiters belong in the API layer. */
  searchPerMinuteBudget?: number;
}

export interface SearchRequestInput {
  /** Raw user query text — everything else is derived. */
  query: string;
  maxResults?: number;
  /** Explicit overrides after operator extraction. */
  includeDomains?: readonly string[];
  excludeDomains?: readonly string[];
  language?: string;
  region?: string;
  /** Disable the cache for this call (freshness-critical queries). */
  noCache?: boolean;
  signal?: AbortSignal;
}

export interface SearchServiceResult extends SearchResponse {
  /** The parsed/understood query structure. */
  parsed: ParsedQuery;
  /** Whether sub-queries were issued (decomposition ran). */
  decomposed: boolean;
}

export class SearchService {
  private readonly orchestrator: SearchOrchestrator;
  private readonly cache: TTLCache<SearchResponse>;
  private readonly customSignals?: readonly RankingSignal[];
  private readonly domainPreferences?: Record<string, number>;
  private readonly budget: TokenBucketRateLimiter | undefined;

  constructor(options: SearchServiceOptions) {
    this.orchestrator = options.orchestrator;
    this.cache = new TTLCache<SearchResponse>(
      options.cacheTtlMs ?? 5 * 60_000,
      options.cacheMaxEntries ?? 1000
    );
    this.customSignals = options.customSignals;
    this.domainPreferences = options.domainPreferences;
    this.budget = options.searchPerMinuteBudget
      ? new TokenBucketRateLimiter(options.searchPerMinuteBudget, options.searchPerMinuteBudget / 60)
      : undefined;
  }

  /** Full search pipeline. */
  async search(input: SearchRequestInput): Promise<SearchServiceResult> {
    const parsed = parseQuery(input.query);
    const maxResults = input.maxResults ?? 10;

    // Merge explicit filters with extracted site: operators.
    const includeDomains = mergeDomains(input.includeDomains, parsed.includeDomains);
    const excludeDomains = mergeDomains(input.excludeDomains);

    const cacheKey = searchCacheKey({
      query: parsed.cleaned,
      maxResults,
      includeDomains,
      excludeDomains,
      language: input.language,
      region: input.region,
      freshness: parsed.freshness,
      category: parsed.classification.category,
    });

    if (!input.noCache) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return {
          ...cached,
          diagnostics: { ...cached.diagnostics, cacheHit: true },
          parsed,
          decomposed: false,
        };
      }
    }

    // Budget check: the facade enforces a global search-per-minute cap
    // so no caller can exhaust the upstream providers.
    if (this.budget && !this.budget.tryConsume('global')) {
      throw new Error('search budget exhausted');
    }

    // Primary query + decomposition sub-queries run concurrently under
    // the orchestrator's own bounded concurrency.
    const queryTexts = [
      parsed.cleaned,
      ...parsed.decompositions.filter((d) => d !== parsed.cleaned),
    ];

    const perQuery = await Promise.all(
      queryTexts.slice(0, 3).map(async (text) => {
        const query: SearchQuery = {
          query: text,
          maxResults: maxResults * 2, // retrieval headroom before ranking
          includeDomains,
          excludeDomains,
          language: input.language,
          region: input.region,
          freshness: parsed.freshness,
          category: parsed.classification.category,
        };
        try {
          return await this.orchestrator.search(query, { signal: input.signal });
        } catch {
          return emptySearchResponse(text);
        }
      })
    );

    // Union results across the primary + decomposed queries, then rank.
    const candidates = dedupeByUrl(perQuery.flatMap((r) => r.results));
    const providerCounts = new Map<string, number>();
    for (const attempt of perQuery.flatMap((r) => r.diagnostics.attempts)) {
      if (attempt.status === 'ok') {
        providerCounts.set(attempt.provider, (providerCounts.get(attempt.provider) ?? 0) + 1);
      }
    }

    const context: RankingContext = {
      query: parsed.cleaned,
      domainPreferences: this.domainPreferences,
      providerCounts,
    };
    const ranked = rankResults(candidates, context, this.customSignals);

    const attempts: ProviderSearchAttempt[] = perQuery.flatMap((r) => r.diagnostics.attempts);
    const rawCount = perQuery.reduce((sum, r) => sum + r.diagnostics.rawResultCount, 0);
    const response: SearchResponse = {
      results: ranked.slice(0, maxResults).map((r) => ({
        ...r,
        score: r.rankScore,
      })),
      query: input.query,
      generatedAt: new Date().toISOString(),
      diagnostics: {
        providersQueried: Math.max(...perQuery.map((r) => r.diagnostics.providersQueried), 0),
        providersSucceeded: perQuery.filter((r) => r.diagnostics.providersSucceeded > 0).length,
        cacheHit: false,
        rawResultCount: rawCount,
        duplicateCount: rawCount - candidates.length,
        attempts,
      },
    };

    if (!input.noCache) {
      this.cache.set(cacheKey, response);
    }
    return { ...response, parsed, decomposed: queryTexts.length > 1 };
  }

  /** Cache statistics for the metrics endpoints. */
  cacheStats(): ReturnType<TTLCache<SearchResponse>['stats']> {
    return this.cache.stats();
  }

  /** Provider health passthrough. */
  providerHealth(): ProviderHealth[] {
    return this.orchestrator.getProviderHealth();
  }
}

function mergeDomains(
  explicit?: readonly string[],
  extracted?: readonly string[]
): readonly string[] | undefined {
  if (!explicit && !extracted) return undefined;
  return [...new Set([...(explicit ?? []), ...(extracted ?? [])])];
}

function dedupeByUrl(results: readonly SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const result of results) {
    if (seen.has(result.url)) continue;
    seen.add(result.url);
    out.push(result);
  }
  return out;
}

function emptySearchResponse(query: string): SearchResponse {
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
      attempts: [],
    },
  };
}
