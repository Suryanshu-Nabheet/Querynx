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
