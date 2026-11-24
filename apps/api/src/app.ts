/**
 * Fastify application factory.
 *
 * Wires the search orchestrator, extraction pipeline and result cache
 * into a versioned HTTP API with authentication, rate limiting and
 * consistent error responses.
 */

import Fastify, { type FastifyInstance } from "fastify";
import {
  SearchOrchestrator,
  SearxngProvider,
  BraveProvider,
  TavilyProvider,
} from "@querynx/providers";
import { TTLCache, searchCacheKey } from "@querynx/cache";
import { fetchUrl } from "@querynx/fetcher";
import { extractDocument } from "@querynx/extractor";
import {
  MemorySearchEngine,
  fromExtractedDocument,
  type RetrievalHit,
} from "@querynx/indexer";
import { connectStores } from "@querynx/database";
import { hashApiKey } from "@querynx/auth";
import {
  ResearchEngine,
  MODE_BUDGETS,
  type ResearchEvent,
} from "@querynx/research";
import { executeTavilySearch } from "@querynx/tavily-compat";
import {
  TokenBucketRateLimiter,
  toSafeError,
  UnauthorizedError,
  ValidationError,
  isSafeOutboundUrl,
  canonicalizeUrl,
} from "@querynx/shared";
import type { SearchQuery, SearchResponse } from "@querynx/types";
import type { ApiConfig } from "./config.js";
import { PersistentIndex } from "./persistence.js";
import { registerApiJobHandlers, serializeJob } from "./jobs.js";
import { JobBridge, makeDelegatingStore } from "./job-bridge.js";
import { deliverWebhook, validWebhookTarget } from "./webhooks.js";
import {
  createLlmClient,
  wrapUntrustedContent,
  ANTI_INJECTION_SYSTEM,
} from "@querynx/llm";
import { mapWithConcurrency, extractDomain } from "@querynx/shared";
import { CrawlEngine, fetchSitemapUrls } from "@querynx/crawler";
import { JobQueue } from "@querynx/queue";
import { randomUUID } from "node:crypto";

