/**
 * Core search domain types.
 *
 * These types define the contract between search providers, the search
 * orchestration layer, ranking and the public API. Providers normalize
 * their native results into SearchResult; everything downstream works
 * exclusively with the normalized shape.
 */

/** Categories of search intent, used for provider routing and ranking. */
export type SearchCategory = 'web' | 'news' | 'academic' | 'code' | 'docs';

/** Freshness windows supported by providers and freshness ranking. */
export type Freshness = 'any' | 'day' | 'week' | 'month' | 'year';

/** A normalized, provider-agnostic search request. */
export interface SearchQuery {
  /** Raw user query text. */
  query: string;
  /** Maximum number of results to return after merge/dedupe. */
  maxResults: number;
  /** Only include results from these domains. */
  includeDomains?: readonly string[];
  /** Exclude results from these domains. */
  excludeDomains?: readonly string[];
  /** ISO 639-1 language code, e.g. "en". */
  language?: string;
  /** ISO 3166-1 region code, e.g. "us". */
  region?: string;
  /** Freshness window filter. */
  freshness?: Freshness;
  /** Inclusive publication-date lower bound (ISO 8601). */
  publishedAfter?: string;
  /** Inclusive publication-date upper bound (ISO 8601). */
  publishedBefore?: string;
  /** Routing category. */
  category?: SearchCategory;
  /**
   * Optional semantic embedding of the query. Computed by the embeddings
   * package when semantic or hybrid search is requested.
   */
  embedding?: readonly number[];
}

/** A normalized search result returned by any provider. */
export interface SearchResult {
  /** Result title, cleaned of HTML entities. */
  title: string;
  /** Canonical absolute result URL. */
  url: string;
  /** Short text snippet describing the result. */
  snippet: string;
  /** Full extracted content, when content retrieval was requested. */
  content?: string;
  /** Relevance score in [0, 1]; higher is more relevant. */
  score: number;
  /** Publication date in ISO 8601 when known. */
  publishedAt?: string;
  /** Name of the provider that produced this result. */
  provider: string;
  /** BCP-47 language of the result when detected. */
  language?: string;
  /** Favicon URL when available. */
  favicon?: string;
  /** Thumbnail image URL when available. */
  thumbnail?: string;
  /** Arbitrary provider-specific metadata (e.g. labels, site names). */
  metadata?: Readonly<Record<string, unknown>>;
  /** Stable content fingerprint for dedupe (see fingerprinting utils). */
  fingerprint?: string;
}

/** A single provider search attempt within a federated search. */
export interface ProviderSearchAttempt {
  provider: string;
  status: 'ok' | 'error' | 'skipped' | 'degraded';
  /** Results contributed by this provider. */
  resultCount: number;
  /** Wall-clock duration of the attempt in milliseconds. */
  durationMs: number;
  /** Error message when status is "error". */
  error?: string;
}

/** Outcome metadata for a completed federated search. */
export interface SearchDiagnostics {
  /** Number of providers that were asked. */
  providersQueried: number;
  /** Number of providers that returned results. */
  providersSucceeded: number;
  /** Whether the response was served from cache. */
  cacheHit: boolean;
  /** Total results before merge and dedupe. */
  rawResultCount: number;
  /** Results removed by dedupe. */
  duplicateCount: number;
  /** Per-provider attempt details. */
  attempts: readonly ProviderSearchAttempt[];
}

/** A complete search response. */
export interface SearchResponse {
  /** Merged, ranked, deduplicated results. */
  results: SearchResult[];
  /** Original query text. */
  query: string;
  /** Response generation timestamp (ISO 8601). */
  generatedAt: string;
  /** Execution diagnostics. */
  diagnostics: SearchDiagnostics;
  /** Server-assigned request identifier. */
  requestId?: string;
}

/** Health status of a single search provider. */
export interface ProviderHealth {
  /** Provider identifier. */
  name: string;
  /** Circuit state: closed (healthy), open (failing), half-open (probing). */
  state: 'closed' | 'open' | 'half-open';
  /** Consecutive failure count feeding the circuit breaker. */
  consecutiveFailures: number;
  /** Rolling success rate over the recent window, in [0, 1]. */
  successRate: number;
  /** Median latency over the recent window, in milliseconds. */
  medianLatencyMs: number;
  /** Whether the provider currently needs credentials or config to run. */
  configured: boolean;
  /** Human-readable status note. */
  note?: string;
}

/** Contract every search provider adapter must implement. */
export interface SearchProvider {
  /** Unique provider identifier, e.g. "searxng". */
  readonly name: string;
  /** Whether the provider has the credentials/config it needs to run. */
  isConfigured(): boolean;
  /** Execute a search and return normalized results. */
  search(query: SearchQuery, signal?: AbortSignal): Promise<SearchResult[]>;
}

/** Capability descriptors used when routing queries to providers. */
export interface ProviderCapabilities {
  /** Provider identifier. */
  name: string;
  /** Categories this provider can serve. */
  categories: readonly SearchCategory[];
  /** Whether the provider enforces date filters natively. */
  supportsFreshness: boolean;
  /** Whether the provider supports domain include/exclude natively. */
  supportsDomainFiltering: boolean;
  /** Approximate requests-per-minute budget granted by the operator. */
  requestsPerMinute: number;
}
