/**
 * Querynx TypeScript SDK client.
 *
 * Thin, dependency-free client over the Querynx HTTP API using the
 * global fetch. Typed responses, automatic retries on transient
 * failures, API-key auth, and consistent error surfaces.
 */

import type {
  SearchResponse,
  ExtractResponse,
  ProviderHealth,
} from '@querynx/types';
import type { ResearchReport, ResearchEvent, ResearchMode } from '@querynx/research';

export interface QuerynxClientOptions {
  /** Base URL of the Querynx API, e.g. "http://localhost:3001". */
  baseUrl: string;
  /** API key. */
  apiKey?: string;
  /** Request timeout (default 30s). */
  timeoutMs?: number;
  /** Retries on 5xx and network errors (default 2). */
  maxRetries?: number;
}

export class QuerynxError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly requestId?: string
  ) {
    super(message);
    this.name = 'QuerynxError';
  }
}

export interface SearchOptions {
  maxResults?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  language?: string;
  region?: string;
  freshness?: 'any' | 'day' | 'week' | 'month' | 'year';
  category?: 'web' | 'news' | 'academic' | 'code' | 'docs';
  signal?: AbortSignal;
}

export interface ExtractOptions {
  format?: 'markdown' | 'html' | 'text';
  includeLinks?: boolean;
  includeTables?: boolean;
  includeMetadata?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ResearchOptions {
  mode?: ResearchMode;
  maxQueries?: number;
  maxPages?: number;
  timeMs?: number;
  signal?: AbortSignal;
}

export class QuerynxClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: QuerynxClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
  }

  /** Execute a federated web search. */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
    const body: Record<string, unknown> = { query };
    if (options.maxResults !== undefined) body['maxResults'] = options.maxResults;
    if (options.includeDomains) body['includeDomains'] = options.includeDomains;
    if (options.excludeDomains) body['excludeDomains'] = options.excludeDomains;
    if (options.language) body['language'] = options.language;
    if (options.region) body['region'] = options.region;
    if (options.freshness) body['freshness'] = options.freshness;
    if (options.category) body['category'] = options.category;

    return this.request<SearchResponse>('/v1/search', {
      method: 'POST',
      body,
      signal: options.signal,
    });
  }

  /** Run several searches in one call. */
  async searchBatch(queries: string[], maxResults?: number): Promise<{
    responses: Array<{ ok: boolean; query?: string; error?: string } & Partial<SearchResponse>>;
    generatedAt: string;
  }> {
    const body: Record<string, unknown> = { queries };
    if (maxResults !== undefined) body['maxResults'] = maxResults;
    return this.request('/v1/search/batch', { method: 'POST', body });
  }

  /** Fetch structured content from URLs. */
  async extract(urls: string[], options: ExtractOptions = {}): Promise<ExtractResponse> {
    const body: Record<string, unknown> = { urls };
    if (options.format) body['format'] = options.format;
    if (options.includeLinks !== undefined) body['includeLinks'] = options.includeLinks;
    if (options.includeTables !== undefined) body['includeTables'] = options.includeTables;
    if (options.includeMetadata !== undefined) body['includeMetadata'] = options.includeMetadata;
    if (options.timeoutMs !== undefined) body['timeoutMs'] = options.timeoutMs;

    return this.request<ExtractResponse>('/v1/extract', {
      method: 'POST',
      body,
      signal: options.signal,
    });
  }

  /** Run a bounded research job. */
  async research(objective: string, options: ResearchOptions = {}): Promise<{
    report: ResearchReport;
    events: ResearchEvent[];
    requestId: string;
  }> {
    const body: Record<string, unknown> = { objective };
    if (options.mode) body['mode'] = options.mode;
    if (options.maxQueries !== undefined) body['maxQueries'] = options.maxQueries;
    if (options.maxPages !== undefined) body['maxPages'] = options.maxPages;
    if (options.timeMs !== undefined) body['timeMs'] = options.timeMs;

    return this.request('/v1/research', {
      method: 'POST',
      body,
      signal: options.signal,
    });
  }

  /** Provider health snapshot. */
  async providers(): Promise<{ providers: ProviderHealth[] }> {
    return this.request('/v1/providers', { method: 'GET' });
  }

  /** Liveness probe. */
  async health(): Promise<{ status: string; version: string }> {
    return this.request('/health', { method: 'GET' });
  }

  private async request<T>(
    path: string,
    init: { method: string; body?: unknown; signal?: AbortSignal }
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const onOuterAbort = () => controller.abort();
      init.signal?.addEventListener('abort', onOuterAbort, { once: true });

      try {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (this.apiKey) headers['x-api-key'] = this.apiKey;

        const response = await fetch(`${this.baseUrl}${path}`, {
          method: init.method,
          headers,
          body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
          signal: controller.signal,
        });

        const text = await response.text();
        const parsed = text ? (JSON.parse(text) as unknown) : null;

        if (!response.ok) {
          const errShape = (parsed ?? {}) as {
            error?: { code?: string; message?: string };
            requestId?: string;
          };
          const error = new QuerynxError(
            errShape.error?.message ?? `HTTP ${response.status}`,
            response.status,
            errShape.error?.code,
            errShape.requestId
          );
          // Retry only transient failures.
          if (response.status >= 500 && attempt < this.maxRetries) {
            lastError = error;
            await delay(300 * 2 ** attempt + Math.random() * 200);
            continue;
          }
          throw error;
        }

        return parsed as T;
      } catch (err) {
        if (err instanceof QuerynxError) throw err;
        lastError = err;
        if (attempt < this.maxRetries && !(init.signal?.aborted)) {
          await delay(300 * 2 ** attempt + Math.random() * 200);
          continue;
        }
        throw new QuerynxError(
          err instanceof Error ? err.message : 'request failed',
          0
        );
      } finally {
        clearTimeout(timer);
        init.signal?.removeEventListener('abort', onOuterAbort);
      }
    }
    throw lastError instanceof Error
      ? new QuerynxError(lastError.message, 0)
      : new QuerynxError('request failed', 0);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
