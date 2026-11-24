import { describe, expect, it } from 'vitest';
import { SearchOrchestrator } from '@querynx/providers';
import type { SearchProvider, SearchQuery, SearchResult } from '@querynx/types';
import {
  executeTavilySearch,
  translateTavilyRequest,
  translateTavilyResponse,
  tavilyError,
} from '../src/index.js';

class StubProvider implements SearchProvider {
  readonly name = 'stub';
  isConfigured() { return true; }
  async search(query: SearchQuery): Promise<SearchResult[]> {
    return [
      {
        title: `About ${query.query}`,
        url: 'https://example.com/result',
        snippet: 'Relevant content about the query subject.',
        score: 0.9123,
        provider: 'stub',
        publishedAt: '2026-01-15T00:00:00Z',
      },
    ];
  }
}

describe('translateTavilyRequest', () => {
  it('maps Tavily fields to Querynx SearchQuery', () => {
    const q = translateTavilyRequest({
      query: 'postgres',
      max_results: 8,
      topic: 'news',
      time_range: 'week',
      include_domains: ['pg.org'],
      exclude_domains: ['spam.com'],
    });
    expect(q.maxResults).toBe(8);
    expect(q.category).toBe('news');
    expect(q.freshness).toBe('week');
    expect(q.includeDomains).toEqual(['pg.org']);
    expect(q.excludeDomains).toEqual(['spam.com']);
  });

  it('defaults max_results to 5 and caps at 20', () => {
    expect(translateTavilyRequest({ query: 'x' }).maxResults).toBe(5);
    expect(translateTavilyRequest({ query: 'x', max_results: 99 }).maxResults).toBe(20);
  });
});

describe('translateTavilyResponse', () => {
  it('maps results into the Tavily envelope with response_time', () => {
    const started = Date.now() - 120;
    const response = translateTavilyResponse('q', [
      {
        title: 'T',
        url: 'https://x.example/a',
        snippet: 'S',
        score: 0.51234,
        provider: 'stub',
        publishedAt: '2026-02-01T00:00:00Z',
      },
    ], started);
    expect(response.query).toBe('q');
    expect(response.results[0]!.score).toBe(0.5123);
    expect(response.results[0]!.published_date).toBe('2026-02-01T00:00:00Z');
    expect(response.response_time).toBeGreaterThanOrEqual(0.1);
  });

  it('includes an extractive answer when requested', () => {
    const response = translateTavilyResponse('q', [
      { title: 'T', url: 'https://x.example', snippet: 'the answer content', score: 1, provider: 'p' },
    ], Date.now(), { includeAnswer: true });
    expect(response.answer).toContain('the answer content');
  });
});

describe('executeTavilySearch', () => {
  it('runs end-to-end against the orchestrator', async () => {
    const orchestrator = new SearchOrchestrator([new StubProvider()]);
    const response = await executeTavilySearch(orchestrator, {
      query: 'hello tavily',
      include_answer: true,
    });
    expect(response.query).toBe('hello tavily');
    expect(response.results[0]!.url).toBe('https://example.com/result');
    expect(response.answer).toBeTruthy();
  });
});

describe('tavilyError', () => {
  it('produces the Tavily error envelope', () => {
    const err = tavilyError('Missing query');
    expect(err.status).toBe(400);
    expect(err.body.detail).toBe('Missing query');
  });
});
