/**
 * SearXNG provider — the default, fully open, self-hostable metasearch
 * backend. No API key required, which makes Querynx functional out of
 * the box for self-hosters while remaining respectful of the upstream
 * instance's rate limits.
 */

import type { SearchProvider, SearchQuery, SearchResult } from '@querynx/types';
import { fetchUrl } from '@querynx/fetcher';
import { canonicalizeUrl } from '@querynx/shared';

export interface SearxngConfig {
  /** Base URL of the SearXNG instance, e.g. "https://searx.example.com". */
  baseUrl: string;
  /** Optional comma-separated engine allowlist forwarded to SearXNG. */
  engines?: string;
  /** Instance-imposed safety level: 0 (off), 1 (moderate), 2 (strict). */
  safesearch?: 0 | 1 | 2;
}

interface SearxngResponseItem {
  title?: string;
  url?: string;
  content?: string;
  publishedDate?: number | string;
  engine?: string;
  score?: number;
}

interface SearxngResponse {
  results?: SearxngResponseItem[];
  unresponsive_engines?: Array<[string, string]>;
}

function parsePublished(value: number | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') {
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export class SearxngProvider implements SearchProvider {
  readonly name = 'searxng';

  constructor(
    private readonly config: SearxngConfig,
    private readonly timeoutMs = 10_000
  ) {}

  isConfigured(): boolean {
    try {
      const u = new URL(this.config.baseUrl);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }

  async search(query: SearchQuery, signal?: AbortSignal): Promise<SearchResult[]> {
    const url = new URL('/search', this.config.baseUrl);
    url.searchParams.set('q', query.query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('safesearch', String(this.config.safesearch ?? 1));
    if (this.config.engines) {
      url.searchParams.set('engines', this.config.engines);
    }
    // SearXNG supports language codes like "en-US"; region via "language".
    if (query.language) {
      url.searchParams.set('language', query.language);
    }
    if (query.region && !query.language) {
      url.searchParams.set('language', query.region);
    }
    // Category routing.
    const category = query.category ?? 'web';
    if (category === 'news') {
      url.searchParams.set('categories', 'news');
    } else if (category === 'code') {
      url.searchParams.set('categories', 'it');
    } else if (category === 'academic') {
      url.searchParams.set('categories', 'science');
    } else if (category === 'docs') {
      url.searchParams.set('categories', 'it,general');
    }
    // Time range filter.
    if (query.freshness && query.freshness !== 'any') {
      const ranges: Record<string, string> = {
        day: 'day',
        week: 'week',
        month: 'month',
        year: 'year',
      };
      const range = ranges[query.freshness];
      if (range) url.searchParams.set('time_range', range);
    }

    const response = await fetchUrl(url.toString(), {
      timeoutMs: this.timeoutMs,
      maxBytes: 5 * 1024 * 1024,
      headers: { accept: 'application/json' },
      signal,
    });

    if (response.statusCode !== 200) {
      throw new Error(`SearXNG returned HTTP ${response.statusCode}`);
    }

    let parsed: SearxngResponse;
    try {
      parsed = JSON.parse(response.body) as SearxngResponse;
    } catch {
      throw new Error('SearXNG returned non-JSON response (json format disabled?)');
    }

    const items = parsed.results ?? [];
    const results: SearchResult[] = [];
    for (const item of items) {
      if (!item.url || !item.title) continue;
      const canonical = canonicalizeUrl(item.url);
      if (!canonical) continue;
      results.push({
        title: item.title.trim(),
        url: canonical,
        snippet: (item.content ?? '').trim().slice(0, 1000),
        score: 0.5, // normalized during merge
        provider: this.name,
        publishedAt: parsePublished(item.publishedDate),
        metadata: { engine: item.engine },
      });
      if (results.length >= query.maxResults * 2) break; // fetch headroom for merge
    }
    return results;
  }
}
