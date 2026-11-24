# Implementation Status

Last updated: 2026-11-24 (after integrations milestone)

## Validated and working

| Component | State | Tests |
|---|---|---|
| `packages/shared` | Complete (fingerprint, URL, concurrency, errors) | 37 passing |
| `packages/fetcher` | Complete (SSRF defense, redirects, size caps) | 18 passing |
| `packages/extractor` | Complete (readability, metadata, chunking) | 13 passing |
| `packages/providers` | Complete (orchestrator + 3 adapters) | 12 passing |
| `packages/cache` | Complete (TTL, LRU, stampede protection) | 11 passing |
| `packages/crawler` | Complete (robots, frontier, engine, sitemaps) | 21 passing |
| `packages/indexer` | Complete (BM25 engine, hybrid RRF, vector store) | 24 passing |
| `packages/research` | Complete (bounded engine, planner, evidence) | 12 passing |
| `apps/api` | search, search/batch, search/semantic, extract, index, research, providers, health/metrics | 22 passing |
| `sdk/typescript` | Complete (typed client, retries, error surface) | 5 passing |
| `integrations/mcp` | Complete (4 tools, stdio + in-memory transports) | 6 passing |

186 tests passing across the workspace; CI green on GitHub Actions
(Linux runner) for install + typecheck + full test suite.

## Known limitations

- Provider adapters have unit coverage at the orchestrator level but no
  live-network contract tests yet.
- No persistence layer yet — index, cache and crawl state are
  in-memory; restart loses them. Postgres/Drizzle schema is next.
- Extraction has no PDF support yet.
- API auth uses static env-provided keys; hashed-key store arrives with
  the database package.
- SSE streaming of research progress is not yet wired (events are
  returned in the response body today).

## Next tasks (priority order)

1. Ranking evaluation harness (MRR/NDCG/Recall@K) over fixture
   datasets — search quality must be measured, not assumed.
2. `packages/database` — Drizzle schema + Postgres persistence.
3. SSE streaming endpoints (`/v1/search/stream`, research progress).
4. Docker Compose self-hosting + deployment documentation.
5. Next.js developer dashboard.

