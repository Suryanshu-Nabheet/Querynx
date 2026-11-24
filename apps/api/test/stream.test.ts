import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { SearchOrchestrator } from '@querynx/providers';
import type { SearchProvider, SearchResult } from '@querynx/types';

/** Slow provider: streams proof that partial events arrive before done. */
class SlowProvider implements SearchProvider {
  readonly name = 'slow';
  isConfigured(): boolean {
    return true;
  }
  async search(): Promise<SearchResult[]> {
    await new Promise((r) => setTimeout(r, 50));
    return [
      {
        title: 'Streamed result',
        url: 'https://example.com/streamed',
        snippet: 'arrived via SSE',
        score: 0.9,
        provider: 'slow',
      },
    ];
  }
}

let app: FastifyInstance;

beforeAll(() => {
  app = buildApp({
    config: loadConfig({ QUERYNX_API_KEYS: 'test-key-123' }),
    orchestrator: new SearchOrchestrator([new SlowProvider()]),
  });
});

/** Parse an SSE body into [event, data] pairs. */
function parseSse(body: string): Array<[string, unknown]> {
  const events: Array<[string, unknown]> = [];
  for (const chunk of body.split('\n\n')) {
    const eventLine = chunk.split('\n').find((l) => l.startsWith('event: '));
    const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
    if (eventLine && dataLine) {
      events.push([
        eventLine.slice('event: '.length),
        JSON.parse(dataLine.slice('data: '.length)) as unknown,
      ]);
    }
  }
  return events;
}

describe('POST /v1/search/stream', () => {
  it('emits start, partial, results and done events', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/search/stream',
      headers: { 'x-api-key': 'test-key-123' },
      payload: { query: 'streaming test' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['cache-control']).toContain('no-cache');

    const events = parseSse(res.body);
    const names = events.map(([name]) => name);
    expect(names[0]).toBe('start');
    expect(names).toContain('partial');
    expect(names).toContain('results');
    expect(names.at(-1)).toBe('done');

    const resultsEvent = events.find(([name]) => name === 'results')!;
    const data = resultsEvent[1] as { results: SearchResult[] };
    expect(data.results[0]!.title).toBe('Streamed result');
  });

  it('requires authentication', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/search/stream',
      payload: { query: 'x' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /v1/research/stream', () => {
  it('streams research lifecycle events ending with completed', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/research/stream',
      headers: { 'x-api-key': 'test-key-123' },
      payload: { objective: 'sse research test', mode: 'fast', maxPages: 1 },
    });
    expect(res.statusCode).toBe(200);
    const events = parseSse(res.body);
    const names = events.map(([name]) => name);
    expect(names[0]).toBe('start');
    expect(names.at(-1)).toBe('completed');

    const completed = events.at(-1)![1] as { report: { termination: string } };
    expect(completed.report.termination).toBeOneOf([
      'coverage-reached',
      'budget-exhausted',
      'no-results',
    ]);
  });

  it('validates the objective', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/research/stream',
      headers: { 'x-api-key': 'test-key-123' },
      payload: { objective: 'no' },
    });
    expect(res.statusCode).toBe(400);
  });
});
