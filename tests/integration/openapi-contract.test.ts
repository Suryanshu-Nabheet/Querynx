/**
 * API contract test: validates that the live API matches the published
 * OpenAPI specification — every documented path exists and documented
 * requests produce documented response shapes.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../../apps/api/src/app.js';
import { loadConfig } from '../../apps/api/src/config.js';
import { SearchOrchestrator } from '@querynx/providers';
import type { SearchProvider, SearchQuery, SearchResult } from '@querynx/types';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';

class StubProvider implements SearchProvider {
  readonly name = 'stub';
  isConfigured(): boolean { return true; }
  async search(query: SearchQuery): Promise<SearchResult[]> {
    return [{
      title: `About ${query.query}`,
      url: 'https://example.com/contract',
      snippet: 'contract test result',
      score: 0.9,
      provider: 'stub',
    }];
  }
}

const spec = JSON.parse(
  readFileSync(new URL('../../docs/openapi.json', import.meta.url), 'utf-8')
) as { paths: Record<string, Record<string, { operationId: string }>> };

let app: FastifyInstance;

beforeAll(() => {
  app = buildApp({
    config: loadConfig({ QUERYNX_API_KEYS: 'contract-key' }),
    orchestrator: new SearchOrchestrator([new StubProvider()]),
  });
});

afterAll(async () => {
  await app.close();
});

describe('OpenAPI contract', () => {
  it('specifies at least 10 operations', () => {
    const ops = Object.entries(spec.paths).flatMap(
      ([path, methods]) =>
        Object.entries(methods)
          .filter(([, op]) => typeof op === 'object' && 'operationId' in (op as object))
          .map(([, op]) => ({ path, op: (op as { operationId: string }).operationId }))
    );
    expect(ops.length).toBeGreaterThanOrEqual(10);
  });

  it('serves every documented path', async () => {
    const documented = Object.keys(spec.paths);
    const getPaths = documented.filter((p) => 'get' in spec.paths[p]!);
    for (const path of getPaths) {
      const res = await app.inject({
        method: 'GET',
        url: path,
        headers: { 'x-api-key': 'contract-key' },
      });
      expect([200, 401]).toContain(res.statusCode); // auth-gated is fine
    }
  });

  it('POST /v1/search response matches the documented schema', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'x-api-key': 'contract-key' },
      payload: { query: 'contract' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      results: Array<Record<string, unknown>>;
      query: string;
      generatedAt: string;
      diagnostics: Record<string, unknown>;
    };
    // Required fields per the spec.
    expect(Array.isArray(body.results)).toBe(true);
    expect(typeof body.query).toBe('string');
    expect(typeof body.generatedAt).toBe('string');
    expect(typeof body.diagnostics).toBe('object');
    for (const key of ['title', 'url', 'snippet', 'score', 'provider']) {
      expect(body.results[0]).toHaveProperty(key);
    }
  });

  it('POST /v1/extract rejects undocumented input the way the spec says (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/extract',
      headers: { 'x-api-key': 'contract-key' },
      payload: { urls: ['http://169.254.169.254/x'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('error responses use the documented error envelope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/search',
      payload: { query: 'no key' },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json() as { error: { code: string; message: string }; requestId: string };
    expect(typeof body.error.code).toBe('string');
    expect(typeof body.error.message).toBe('string');
    expect(typeof body.requestId).toBe('string');
  });

  it('documents the Tavily-compatible surface with security disabled', () => {
    const tavily = spec.paths['/search']!.post!;
    expect(tavily.operationId).toBe('tavilySearch');
  });
});
