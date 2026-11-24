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
| `apps/api` | `/v1/search`, `/v1/extract`, `/v1/providers`, health/metrics | 13 passing |

104 tests passing across the workspace. Live boot verified: server
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

1. `packages/crawler` — robots.txt parsing/caching, frontier, per-domain
   throttling, resumable state.
2. `packages/database` — Drizzle schema + migrations (documents, jobs,
   api keys, usage).
3. Batch search + SSE streaming endpoints.
4. `packages/indexer` — BM25 + vector hybrid retrieval.

