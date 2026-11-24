/**
 * Fastify application factory.
 *
 * Wires the search orchestrator, extraction pipeline and result cache
 * into a versioned HTTP API with authentication, rate limiting and
 * consistent error responses.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import {
  SearchOrchestrator,
  SearxngProvider,
  BraveProvider,
  TavilyProvider,
} from '@querynx/providers';
import { TTLCache, searchCacheKey } from '@querynx/cache';
import { fetchUrl } from '@querynx/fetcher';
import { extractDocument } from '@querynx/extractor';
import {
  TokenBucketRateLimiter,
  toSafeError,
  UnauthorizedError,
  ValidationError,
  isSafeOutboundUrl,
  canonicalizeUrl,
} from '@querynx/shared';
import type { SearchQuery, SearchResponse } from '@querynx/types';
import type { ApiConfig } from './config.js';
import { randomUUID } from 'node:crypto';

export interface AppDeps {
  config: ApiConfig;
  /** Allows tests to inject a custom orchestrator. */
  orchestrator?: SearchOrchestrator;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const { config } = deps;

  // --- Provider registry -------------------------------------------------
  const orchestrator =
    deps.orchestrator ??
    (() => {
      const providers = [];
      if (config.searxngBaseUrl) {
        providers.push(
          new SearxngProvider({
            baseUrl: config.searxngBaseUrl,
            engines: config.searxngEngines,
          })
        );
      }
      if (config.braveApiKey) {
        providers.push(new BraveProvider({ apiKey: config.braveApiKey }));
      }
      if (config.tavilyApiKey) {
        providers.push(new TavilyProvider({ apiKey: config.tavilyApiKey }));
      }
      if (providers.length === 0) {
        // Keyless SearXNG default pointing at the public instance is NOT
        // assumed; instead we expose a clearly-unconfigured state that the
        // /v1/providers endpoint reports. The API still boots.
        providers.push(
          new SearxngProvider({ baseUrl: config.searxngBaseUrl ?? 'http://localhost:8888' })
        );
      }
      return new SearchOrchestrator(providers, {
        maxProviderConcurrency: config.providerConcurrency,
      });
    })();

  const searchCache = new TTLCache<SearchResponse>(
    config.searchCacheTtlMs,
    config.searchCacheMaxEntries
  );

  // Anonymous-tier rate limiter keyed by remote address.
  const rateLimiter = new TokenBucketRateLimiter(
    config.anonymousRateLimitPerMinute,
    config.anonymousRateLimitPerMinute / 60
  );

  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ['req.headers.authorization', 'req.headers["x-api-key"]'],
    },
    bodyLimit: 256 * 1024, // 256 KiB request cap
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    ajv: {
      customOptions: {
        // Fastify's default `removeAdditional: true` silently strips
        // unknown properties. For an API surface we want a hard reject
        // so clients learn their payload is wrong.
        removeAdditional: false,
        allErrors: true, // report every schema violation, not just the first
      },
    },
  });

  // --- Auth ---------------------------------------------------------------
  app.addHook('onRequest', async (request) => {
    // Health endpoints are always public.
    const url = request.raw.url ?? '/';
    if (url === '/health' || url === '/ready' || url === '/metrics') return;

    const key =
      (request.headers['x-api-key'] as string | undefined) ??
      extractBearer(request.headers['authorization']);
    const valid = key !== undefined && config.apiKeys.includes(key);
    const isProtected = url.startsWith('/v1');

    if (isProtected && config.apiKeys.length > 0 && !valid) {
      throw new UnauthorizedError('Missing or invalid API key');
    }
    // When no API keys are configured the API is open (local dev mode).
    // Rate limiting still applies.
    const rateKey = valid ? `key:${key}` : `ip:${request.ip}`;
    if (!rateLimiter.tryConsume(rateKey)) {
      const retryAfter = Math.ceil(rateLimiter.msUntilAvailable(rateKey) / 1000);
      const err = new UnauthorizedError('Rate limit exceeded');
      // Attach retry hint via headers on the reply.
      request.headers['retry-after'] = String(retryAfter);
      throw Object.assign(err, { httpStatus: 429, code: 'RATE_LIMITED' } as const);
    }
  });

  // --- Error normalization --------------------------------------------------
  app.setErrorHandler((err, request, reply) => {
    // Fastify schema violations arrive as FST_ERR_VALIDATION with
    // statusCode 400 — surface them as structured validation errors.
    const isFastifyValidation =
      typeof err === 'object' &&
      err !== null &&
      'validation' in err &&
      'statusCode' in err;
    if (isFastifyValidation) {
      const validationErr = err as { statusCode: number; validation: unknown };
      return reply.code(validationErr.statusCode || 400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request failed schema validation',
          details: validationErr.validation,
          requestId: request.id,
        },
      });
    }
    const { error, status } = toSafeError(err, request.id);
    if (status >= 500) {
      request.log.error({ err }, 'internal error');
    } else {
      request.log.warn({ message: String((err as Error)?.message ?? err) }, 'request failed');
    }
    const retryAfter = (err as { retryAfter?: string }).retryAfter;
    if (retryAfter) reply.header('retry-after', retryAfter);
    reply.code(status).send({ error, requestId: request.id });
  });

  // --- Health ---------------------------------------------------------------
  app.get('/health', async () => ({ status: 'ok', version: '0.1.0' }));

  app.get('/ready', async () => {
    const health = orchestrator.getProviderHealth();
    const anyConfigured = health.some((h) => h.configured);
    return {
      status: anyConfigured ? 'ready' : 'degraded',
      providers: health.map((h) => ({
        name: h.name,
        configured: h.configured,
        state: h.state,
      })),
      cache: searchCache.stats(),
    };
  });

  app.get('/metrics', async () => {
    const s = searchCache.stats();
    return [
      '# HELP querynx_cache_hits Total cache hits',
      '# TYPE querynx_cache_hits counter',
      `querynx_cache_hits ${s.hits}`,
      '# HELP querynx_cache_misses Total cache misses',
      '# TYPE querynx_cache_misses counter',
      `querynx_cache_misses ${s.misses}`,
      '# HELP querynx_cache_entries Current cache entries',
      '# TYPE querynx_cache_entries gauge',
      `querynx_cache_entries ${s.size}`,
      '# HELP querynx_cache_stampedes_prevented Coalesced duplicate lookups',
      '# TYPE querynx_cache_stampedes_prevented counter',
      `querynx_cache_stampedes_prevented ${s.stampedesPrevented}`,
    ].join('\n');
  });

  // --- v1/search ------------------------------------------------------------
  const searchSchema = {
    body: {
      type: 'object',
      required: ['query'],
      additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 500 },
        maxResults: { type: 'integer', minimum: 1, maximum: 50 },
        includeDomains: { type: 'array', items: { type: 'string' }, maxItems: 20 },
        excludeDomains: { type: 'array', items: { type: 'string' }, maxItems: 20 },
        language: { type: 'string', maxLength: 10 },
        region: { type: 'string', maxLength: 10 },
        freshness: { type: 'string', enum: ['any', 'day', 'week', 'month', 'year'] },
        category: { type: 'string', enum: ['web', 'news', 'academic', 'code', 'docs'] },
        providers: { type: 'array', items: { type: 'string' }, maxItems: 10 },
      },
    },
  } as const;

  app.post('/v1/search', { schema: searchSchema }, async (request, reply) => {
    const body = request.body as {
      query: string;
      maxResults?: number;
      includeDomains?: string[];
      excludeDomains?: string[];
      language?: string;
      region?: string;
      freshness?: SearchQuery['freshness'];
      category?: SearchQuery['category'];
      providers?: string[];
    };

    const query: SearchQuery = {
      query: body.query.trim(),
      maxResults: body.maxResults ?? 10,
      includeDomains: body.includeDomains,
      excludeDomains: body.excludeDomains,
      language: body.language,
      region: body.region,
      freshness: body.freshness ?? 'any',
      category: body.category ?? 'web',
    };

    const cacheKey = searchCacheKey({
      query: query.query,
      maxResults: query.maxResults,
      includeDomains: query.includeDomains,
      excludeDomains: query.excludeDomains,
      language: query.language,
      region: query.region,
      freshness: query.freshness,
      category: query.category,
      providers: body.providers,
    });

    const started = Date.now();
    const response = await searchCache.getOrCompute(cacheKey, async () => {
      const r = await orchestrator.search(query, { providers: body.providers });
      return { ...r, diagnostics: { ...r.diagnostics, cacheHit: false } };
    });
    const fromCache = Date.now() - started < 2 && response.diagnostics.cacheHit !== false;

    reply.header('x-querynx-cache', fromCache ? 'hit' : 'miss');
    return { ...response, requestId: request.id };
  });

  // --- v1/extract -------------------------------------------------------------
  app.post(
    '/v1/extract',
    {
      schema: {
        body: {
          type: 'object',
          required: ['urls'],
          properties: {
            urls: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10 },
            format: { type: 'string', enum: ['markdown', 'html', 'text'] },
            includeLinks: { type: 'boolean' },
            includeTables: { type: 'boolean' },
            includeMetadata: { type: 'boolean' },
            maxContentLength: { type: 'integer', minimum: 1000, maximum: 500_000 },
            timeoutMs: { type: 'integer', minimum: 1000, maximum: 60_000 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const body = request.body as {
        urls: string[];
        format?: 'markdown' | 'html' | 'text';
        includeLinks?: boolean;
        includeTables?: boolean;
        includeMetadata?: boolean;
        maxContentLength?: number;
        timeoutMs?: number;
      };

      const canonical: string[] = [];
      for (const raw of body.urls) {
        const url = canonicalizeUrl(raw);
        if (!url) throw new ValidationError(`Invalid URL: ${raw}`);
        if (!isSafeOutboundUrl(url)) throw new ValidationError(`Blocked URL target: ${raw}`);
        canonical.push(url);
      }

      const results = await Promise.all(
        canonical.map(async (url) => {
          try {
            const fetched = await fetchUrl(url, {
              timeoutMs: body.timeoutMs ?? 15_000,
              maxBytes: 5 * 1024 * 1024,
            });
            const document = extractDocument(fetched.body, fetched.url, fetched.statusCode, {
              format: body.format ?? 'markdown',
              includeLinks: body.includeLinks ?? false,
              includeTables: body.includeTables ?? false,
              includeMetadata: body.includeMetadata ?? true,
              maxContentLength: body.maxContentLength ?? 200_000,
            });
            return { url, ok: true, document };
          } catch (err) {
            return {
              url,
              ok: false,
              error: err instanceof Error ? err.message : 'extraction failed',
            };
          }
        })
      );

      return { results, generatedAt: new Date().toISOString(), requestId: request.id };
    }
  );

  // --- v1/providers ------------------------------------------------------------
  app.get('/v1/providers', async () => ({
    providers: orchestrator.getProviderHealth(),
  }));

  return app;

  function extractBearer(header: unknown): string | undefined {
    if (typeof header !== 'string') return undefined;
    const match = header.match(/^Bearer\s+(.+)$/i);
    return match?.[1];
  }
}