export interface AppDeps {
  config: ApiConfig;
  /** Allows tests to inject a custom orchestrator. */
  orchestrator?: SearchOrchestrator;
  /** Allows tests to inject a preloaded index (memory or persistent). */
  indexEngine?: PersistentIndex;
  /** Allows tests to inject a custom job queue. */
  jobQueue?: JobQueue;
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
          }),
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
          new SearxngProvider({
            baseUrl: config.searxngBaseUrl ?? "http://localhost:8888",
          }),
        );
      }
      return new SearchOrchestrator(providers, {
        maxProviderConcurrency: config.providerConcurrency,
      });
    })();

  const searchCache = new TTLCache<SearchResponse>(
    config.searchCacheTtlMs,
    config.searchCacheMaxEntries,
  );

  // Anonymous-tier rate limiter keyed by remote address.
  const rateLimiter = new TokenBucketRateLimiter(
    config.anonymousRateLimitPerMinute,
    config.anonymousRateLimitPerMinute / 60,
  );

  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", 'req.headers["x-api-key"]'],
    },
    bodyLimit: 256 * 1024, // 256 KiB request cap
    requestIdHeader: "x-request-id",
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
  // DB-backed key store: when DATABASE_URL is configured, hashed keys
  // from Postgres authorize alongside env keys (env keys stay for
  // break-glass access). Usage events persist for /v1/usage summaries.
  const apiKeyStore = config.databaseUrl
    ? connectStores(config.databaseUrl).apiKeyStore
    : undefined;
  const usageStore = config.databaseUrl
    ? connectStores(config.databaseUrl).usageStore
    : undefined;
  let dbKeyHashes: ReadonlySet<string> | null = null;
  if (apiKeyStore) {
    void apiKeyStore
      .load()
      .then((records) => {
        dbKeyHashes = new Set(
          records.filter((r) => !r.revoked).map((r) => r.hash),
        );
      })
      .catch((err) => {
        console.warn(
          `[auth] key store load failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  app.addHook("onRequest", async (request) => {
    // Health endpoints are always public.
    const url = request.raw.url ?? "/";
    if (url === "/health" || url === "/ready" || url === "/metrics") return;

    const key =
      (request.headers["x-api-key"] as string | undefined) ??
      extractBearer(request.headers["authorization"]);
    const envValid = key !== undefined && config.apiKeys.includes(key);
    const dbValid =
      key !== undefined &&
      dbKeyHashes !== null &&
      dbKeyHashes.has(hashApiKey(key));
    const valid = envValid || dbValid;

    // /v1 routes enforce keys here. /search (Tavily-compat) may carry
    // the key in its JSON body per the Tavily contract, so its handler
    // performs the check — don't reject before the body is parsed.
    const isHeaderProtected = url.startsWith("/v1");
    if (
      isHeaderProtected &&
      (config.apiKeys.length > 0 || dbKeyHashes !== null) &&
      !valid
    ) {
      throw new UnauthorizedError("Missing or invalid API key");
    }
    // When no API keys are configured the API is open (local dev mode).
    // Rate limiting still applies.
    const rateKey =
      valid && key ? `key:${hashApiKey(key)}` : `ip:${request.ip}`;
    if (!rateLimiter.tryConsume(rateKey)) {
      const retryAfter = Math.ceil(
        rateLimiter.msUntilAvailable(rateKey) / 1000,
      );
      const err = new UnauthorizedError("Rate limit exceeded");
      // Attach retry hint via headers on the reply.
      request.headers["retry-after"] = String(retryAfter);
      throw Object.assign(err, {
        httpStatus: 429,
        code: "RATE_LIMITED",
      } as const);
    }
  });

  // Usage accounting (best-effort; failures never fail requests).
  app.addHook("onResponse", async (request, reply) => {
    if (!usageStore) return;
    const url = request.raw.url ?? "/";
    if (url === "/health" || url === "/ready" || url === "/metrics") return;
    if (!url.startsWith("/v1") && url !== "/search") return;
    const key = (request.headers["x-api-key"] as string | undefined) ?? null;
    usageStore
      .record({
        apiKeyHash: key ? hashApiKey(key) : null,
        route: url.split("?")[0]!,
        statusCode: reply.statusCode,
        durationMs: Math.max(0, Math.round(reply.elapsedTime ?? 0)),
      })
      .catch(() => {
        // Usage accounting is observability, not correctness.
      });
  });

  // --- Error normalization --------------------------------------------------
  app.setErrorHandler((err, request, reply) => {
    // Fastify schema violations arrive as FST_ERR_VALIDATION with
    // statusCode 400 — surface them as structured validation errors.
    const isFastifyValidation =
      typeof err === "object" &&
      err !== null &&
      "validation" in err &&
      "statusCode" in err;
    if (isFastifyValidation) {
      const validationErr = err as { statusCode: number; validation: unknown };
      return reply.code(validationErr.statusCode || 400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request failed schema validation",
          details: validationErr.validation,
          requestId: request.id,
        },
      });
    }
    const { error, status } = toSafeError(err, request.id);
    if (status >= 500) {
      request.log.error({ err }, "internal error");
    } else {
      request.log.warn(
        { message: String((err as Error)?.message ?? err) },
        "request failed",
      );
    }
    const retryAfter = (err as { retryAfter?: string }).retryAfter;
    if (retryAfter) reply.header("retry-after", retryAfter);
    reply.code(status).send({ error, requestId: request.id });
  });

  // --- Health ---------------------------------------------------------------
  app.get("/health", async () => ({ status: "ok", version: "0.1.0" }));

  app.get("/ready", async () => {
    const health = orchestrator.getProviderHealth();
    const anyConfigured = health.some((h) => h.configured);
    return {
      status: anyConfigured ? "ready" : "degraded",
      providers: health.map((h) => ({
        name: h.name,
        configured: h.configured,
        state: h.state,
      })),
      cache: searchCache.stats(),
    };
  });

  app.get("/metrics", async () => {
    const s = searchCache.stats();
    return [
      "# HELP querynx_cache_hits Total cache hits",
      "# TYPE querynx_cache_hits counter",
      `querynx_cache_hits ${s.hits}`,
      "# HELP querynx_cache_misses Total cache misses",
      "# TYPE querynx_cache_misses counter",
      `querynx_cache_misses ${s.misses}`,
      "# HELP querynx_cache_entries Current cache entries",
      "# TYPE querynx_cache_entries gauge",
      `querynx_cache_entries ${s.size}`,
      "# HELP querynx_cache_stampedes_prevented Coalesced duplicate lookups",
      "# TYPE querynx_cache_stampedes_prevented counter",
      `querynx_cache_stampedes_prevented ${s.stampedesPrevented}`,
    ].join("\n");
  });

  // --- v1/search ------------------------------------------------------------
  const searchSchema = {
    body: {
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1, maxLength: 500 },
        maxResults: { type: "integer", minimum: 1, maximum: 50 },
        includeDomains: {
          type: "array",
          items: { type: "string" },
          maxItems: 20,
        },
        excludeDomains: {
          type: "array",
          items: { type: "string" },
          maxItems: 20,
        },
        language: { type: "string", maxLength: 10 },
        region: { type: "string", maxLength: 10 },
        freshness: {
          type: "string",
          enum: ["any", "day", "week", "month", "year"],
        },
        category: {
          type: "string",
          enum: ["web", "news", "academic", "code", "docs"],
        },
        providers: { type: "array", items: { type: "string" }, maxItems: 10 },
      },
    },
  } as const;

  app.post("/v1/search", { schema: searchSchema }, async (request, reply) => {
    const body = request.body as {
      query: string;
      maxResults?: number;
      includeDomains?: string[];
      excludeDomains?: string[];
      language?: string;
      region?: string;
      freshness?: SearchQuery["freshness"];
      category?: SearchQuery["category"];
      providers?: string[];
    };

    const query: SearchQuery = {
      query: body.query.trim(),
      maxResults: body.maxResults ?? 10,
      includeDomains: body.includeDomains,
      excludeDomains: body.excludeDomains,
      language: body.language,
      region: body.region,
      freshness: body.freshness ?? "any",
      category: body.category ?? "web",
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
    const fromCache =
      Date.now() - started < 2 && response.diagnostics.cacheHit !== false;

    reply.header("x-querynx-cache", fromCache ? "hit" : "miss");
    return { ...response, requestId: request.id };
  });

  // --- v1/extract -------------------------------------------------------------
  app.post(
    "/v1/extract",
    {
      schema: {
        body: {
          type: "object",
          required: ["urls"],
          properties: {
            urls: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              maxItems: 10,
            },
            format: { type: "string", enum: ["markdown", "html", "text"] },
            includeLinks: { type: "boolean" },
            includeTables: { type: "boolean" },
            includeMetadata: { type: "boolean" },
            maxContentLength: {
              type: "integer",
              minimum: 1000,
              maximum: 500_000,
            },
            timeoutMs: { type: "integer", minimum: 1000, maximum: 60_000 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const body = request.body as {
        urls: string[];
        format?: "markdown" | "html" | "text";
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
        if (!isSafeOutboundUrl(url))
          throw new ValidationError(`Blocked URL target: ${raw}`);
        canonical.push(url);
      }

      const results = await Promise.all(
        canonical.map(async (url) => {
          try {
            const fetched = await fetchUrl(url, {
              timeoutMs: body.timeoutMs ?? 15_000,
              maxBytes: 5 * 1024 * 1024,
            });
            const document = extractDocument(
              fetched.body,
              fetched.url,
              fetched.statusCode,
              {
                format: body.format ?? "markdown",
                includeLinks: body.includeLinks ?? false,
                includeTables: body.includeTables ?? false,
                includeMetadata: body.includeMetadata ?? true,
                maxContentLength: body.maxContentLength ?? 200_000,
              },
            );
            return { url, ok: true, document };
          } catch (err) {
            return {
              url,
              ok: false,
              error: err instanceof Error ? err.message : "extraction failed",
            };
          }
        }),
      );

      return {
        results,
        generatedAt: new Date().toISOString(),
        requestId: request.id,
      };
    },
  );

  // --- Tavily-compatible surface: POST /search (drop-in) ------------------------
  app.post(
    "/search",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: true,
          required: ["query"],
          properties: {
            api_key: { type: "string" },
            query: { type: "string", minLength: 1, maxLength: 400 },
            search_depth: { type: "string", enum: ["basic", "advanced"] },
            topic: { type: "string", enum: ["general", "news"] },
            max_results: { type: "integer", minimum: 1, maximum: 20 },
            include_answer: { type: "boolean" },
            include_raw_content: { type: "boolean" },
            include_domains: {
              type: "array",
              items: { type: "string" },
              maxItems: 20,
            },
            exclude_domains: {
              type: "array",
              items: { type: "string" },
              maxItems: 20,
            },
            time_range: {
              type: "string",
              enum: ["day", "week", "month", "year"],
            },
          },
        },
      },
    },
    async (request, reply) => {
      // Tavily clients send the key in the body OR the Authorization
      // header. Enforce the same auth policy as the native API.
      const body = request.body as {
        api_key?: string;
        query: string;
        search_depth?: "basic" | "advanced";
        topic?: "general" | "news";
        max_results?: number;
        include_answer?: boolean;
        include_raw_content?: boolean;
        include_domains?: string[];
        exclude_domains?: string[];
        time_range?: "day" | "week" | "month" | "year";
      };

      if (config.apiKeys.length > 0) {
        const headerKey =
          (request.headers["x-api-key"] as string | undefined) ??
          (request.headers["authorization"] as string | undefined)?.replace(
            /^Bearer\s+/i,
            "",
          );
        const key = body.api_key ?? headerKey;
        if (!key || !config.apiKeys.includes(key)) {
          reply.code(401).send({
            detail:
              "Invalid or missing API key. " +
              'Pass it as "api_key" in the body or as the Authorization header.',
          });
          return reply;
        }
      }

      const started = Date.now();
      const response = await executeTavilySearch(orchestrator, {
        query: body.query,
        search_depth: body.search_depth,
        topic: body.topic,
        max_results: body.max_results,
        include_answer: body.include_answer,
        include_domains: body.include_domains,
        exclude_domains: body.exclude_domains,
        time_range: body.time_range,
      });
      return {
        ...response,
        response_time: Number(((Date.now() - started) / 1000).toFixed(2)),
      };
    },
  );

  // --- v1/providers ------------------------------------------------------------
  app.get("/v1/providers", async () => ({
    providers: orchestrator.getProviderHealth(),
  }));

  // --- v1/search/stream (SSE) ---------------------------------------------------
  app.post(
    "/v1/search/stream",
    { schema: searchSchema },
    async (request, reply) => {
      const body = request.body as {
        query: string;
        maxResults?: number;
        includeDomains?: string[];
        excludeDomains?: string[];
        language?: string;
        region?: string;
        freshness?: SearchQuery["freshness"];
        category?: SearchQuery["category"];
        providers?: string[];
      };

      const query: SearchQuery = {
        query: body.query.trim(),
        maxResults: body.maxResults ?? 10,
        includeDomains: body.includeDomains,
        excludeDomains: body.excludeDomains,
        language: body.language,
        region: body.region,
        freshness: body.freshness ?? "any",
        category: body.category ?? "web",
      };

      // SSE setup: no compression, no buffering, explicit event framing.
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });

      const send = (event: string, data: unknown) => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      // Client disconnect cancels the in-flight provider work. The
      // signal must be the RESPONSE socket: the request stream closes
      // after the body ends (keep-alive POSTs), which would abort the
      // search immediately.
      const disconnect = new AbortController();
      reply.raw.on("close", () => disconnect.abort());

      send("start", { requestId: request.id, query: query.query });

      try {
        const response = await orchestrator.search(query, {
          providers: body.providers,
          signal: disconnect.signal,
          onProviderResult: (provider, results) => {
            send("partial", { provider, count: results.length });
          },
        });
        send("results", {
          results: response.results,
          diagnostics: response.diagnostics,
        });
        send("done", { requestId: request.id });
      } catch (err) {
        send("error", {
          message: err instanceof Error ? err.message : "search failed",
        });
      }
      reply.raw.end();
      return reply;
    },
  );

  // --- v1/research/stream (SSE) ----------------------------------------------------
  app.post(
    "/v1/research/stream",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["objective"],
          properties: {
            objective: { type: "string", minLength: 3, maxLength: 1000 },
            mode: {
              type: "string",
              enum: [
                "fast",
                "standard",
                "advanced",
                "deep",
                "academic",
                "technical",
                "documentation",
              ],
            },
            maxQueries: { type: "integer", minimum: 1, maximum: 20 },
            maxPages: { type: "integer", minimum: 1, maximum: 50 },
            timeMs: { type: "integer", minimum: 1000, maximum: 600_000 },
            webhook: { type: "string", maxLength: 2048 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        objective: string;
        mode?: keyof typeof MODE_BUDGETS;
        maxQueries?: number;
        maxPages?: number;
        timeMs?: number;
        webhook?: string;
      };
      if (body.webhook && !validWebhookTarget(body.webhook)) {
        throw new ValidationError(`Webhook target rejected: ${body.webhook}`);
      }

      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });

      const send = (event: string, data: unknown) => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      const disconnect = new AbortController();
      reply.raw.on("close", () => disconnect.abort());

      send("start", { requestId: request.id, objective: body.objective });

      const engine = new ResearchEngine();
      try {
        const report = await engine.research(body.objective, {
          mode: body.mode ?? "standard",
          budgetOverrides: {
            ...(body.maxQueries ? { maxQueries: body.maxQueries } : {}),
            ...(body.maxPages ? { maxPages: body.maxPages } : {}),
            ...(body.timeMs ? { timeMs: body.timeMs } : {}),
          },
          search: async (queryText, maxResults) => {
            const r = await orchestrator.search({
              query: queryText,
              maxResults,
              freshness: "any",
              category: "web",
            });
            return r.results;
          },
          extractContent: async (url) => {
            try {
              const fetched = await fetchUrl(url, {
                timeoutMs: 10_000,
                maxBytes: 2 * 1024 * 1024,
              });
              if (fetched.statusCode !== 200) return null;
              const doc = extractDocument(
                fetched.body,
                fetched.url,
                fetched.statusCode,
              );
              return {
                title: doc.title ?? url,
                content: doc.content,
                publishedAt: doc.metadata?.publishedAt,
              };
            } catch {
              return null;
            }
          },
          onEvent: (event) => {
            if (event.type === "completed") return; // sent explicitly below
            send(event.type, event as Record<string, unknown>);
          },
          signal: disconnect.signal,
        });
        send("completed", { report });
      } catch (err) {
        send("error", {
          message: err instanceof Error ? err.message : "research failed",
        });
      }
      reply.raw.end();
      return reply;
    },
  );

  // --- v1/search/batch ---------------------------------------------------------
  app.post(
    "/v1/search/batch",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["queries"],
          properties: {
            queries: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              items: { type: "string", minLength: 1, maxLength: 500 },
            },
            maxResults: { type: "integer", minimum: 1, maximum: 50 },
          },
        },
      },
    },
    async (request) => {
      const body = request.body as { queries: string[]; maxResults?: number };
      const maxResults = body.maxResults ?? 5;

      // Queries run under the orchestrator's own concurrency limits;
      // the batch endpoint itself is a bounded fan-out.
      const responses = await Promise.all(
        body.queries.map(async (queryText) => {
          const query: SearchQuery = {
            query: queryText.trim(),
            maxResults,
            freshness: "any",
            category: "web",
          };
          const cacheKey = searchCacheKey({
            query: query.query,
            maxResults,
            freshness: "any",
            category: "web",
          });
          try {
            const response = await searchCache.getOrCompute(
              cacheKey,
              async () => {
                const r = await orchestrator.search(query);
                return {
                  ...r,
                  diagnostics: { ...r.diagnostics, cacheHit: false },
                };
              },
            );
            return { ok: true, ...response };
          } catch (err) {
            return {
              query: queryText,
              ok: false,
              error: err instanceof Error ? err.message : "search failed",
            };
          }
        }),
      );
      return {
        responses,
        generatedAt: new Date().toISOString(),
        requestId: request.id,
      };
    },
  );

  // --- v1/research ---------------------------------------------------------------
  app.post(
    "/v1/research",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["objective"],
          properties: {
            objective: { type: "string", minLength: 3, maxLength: 1000 },
            mode: {
              type: "string",
              enum: [
                "fast",
                "standard",
                "advanced",
                "deep",
                "academic",
                "technical",
                "documentation",
              ],
            },
            maxQueries: { type: "integer", minimum: 1, maximum: 20 },
            maxPages: { type: "integer", minimum: 1, maximum: 50 },
            timeMs: { type: "integer", minimum: 1000, maximum: 600_000 },
            webhook: { type: "string", maxLength: 2048 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        objective: string;
        mode?: keyof typeof MODE_BUDGETS;
        maxQueries?: number;
        maxPages?: number;
        timeMs?: number;
        webhook?: string;
      };
      if (body.webhook && !validWebhookTarget(body.webhook)) {
        throw new ValidationError(`Webhook target rejected: ${body.webhook}`);
      }

      const engine = new ResearchEngine();
      const events: ResearchEvent[] = [];

      const report = await engine.research(body.objective, {
        mode: body.mode ?? "standard",
        budgetOverrides: {
          ...(body.maxQueries ? { maxQueries: body.maxQueries } : {}),
          ...(body.maxPages ? { maxPages: body.maxPages } : {}),
          ...(body.timeMs ? { timeMs: body.timeMs } : {}),
        },
        search: async (queryText, maxResults) => {
          const r = await orchestrator.search({
            query: queryText,
            maxResults,
            freshness: "any",
            category: "web",
          });
          return r.results;
        },
        extractContent: async (url) => {
          try {
            const fetched = await fetchUrl(url, {
              timeoutMs: 10_000,
              maxBytes: 2 * 1024 * 1024,
            });
            if (fetched.statusCode !== 200) return null;
            const doc = extractDocument(
              fetched.body,
              fetched.url,
              fetched.statusCode,
            );
            return {
              title: doc.title ?? url,
              content: doc.content,
              publishedAt: doc.metadata?.publishedAt,
            };
          } catch {
            return null;
          }
        },
        onEvent: (event) => events.push(event),
      });

      reply.header("x-querynx-research-termination", report.termination);

      // Best-effort webhook delivery after the caller has the report.
      if (body.webhook) {
        void deliverWebhook(
          {
            url: body.webhook,
            event: "research.completed",
            payload: {
              objective: body.objective,
              report,
            },
            requestId: request.id,
          },
          { secret: process.env["QUERYNX_WEBHOOK_SECRET"] },
        ).then((result) => {
          request.log.info(
            { webhook: result.url, ok: result.ok, attempts: result.attempts },
            "webhook delivery finished",
          );
        });
      }
      return { report, events, requestId: request.id };
    },
  );

  // --- Native index: ingest and search the local corpus -----------------------
  // Postgres durability when DATABASE_URL is configured; memory otherwise.
  const persistentIndex =
    deps.indexEngine ??
    new PersistentIndex({
      memoryEngine: new MemorySearchEngine(),
      ...(config.databaseUrl
        ? { documentStore: connectStores(config.databaseUrl).documentStore }
        : {}),
    });
  // Boot rehydration is fire-and-forget on purpose: the API serves
  // immediately while the corpus warms into memory.
  void persistentIndex.rehydrate().catch((err) => {
    console.warn(
      `[persistence] rehydrate failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  const indexEngine = persistentIndex.engine;

  // --- v1/answer: grounded answer with citations -------------------------------
  // LLM-optional: without a configured model the answer is a faithful
  // extractive summary of the retrieved evidence; with one, the model
  // synthesizes under the anti-injection wrapper. Either way the
  // response carries citations and provenance.
  const llmClient = createLlmClient({
    baseUrl: process.env["LLM_BASE_URL"],
    apiKey: process.env["LLM_API_KEY"],
    model: process.env["LLM_MODEL"],
    fallbackModel: process.env["LLM_FALLBACK_MODEL"],
    fallbackBaseUrl: process.env["LLM_FALLBACK_BASE_URL"],
  });

  app.post(
    "/v1/answer",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["question"],
          properties: {
            question: { type: "string", minLength: 3, maxLength: 500 },
            maxResults: { type: "integer", minimum: 1, maximum: 20 },
            includeDomains: {
              type: "array",
              items: { type: "string" },
              maxItems: 20,
            },
            excludeDomains: {
              type: "array",
              items: { type: "string" },
              maxItems: 20,
            },
          },
        },
      },
    },
    async (request) => {
      const body = request.body as {
        question: string;
        maxResults?: number;
        includeDomains?: string[];
        excludeDomains?: string[];
      };

      // Retrieve supporting evidence through the federated pipeline.
      const searchResponse = await orchestrator.search({
        query: body.question,
        maxResults: body.maxResults ?? 5,
        includeDomains: body.includeDomains,
        excludeDomains: body.excludeDomains,
        freshness: "any",
        category: "web",
      });

      const evidence = searchResponse.results;
      const citations = evidence.map((r, i) => ({
        index: i + 1,
        title: r.title,
        url: r.url,
        snippet: r.snippet.slice(0, 300),
      }));

      let answer: string;
      let synthesized = false;
      if (llmClient && evidence.length > 0) {
        try {
          const grounded = await llmClient.completeWebGrounded(
            `Answer the operator's question using ONLY the provided web content. Cite sources by their [n] index. Question: ${body.question}`,
            evidence
              .map((r, i) => `[${i + 1}] ${r.title} (${r.url})\n${r.snippet}`)
              .join("\n\n"),
            { task: "answer" },
          );
          answer = grounded.content;
          synthesized = true;
        } catch {
          answer = extractiveAnswer(body.question, evidence);
        }
      } else {
        answer = extractiveAnswer(body.question, evidence);
      }

      return {
        answer,
        synthesized,
        citations,
        evidenceCount: evidence.length,
        question: body.question,
        generatedAt: new Date().toISOString(),
        requestId: request.id,
      };
    },
  );

  // --- v1/rerank: rerank passages/candidates against a query ---------------------
  // Deterministic by default: BM25-style term scoring over the provided
  // documents. With a model configured, the LLM judges relevance —
  // but the deterministic score always ships alongside.
  app.post(
    "/v1/rerank",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["query", "documents"],
          properties: {
            query: { type: "string", minLength: 1, maxLength: 500 },
            documents: {
              type: "array",
              minItems: 1,
              maxItems: 50,
              items: { type: "string", maxLength: 5000 },
            },
            topN: { type: "integer", minimum: 1, maximum: 50 },
            useModel: { type: "boolean" },
          },
        },
      },
    },
    async (request) => {
      const body = request.body as {
        query: string;
        documents: string[];
        topN?: number;
        useModel?: boolean;
      };
      const topN = body.topN ?? body.documents.length;

      // Deterministic relevance: term-overlap scoring.
      const queryTerms = body.query
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 1);
      const scored = body.documents.map((doc, i) => {
        const docLower = doc.toLowerCase();
        let hits = 0;
        for (const term of queryTerms) {
          if (docLower.includes(term)) hits++;
        }
        const relevance =
          queryTerms.length === 0
            ? 0
            : Number((hits / queryTerms.length).toFixed(4));
        return {
          index: i,
          document: doc,
          relevance,
          modelScore: null as number | null,
        };
      });
      scored.sort((a, b) => b.relevance - a.relevance);

      // Optional model judgment — appended, never replacing the
      // deterministic score (§10: models are not basic ranking).
      if (llmClient && body.useModel) {
        try {
          const verdict = await llmClient.completeJson<{
            scores?: number[];
          }>(
            [
              {
                role: "system",
                content: ANTI_INJECTION_SYSTEM,
              },
              {
                role: "user",
                content:
                  `Score each document's relevance to the query on 0-1. Reply ONLY with JSON: {"scores":[...]}. ` +
                  `Query: ${body.query}\n\n` +
                  wrapUntrustedContent(
                    body.documents
                      .map((d, i) => `[${i}] ${d.slice(0, 1000)}`)
                      .join("\n\n"),
                  ),
              },
            ],
            { task: "evidence-analysis" },
          );
          if (
            verdict?.scores &&
            verdict.scores.length === body.documents.length
          ) {
            for (const entry of scored) {
              entry.modelScore = Number(verdict.scores[entry.index]);
            }
            scored.sort(
              (a, b) =>
                (b.modelScore ?? 0) - (a.modelScore ?? 0) ||
                b.relevance - a.relevance,
            );
          }
        } catch {
          // Model rerank is best-effort; deterministic order stands.
        }
      }

      const results = scored.slice(0, topN).map((entry) => ({
        index: entry.index,
        document: entry.document,
        relevance: entry.relevance,
        ...(entry.modelScore !== null ? { modelScore: entry.modelScore } : {}),
      }));

      return {
        results,
        usedModel: llmClient !== null && body.useModel === true,
        query: body.query,
        requestId: request.id,
      };
    },
  );

  // --- v1/extract/batch: higher-volume extraction -------------------------------
  app.post(
    "/v1/extract/batch",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["urls"],
          properties: {
            urls: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              maxItems: 50,
            },
            format: { type: "string", enum: ["markdown", "html", "text"] },
            maxContentLength: {
              type: "integer",
              minimum: 1000,
              maximum: 500_000,
            },
            timeoutMs: { type: "integer", minimum: 1000, maximum: 60_000 },
          },
        },
      },
    },
    async (request) => {
      const body = request.body as {
        urls: string[];
        format?: "markdown" | "html" | "text";
        maxContentLength?: number;
        timeoutMs?: number;
      };

      const canonical: string[] = [];
      for (const raw of body.urls) {
        const url = canonicalizeUrl(raw);
        if (!url) throw new ValidationError(`Invalid URL: ${raw}`);
        if (!isSafeOutboundUrl(url)) {
          throw new ValidationError(`Blocked URL target: ${raw}`);
        }
        canonical.push(url);
      }

      // Bounded concurrency across the batch (§6): 4-wide.
      const results = await mapWithConcurrency(canonical, 4, async (url) => {
        try {
          const fetched = await fetchUrl(url, {
            timeoutMs: body.timeoutMs ?? 15_000,
            maxBytes: 5 * 1024 * 1024,
          });
          const document = extractDocument(
            fetched.body,
            fetched.url,
            fetched.statusCode,
            {
              format: body.format ?? "markdown",
              maxContentLength: body.maxContentLength ?? 200_000,
            },
          );
          return { url, ok: true, document };
        } catch (err) {
          return {
            url,
            ok: false,
            error: err instanceof Error ? err.message : "extraction failed",
          };
        }
      });

      return {
        results,
        generatedAt: new Date().toISOString(),
        requestId: request.id,
      };
    },
  );

  // --- v1/crawl: start a crawl job (async via the queue) -------------------------
  app.post(
    "/v1/crawl",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["seeds"],
          properties: {
            seeds: {
              type: "array",
              items: { type: "string", maxLength: 2048 },
              minItems: 1,
              maxItems: 10,
            },
            collection: { type: "string", maxLength: 100 },
            maxDepth: { type: "integer", minimum: 0, maximum: 5 },
            maxPages: { type: "integer", minimum: 1, maximum: 200 },
            allowedDomains: {
              type: "array",
              items: { type: "string" },
              maxItems: 10,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        seeds: string[];
        collection?: string;
        maxDepth?: number;
        maxPages?: number;
        allowedDomains?: string[];
      };

      // Validate seeds before enqueueing.
      for (const seed of body.seeds) {
        const url = canonicalizeUrl(seed);
        if (!url) throw new ValidationError(`Invalid seed: ${seed}`);
        if (!isSafeOutboundUrl(url)) {
          throw new ValidationError(`Blocked seed target: ${seed}`);
        }
      }

      const job = await jobBridge.submit(
        "crawl",
        {
          seeds: body.seeds,
          collection: body.collection ?? "crawled",
          maxDepth: body.maxDepth ?? 1,
          maxPages: body.maxPages ?? 20,
          allowedDomains: body.allowedDomains,
        },
        0,
      );
      reply.code(202);
      return { job, requestId: request.id };
    },
  );

  // --- v1/map: discover a site's URL structure ------------------------------------
  // Fetches the sitemap(s) plus a bounded shallow crawl and returns
  // the site's URL inventory — no content extraction, just the map.
  app.post(
    "/v1/map",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["url"],
          properties: {
            url: { type: "string", maxLength: 2048 },
            limit: { type: "integer", minimum: 1, maximum: 500 },
            includeSitemap: { type: "boolean" },
          },
        },
      },
    },
    async (request) => {
      const body = request.body as {
        url: string;
        limit?: number;
        includeSitemap?: boolean;
      };
      const target = canonicalizeUrl(body.url);
      if (!target) throw new ValidationError(`Invalid URL: ${body.url}`);
      if (!isSafeOutboundUrl(target)) {
        throw new ValidationError(`Blocked URL target: ${body.url}`);
      }

      const limit = body.limit ?? 100;
      const origin = new URL(target).origin;
      const discovered = new Set<string>([target]);
      const baseDomain = extractDomain(target);

      // Sitemap discovery first.
      if (body.includeSitemap !== false) {
        try {
          const sitemapUrls = await fetchSitemapUrls(
            `${origin}/sitemap.xml`,
            USER_AGENT,
          );
          for (const url of sitemapUrls) {
            if (discovered.size >= limit) break;
            if (extractDomain(url) === baseDomain) discovered.add(url);
          }
        } catch {
          // Sitemaps are best-effort.
        }
      }

      // Bounded shallow crawl for link discovery (depth 1, no extraction).
      try {
        const engine = new CrawlEngine();
        const report = await engine.crawl(
          {
            seeds: [target],
            maxDepth: 1,
            maxPages: Math.min(10, limit),
            strategy: "breadth-first",
            respectRobots: true,
            perDomainDelayMs: 500,
            dedupeByContent: false,
          },
          { userAgent: USER_AGENT, maxConcurrency: 2 },
        );
        for (const page of report.pages) {
          if (discovered.size >= limit) break;
          if (extractDomain(page.url) === baseDomain) discovered.add(page.url);
          if (page.document) {
            for (const link of page.document.links) {
              if (discovered.size >= limit) break;
              if (extractDomain(link.url) === baseDomain)
                discovered.add(link.url);
            }
          }
        }
      } catch {
        // Crawl failures leave the sitemap results standing.
      }

      const urls = [...discovered].slice(0, limit);
      return {
        base: target,
        discoveredCount: discovered.size,
        urls,
        generatedAt: new Date().toISOString(),
        requestId: request.id,
      };
    },
  );

  // --- GET /v1/jobs/:id/stream: SSE job progress --------------------------------
  app.get("/v1/jobs/:id/stream", async (request, reply) => {
    const { id } = request.params as { id: string };

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const disconnect = new AbortController();
    reply.raw.on("close", () => disconnect.abort());

    send("start", { requestId: request.id, jobId: id });

    // Poll the job at 500ms until terminal or client disconnects.
    for (let tick = 0; tick < 600; tick++) {
      if (disconnect.signal.aborted) break;
      const job = await jobBridge.get(id);
      if (!job) {
        send("error", { message: `no job ${id}` });
        break;
      }
      send("status", {
        status: job.status,
        error: job.error,
        ...(job.result ? { result: job.result } : {}),
      });
      if (["completed", "failed", "cancelled"].includes(job.status)) {
        send("done", { status: job.status });
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    reply.raw.end();
    return reply;
  });

  // --- v1/usage: request accounting (Postgres-backed) ---------------------------
  app.get("/v1/usage", async (request) => {
    if (!usageStore) {
      return {
        usage: {
          totalRequests: 0,
          byRoute: {} as Record<string, number>,
          p95DurationMs: 0,
        },
        persistent: false,
        requestId: request.id,
      };
    }
    try {
      const summary = await usageStore.summary(24);
      return { usage: summary, persistent: true, requestId: request.id };
    } catch (err) {
      return {
        usage: {
          totalRequests: 0,
          byRoute: {} as Record<string, number>,
          p95DurationMs: 0,
        },
        persistent: true,
        error: err instanceof Error ? err.message : "usage query failed",
        requestId: request.id,
      };
    }
  });

  // --- v1/jobs: async job submission over the queue ------------------------------
  // The in-process queue powers crawl/index/research as durable async
  // jobs: submit, poll, cancel. The Postgres JobStore (SKIP LOCKED)
  // drops in for multi-worker deployments when DATABASE_URL is set.
  const jobQueue = deps.jobQueue ?? new JobQueue({ concurrency: 2 });
  registerApiJobHandlers({ queue: jobQueue, index: persistentIndex });
  // Delegation: with DATABASE_URL + QUERYNX_DELEGATE_JOBS=1, submitted
  // jobs persist for fleet workers instead of running in-process.
  const dbStores = config.databaseUrl
    ? connectStores(config.databaseUrl)
    : undefined;
  const jobBridge = new JobBridge({
    queue: jobQueue,
    ...(config.databaseUrl && process.env["QUERYNX_DELEGATE_JOBS"] === "1"
      ? { store: makeDelegatingStore(dbStores!.jobStore) }
      : {}),
  });

  app.post(
    "/v1/jobs",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["type", "payload"],
          properties: {
            type: { type: "string", enum: ["crawl", "index", "research"] },
            payload: { type: "object", additionalProperties: true },
            priority: { type: "integer", minimum: 0, maximum: 10 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        type: "crawl" | "index" | "research";
        payload: Record<string, unknown>;
        priority?: number;
      };
      // Validate payload shape per type before enqueueing.
      if (body.type === "crawl" && !Array.isArray(body.payload["seeds"])) {
        throw new ValidationError("crawl jobs require payload.seeds");
      }
      if (body.type === "index" && typeof body.payload["url"] !== "string") {
        throw new ValidationError("index jobs require payload.url");
      }
      if (
        body.type === "research" &&
        (typeof body.payload["objective"] !== "string" ||
          String(body.payload["objective"]).length < 3)
      ) {
        throw new ValidationError("research jobs require payload.objective");
      }

      const job = await jobBridge.submit(
        body.type,
        body.payload,
        body.priority ?? 0,
      );
      reply.code(202);
      return { job, requestId: request.id };
    },
  );

  app.get("/v1/jobs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = jobQueue.get(id);
    if (!job) {
      reply.code(404);
      return {
        error: { code: "NOT_FOUND", message: `no job ${id}` },
        requestId: request.id,
      };
    }
    return { job: serializeJob(job), requestId: request.id };
  });

  app.delete("/v1/jobs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const cancelled = jobQueue.cancel(id);
    if (!cancelled) {
      reply.code(404);
      return {
        error: {
          code: "NOT_FOUND",
          message: `job ${id} not cancellable (missing or finished)`,
        },
        requestId: request.id,
      };
    }
    return { cancelled: true, requestId: request.id };
  });

  app.get("/v1/jobs", async (request) => ({
    stats: jobBridge.stats() ?? { delegated: true },
    deadLetters: jobQueue.deadLetters().slice(-20).map(serializeJob),
    delegated: jobBridge.delegated,
    requestId: request.id,
  }));

  /**
   * POST /v1/index — fetch a URL (or accept inline content), extract and
   * add it to the persistent local corpus. Returns the indexed document.
   */
  app.post(
    "/v1/index",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["collection"],
          properties: {
            collection: { type: "string", minLength: 1, maxLength: 100 },
            url: { type: "string", maxLength: 2048 },
            content: { type: "string", maxLength: 500_000 },
            title: { type: "string", maxLength: 500 },
          },
          anyOf: [{ required: ["url"] }, { required: ["content"] }],
        },
      },
    },
    async (request) => {
      const body = request.body as {
        collection: string;
        url?: string;
        content?: string;
        title?: string;
      };

      if (body.url) {
        const canonical = canonicalizeUrl(body.url);
        if (!canonical) throw new ValidationError(`Invalid URL: ${body.url}`);
        if (!isSafeOutboundUrl(canonical)) {
          throw new ValidationError(`Blocked URL target: ${body.url}`);
        }
        const fetched = await fetchUrl(canonical, {
          timeoutMs: 15_000,
          maxBytes: 5 * 1024 * 1024,
        });
        if (fetched.statusCode !== 200) {
          throw new ValidationError(
            `Fetch returned HTTP ${fetched.statusCode}`,
          );
        }
        const document = extractDocument(
          fetched.body,
          fetched.url,
          fetched.statusCode,
        );
        const indexed = await persistentIndex.index({
          ...fromExtractedDocument(document, body.collection),
        });
        return {
          document: indexed,
          stats: persistentIndex.stats(),
          requestId: request.id,
        };
      }

      // Inline content path: no fetch, direct ingest.
      const indexed = await persistentIndex.index({
        url: body.url ?? `inline://${request.id}`,
        title: body.title ?? "Untitled",
        content: body.content!,
        collection: body.collection,
        fingerprint: `inline-${request.id}`,
      });
      return {
        document: indexed,
        stats: persistentIndex.stats(),
        requestId: request.id,
      };
    },
  );

  /** GET /v1/index/stats — corpus statistics. */
  app.get("/v1/index/stats", async (request) => ({
    stats: persistentIndex.stats(),
    persistent: persistentIndex.persistent,
    requestId: request.id,
  }));

  /**
   * POST /v1/search/semantic — BM25 search over the local corpus.
   * (Vector search fuses in when embeddings are configured; the
   * retrieval contract is identical either way.)
   */
  app.post(
    "/v1/search/semantic",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: {
            query: { type: "string", minLength: 1, maxLength: 500 },
            collection: { type: "string", maxLength: 100 },
            limit: { type: "integer", minimum: 1, maximum: 50 },
            domains: { type: "array", items: { type: "string" }, maxItems: 20 },
            publishedAfter: { type: "string", maxLength: 40 },
          },
        },
      },
    },
    async (request) => {
      const body = request.body as {
        query: string;
        collection?: string;
        limit?: number;
        domains?: string[];
        publishedAfter?: string;
      };
      const hits: RetrievalHit[] = indexEngine.search({
        query: body.query,
        collection: body.collection,
        limit: body.limit ?? 10,
        domains: body.domains,
        publishedAfter: body.publishedAfter,
      });
      return {
        results: hits.map((hit) => ({
          title: hit.document.title,
          url: hit.document.url,
          snippet: hit.document.content.slice(0, 300),
          score: hit.score,
          provider: "querynx-index",
          matchedTerms: hit.matchedTerms,
          collection: hit.document.collection,
          publishedAt: hit.document.publishedAt,
        })),
        query: body.query,
        generatedAt: new Date().toISOString(),
        requestId: request.id,
      };
    },
  );

  return app;

  const USER_AGENT =
    "QuerynxBot/0.1 (+https://github.com/Suryanshu-Nabheet/Querynx)";

  function extractBearer(header: unknown): string | undefined {
    if (typeof header !== "string") return undefined;
    const match = header.match(/^Bearer\s+(.+)$/i);
    return match?.[1];
  }
}

/** Deterministic extractive answer: the honest no-model fallback.
 * Quotes the strongest evidence snippets with citations. */
function extractiveAnswer(
  question: string,
  evidence: ReadonlyArray<{ title: string; url: string; snippet: string }>,
): string {
  if (evidence.length === 0) {
    return `No supporting evidence was found for "${question}".`;
  }
  const parts = evidence
    .slice(0, 3)
    .map(
      (r, i) =>
        `According to ${r.title} [${i + 1}]: ${r.snippet.slice(0, 240)}`,
    );
  return `Answering "${question}" from retrieved evidence:\n\n${parts.join("\n\n")}`;
}
