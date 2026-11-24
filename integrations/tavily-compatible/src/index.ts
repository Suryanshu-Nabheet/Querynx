/**
 * Tavily-compatible API surface.
 *
 * Maps Tavily's documented request/response contract onto the Querynx
 * orchestrator so existing Tavily clients switch by changing the base
 * URL and key. Implemented against Tavily's public API documentation
 * — request fields, response fields, error semantics.
 *
 * Tavily request:  POST /search { api_key, query, search_depth,
 *   topic, max_results, include_answer, include_raw_content,
 *   include_domains, exclude_domains, time_range, ... }
 * Tavily response: { results: [{title,url,content,score,published_date}],
 *   answer?, response_time }
 *
 * The Fastify app in apps/api mounts translateTavilyRequest -> Querynx
 * search -> translateTavilyResponse on POST /search (Tavily-style path,
 * no /v1 prefix).
 */

import type { SearchOrchestrator } from '@querynx/providers';
import type { SearchQuery, SearchResult, Freshness } from '@querynx/types';

export interface TavilySearchRequest {
  api_key?: string;
  query: string;
  search_depth?: 'basic' | 'advanced';
  topic?: 'general' | 'news';
  max_results?: number;
  include_answer?: boolean;
  include_raw_content?: boolean;
  include_domains?: string[];
  exclude_domains?: string[];
  time_range?: 'day' | 'week' | 'month' | 'year';
  chunk_token_limit?: number;
}

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
  published_date?: string;
  raw_content?: string;
}

export interface TavilySearchResponse {
  query: string;
  answer?: string;
  results: TavilyResult[];
  response_time: number;
}

/** Map Tavily's request fields onto the Querynx SearchQuery. */
export function translateTavilyRequest(request: TavilySearchRequest): SearchQuery {
  const timeRangeMap: Record<string, Freshness> = {
    day: 'day',
    week: 'week',
    month: 'month',
    year: 'year',
  };
  return {
    query: request.query,
    maxResults: Math.min(request.max_results ?? 5, 20),
    includeDomains: request.include_domains,
    excludeDomains: request.exclude_domains,
    category: request.topic === 'news' ? 'news' : 'web',
    freshness: request.time_range ? timeRangeMap[request.time_range] : 'any',
  };
}

/** Map Querynx results back into Tavily's response shape. */
export function translateTavilyResponse(
  query: string,
  results: readonly SearchResult[],
  startedAt: number,
  options: { includeAnswer?: boolean; answerText?: string } = {}
): TavilySearchResponse {
  const response: TavilySearchResponse = {
    query,
    results: results.map((r) => ({
      title: r.title,
      url: r.url,
      content: r.snippet,
      score: Number(r.score.toFixed(4)),
      ...(r.publishedAt ? { published_date: r.publishedAt } : {}),
    })),
    response_time: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
  };
  if (options.includeAnswer) {
    response.answer = options.answerText ?? summarizeResults(query, results);
  }
  return response;
}

/** Deterministic extractive answer for include_answer (no model). */
function summarizeResults(query: string, results: readonly SearchResult[]): string {
  if (results.length === 0) return `No results found for "${query}".`;
  const top = results.slice(0, 3);
  const parts = top.map((r) => `${r.snippet.slice(0, 200)} (${r.url})`);
  return `Top results for "${query}": ${parts.join(' ')}`;
}

/** Execute a Tavily-shaped search against the Querynx orchestrator. */
export async function executeTavilySearch(
  orchestrator: SearchOrchestrator,
  request: TavilySearchRequest
): Promise<TavilySearchResponse> {
  const startedAt = Date.now();
  const query = translateTavilyRequest(request);
  const response = await orchestrator.search(query);
  return translateTavilyResponse(request.query, response.results, startedAt, {
    includeAnswer: request.include_answer,
  });
}

/** Tavily-compatible error envelope. */
export function tavilyError(message: string, detail?: string): {
  body: { detail: string };
  status: number;
} {
  return {
    body: { detail: detail ?? message },
    status: 400,
  };
}
