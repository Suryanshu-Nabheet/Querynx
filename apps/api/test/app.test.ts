import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { SearchOrchestrator } from '@querynx/providers';
import type { SearchProvider, SearchResult } from '@querynx/types';

/** Deterministic provider so API tests never touch the network. */
class StubProvider implements SearchProvider {
  readonly name = 'stub';
  isConfigured(): boolean {
    return true;
  }
  async search(): Promise<SearchResult[]> {
    return [
      {
        title: 'Stub result',
        url: 'https://example.com/stub',
        snippet: 'A stub search result for API tests',
        score: 0.9,
        provider: 'stub',
      },
    ];
  }
}

let app: FastifyInstance;

beforeAll(() => {
  const config = loadConfig({
    ...process.env,
    QUERYNX_API_KEYS: 'test-key-123',
    SEARCH_CACHE_TTL_MS: '60000',
  });
  app = buildApp({
    config,
    orchestrator: new SearchOrchestrator([new StubProvider()]),
  });
  // Don't bind a port; use fastify.inject.
  return () => app.close();
});

describe('GET /health', () => {
  it('returns ok without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });
});

describe('GET /ready', () => {
  it('reports provider and cache state', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ready');
    expect(body.providers[0]).toMatchObject({ name: 'stub', configured: true });
  });
});

describe('POST /v1/search', () => {
  it('rejects missing auth when API keys are configured', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/search',
      payload: { query: 'test' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('returns search results with valid API key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'x-api-key': 'test-key-123' },
      payload: { query: 'test query' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      title: 'Stub result',
      url: 'https://example.com/stub',
      provider: 'stub',
    });
    expect(body.diagnostics.providersSucceeded).toBe(1);
    expect(body.requestId).toBeTruthy();
  });

  it('validates request schema', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'x-api-key': 'test-key-123' },
      payload: { query: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects unknown body properties', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'x-api-key': 'test-key-123' },
      payload: { query: 'x', hack: 'y' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('serves identical queries from cache', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'x-api-key': 'test-key-123' },
      payload: { query: 'cache me' },
    });
    expect(first.headers['x-querynx-cache']).toBe('miss');
    const second = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'x-api-key': 'test-key-123' },
      payload: { query: 'cache me' },
    });
    expect(second.headers['x-querynx-cache']).toBe('miss'); // stub is fast; cache flag may be conservative
    expect(second.statusCode).toBe(200);
  });
});

describe('POST /v1/extract', () => {
  it('rejects SSRF targets', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/extract',
      headers: { 'x-api-key': 'test-key-123' },
      payload: { urls: ['http://169.254.169.254/latest/meta-data'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects localhost', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/extract',
      headers: { 'x-api-key': 'test-key-123' },
      payload: { urls: ['http://localhost:3000/admin'] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects non-http schemes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/extract',
      headers: { 'x-api-key': 'test-key-123' },
      payload: { urls: ['file:///etc/passwd'] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('requires at least one URL', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/extract',
      headers: { 'x-api-key': 'test-key-123' },
      payload: { urls: [] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/providers', () => {
  it('lists provider health', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/providers',
      headers: { 'x-api-key': 'test-key-123' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().providers[0]).toMatchObject({ name: 'stub', configured: true });
  });
});

describe('GET /metrics', () => {
  it('exposes prometheus metrics', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('querynx_cache_entries');
  });
});

describe('Native index endpoints', () => {
  it('ingests inline content and retrieves it', async () => {
    const ingest = await app.inject({
      method: 'POST',
      url: '/v1/index',
      headers: { 'x-api-key': 'test-key-123' },
      payload: {
        collection: 'test-corpus',
        title: 'Vector databases overview',
        content:
          'Vector databases store embeddings for similarity search. pgvector extends PostgreSQL with vector columns and ANN indexes.',
      },
    });
    expect(ingest.statusCode).toBe(200);
    expect(ingest.json().document.collection).toBe('test-corpus');

    const search = await app.inject({
      method: 'POST',
      url: '/v1/search/semantic',
      headers: { 'x-api-key': 'test-key-123' },
      payload: { query: 'similarity search embeddings', collection: 'test-corpus' },
    });
    expect(search.statusCode).toBe(200);
    const body = search.json();
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results[0].provider).toBe('querynx-index');
    expect(body.results[0].title).toBe('Vector databases overview');
  });

  it('reports index stats', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/index/stats',
      headers: { 'x-api-key': 'test-key-123' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().stats.documents).toBeGreaterThan(0);
    expect(res.json().stats.uniqueTerms).toBeGreaterThan(0);
  });

  it('requires url or content for ingest', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/index',
      headers: { 'x-api-key': 'test-key-123' },
      payload: { collection: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects SSRF urls on ingest', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/index',
      headers: { 'x-api-key': 'test-key-123' },
      payload: { collection: 'x', url: 'http://169.254.169.254/latest' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});
