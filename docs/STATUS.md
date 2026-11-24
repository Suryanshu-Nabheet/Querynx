# Implementation Status

Last updated: 2026-11-24 (after API milestone)

## Validated and working

| Component | State | Tests |
|---|---|---|
| `packages/shared` | Complete (fingerprint, URL, concurrency, errors) | 37 passing |
| `packages/fetcher` | Complete (SSRF defense, redirects, size caps) | 18 passing |
| `packages/extractor` | Complete (readability, metadata, chunking) | 13 passing |
| `packages/providers` | Orchestrator complete; 3 adapters implemented | 12 passing |
| `packages/cache` | Complete (TTL, LRU, stampede protection) | 11 passing |
| `packages/crawler` | Complete (robots, frontier, engine, sitemaps) | 21 passing |
| `packages/indexer` | Complete (BM25 engine, hybrid RRF, vector store) | 24 passing |
| `apps/api` | search/extract/index/semantic + health/metrics | 17 passing |

153 tests passing across the workspace. Live boot verified: server
starts, reports honest provider state, degrades gracefully when the
configured SearXNG instance is unreachable.

## Known limitations

- Provider adapters have unit coverage at the orchestrator level but no
  live-network contract tests yet.
- No persistence layer yet — search/extraction are in-memory only.
- Extraction has no PDF support yet.
- API auth uses static env-provided keys; hashed-key store arrives with
  the database package.

## Next tasks (priority order)

1. Autonomous research engine — bounded iterative retrieve-rank-synthesize
   loop with budgets, cancellation and evidence tracking.
2. Batch search (`/v1/search/batch`) + SSE streaming of partial results.
3. `packages/database` — Drizzle schema + Postgres persistence for the
   in-memory engines (documents, jobs, api keys, usage).
4. Ranking evaluation harness (MRR/NDCG/Recall@K) with fixture datasets.

