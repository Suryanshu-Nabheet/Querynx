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

## Phase 2 — API and persistence (in progress)

- [ ] `packages/cache`: TTL result cache with stampede protection
- [ ] `apps/api`: Fastify service, `/v1/search`, `/v1/extract`,
      `/health`, `/ready`, API-key auth, rate limiting
- [ ] `packages/database`: Drizzle schema + migrations (documents, jobs,
      api keys, usage)
- [ ] Batch endpoints, SSE streaming

## Phase 3 — Crawling and indexing

- [ ] `packages/crawler`: robots.txt, frontier, per-domain throttling,
      sitemaps, persistent resumable crawls
- [ ] `packages/indexer`: BM25 + pgvector hybrid retrieval over the
      extracted corpus
- [ ] `packages/queue`: BullMQ durable jobs

## Phase 4 — Ranking and research

- [ ] `packages/ranking`: configurable ranking pipeline, evaluation
      harness (MRR/NDCG/Recall@K)
- [ ] `packages/research`: bounded research orchestration with budgets,
      cancellation, evidence tracking

## Phase 5 — Integrations and dashboard

- [ ] TypeScript + Python SDKs, CLI, MCP server
- [ ] Tavily-compatible API surface
- [ ] Next.js developer dashboard
- [ ] OpenAPI spec and docs

## Phase 6 — Hardening and scale

- [ ] Security regression suite, benchmarks, Docker self-hosting,
      deployment documentation
