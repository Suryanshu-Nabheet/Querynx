# Querynx Roadmap

## Phase 1 — Foundation (complete)

- [x] Monorepo scaffold: pnpm workspaces, Turborepo, strict TypeScript
- [x] `packages/types`: search/extract/crawl domain contracts
- [x] `packages/shared`: fingerprinting, URL canonicalization + SSRF
      classification, bounded concurrency (mapWithConcurrency, Semaphore,
      TokenBucketRateLimiter), retry/backoff, circuit breaker, error taxonomy
- [x] `packages/fetcher`: validating DNS resolver, redirect re-validation,
      body size caps, operator private-network opt-in
- [x] `packages/extractor`: Readability extraction, JSON-LD/OG metadata,
      headings/links/tables, heading-aware sections, sentence chunking
- [x] `packages/providers`: SearXNG/Brave/Tavily adapters, federated
      orchestrator (RRF, cross-provider dedupe, breakers, health tracking)
- [x] CI: typecheck + tests on push

## Phase 2 — API platform (complete)

- [x] `packages/cache`: TTL result cache with stampede protection
- [x] `apps/api`: Fastify service — `/v1/search`, `/v1/search/batch`,
      `/v1/search/semantic`, `/v1/extract`, `/v1/index`, `/v1/research`,
      `/v1/providers`, `/health`, `/ready`, `/metrics` — API-key auth,
      rate limiting, strict schema validation
- [ ] `packages/database`: Drizzle schema + migrations (documents, jobs,
      api keys, usage)
- [ ] SSE streaming endpoints

## Phase 3 — Crawling and indexing (complete, in-memory)

- [x] `packages/crawler`: robots.txt, frontier, per-domain throttling,
      sitemaps, resumable crawl state
- [x] `packages/indexer`: BM25 engine + hybrid RRF retrieval
- [ ] `packages/queue`: BullMQ durable jobs
- [ ] Postgres/pgvector persistence for crawler + indexer

## Phase 4 — Research (complete, deterministic synthesis)

- [x] `packages/research`: bounded research orchestration with budgets,
      cancellation, evidence tracking, gap detection, pluggable model hook

## Phase 5 — Integrations (TypeScript + MCP complete)

- [x] TypeScript SDK with retries and typed errors
- [x] MCP server (search, extract, research, providers tools)
- [ ] Python SDK, CLI
- [ ] Tavily-compatible API surface
- [ ] Next.js developer dashboard
- [ ] OpenAPI spec and docs

## Phase 6 — Hardening and scale

- [ ] Security regression suite, benchmarks, Docker self-hosting,
      deployment documentation
