# Changelog

Notable product changes. Format follows Keep a Changelog; versioning starts
at 0.1.0.

## [0.1.0] — Foundation

### Added
- Monorepo scaffold (pnpm workspaces, Turborepo, strict TypeScript, CI).
- `@querynx/types` — provider-agnostic search, extraction and crawl
  domain contracts.
- `@querynx/shared` — content fingerprinting (MinHash-style sketches),
  URL canonicalization and SSRF classification, bounded-concurrency
  primitives (`mapWithConcurrency`, `Semaphore`, `TokenBucketRateLimiter`),
  retry/backoff with jitter, circuit breaker, typed error taxonomy.
- `@querynx/fetcher` — SSRF-hardened fetching: validating DNS resolver
  (rebinding defense), per-hop redirect re-validation, byte caps,
  operator-controlled private-network opt-in.
- `@querynx/extractor` — Readability-based main-content extraction,
  JSON-LD/Open Graph/meta metadata, headings, links, tables, heading-aware
  sections, sentence chunking with token budgets and overlap.
- `@querynx/providers` — SearXNG (keyless default), Brave and Tavily
  adapters; federated orchestrator with Reciprocal Rank Fusion merging,
  cross-provider dedupe, per-provider circuit breakers, concurrency caps,
  cancellation and health snapshots.
- 80 unit tests across the foundation packages.

### Subsequent milestones (same 0.1.x line)

- **API platform**: Fastify service with API-key auth, token-bucket rate
  limiting, strict schema validation (hard-reject unknown properties),
  result cache with stampede protection; `/v1/search`, `/v1/search/batch`,
  `/v1/search/semantic`, `/v1/extract`, `/v1/index`, `/v1/research`,
  `/v1/providers`, `/health`, `/ready`, `/metrics`.
- **Crawler**: robots.txt compliance (REP group semantics, longest-match
  paths, crawl-delay), BFS/DFS/priority frontier with per-domain
  throttling and resumable state, sitemap discovery, content-dedupe.
- **Indexer**: Okapi BM25 inverted index with hybrid RRF retrieval over
  a pluggable vector store; native corpus ingest over the API.
- **Research engine**: bounded iterative retrieve→extract→rank→synthesize
  with mode budgets, cancellation, gap detection, evidence provenance and
  deterministic (LLM-free) synthesis with a pluggable model hook.
- **Integrations**: typed TypeScript SDK (retries, structured errors) and
  an MCP server exposing four agent tools, tested over the real protocol.
- **Ranking + evaluation**: weighted multi-signal ranking pipeline
  (relevance, freshness, diversity, domain preferences, corroboration)
  and a measured search-quality harness — MRR 0.88, Recall@10 1.0,
  NDCG@10 0.80 on the fixture corpus, with CI-enforced thresholds.
- 213 tests across 12 packages; CI green on GitHub Actions.

