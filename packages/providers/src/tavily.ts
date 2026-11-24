/**
 * Tavily API provider — supported both for compatibility testing against
 * Tavily semantics and as an optional upstream for operators with keys.
 */

import type { SearchProvider, SearchQuery, SearchResult } from '@querynx/types';
import { fetchUrl } from '@querynx/fetcher';
import { canonicalizeUrl } from '@querynx/shared';

export interface TavilyConfig {
  apiKey: string;
  baseUrl?: string;
}

interface TavilyResponse {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    score?: number;
    published_date?: string;
  }>;
}

export class TavilyProvider implements SearchProvider {
  readonly name = 'tavily';
  private readonly baseUrl: string;

  constructor(
    private readonly config: TavilyConfig,
    private readonly timeoutMs = 15_000
  ) {
    this.baseUrl = config.baseUrl ?? 'https://api.tavily.com';
  }

  isConfigured(): boolean {
    return typeof this.config.apiKey === 'string' && this.config.apiKey.length > 0;
  }

  async search(query: SearchQuery, signal?: AbortSignal): Promise<SearchResult[]> {
    const response = await fetchUrl(`${this.baseUrl}/search`, {
      timeoutMs: this.timeoutMs,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.apiKey}`,
      },
      signal,
    });

    if (response.statusCode === 429) throw new Error('Tavily rate limit exceeded');
    if (response.statusCode !== 200) {
      throw new Error(`Tavily returned HTTP ${response.statusCode}`);
    }

    const body: Record<string, unknown> = {
      query: query.query,
      max_results: Math.min(query.maxResults * 2, 20),
      search_depth: 'basic',
      include_answer: false,
    };
    if (query.includeDomains?.length) body['include_domains'] = [...query.includeDomains];
    if (query.excludeDomains?.length) body['exclude_domains'] = [...query.excludeDomains];
    if (query.publishedAfter) body['topic'] = 'news';

    const parsed = JSON.parse(response.body) as TavilyResponse;
    const results: SearchResult[] = [];
    for (const item of parsed.results ?? []) {
      if (!item.url || !item.title) continue;
      const canonical = canonicalizeUrl(item.url);
      if (!canonical) continue;
      results.push({
        title: item.title.trim(),
        url: canonical,
        snippet: (item.content ?? '').trim().slice(0, 1000),
        score: typeof item.score === 'number' ? item.score : 0.5,
        provider: this.name,
        publishedAt: item.published_date,
      });
    }
    return results;
  }
}
