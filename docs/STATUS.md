# Implementation Status

Last updated: 2026-11-24 (after platform expansion — 30 package milestone)

## Validated and working

| Component | State | Tests |
|---|---|---|
| `packages/shared` | Complete (fingerprint, URL, concurrency, errors) | 37 passing |
| `packages/fetcher` | Complete (SSRF defense, redirects, size caps) | 18 passing |
| `packages/extractor` | Complete (readability, metadata, chunking) | 13 passing |
| `packages/providers` | Complete (orchestrator + 3 adapters + streaming) | 12 passing |
| `packages/cache` | Complete (TTL, LRU, stampede protection) | 11 passing |
| `packages/crawler` | Complete (robots, frontier, engine, sitemaps) | 21 passing |
| `packages/indexer` | Complete (BM25 engine, hybrid RRF, vector store) | 24 passing |
| `packages/research` | Complete (bounded engine, planner, evidence) | 12 passing |
| `packages/ranking` | Complete (signals, pipeline, measured evaluation) | 27 passing |
| `packages/config` | Complete (env loader for all services) | 7 passing |
| `packages/observability` | Complete (metrics registry, P50/95/99) | 9 passing |
| `packages/security` | Complete (redaction, audit log) | 11 passing |
| `packages/auth` | Complete (hashed API keys, revocation) | 7 passing |
| `packages/database` | Schema + Postgres stores (Drizzle) | 5 passing |
| `packages/embeddings` | Complete (hash + OpenAI-compatible embedders) | 8 passing |
| `packages/parser` | Complete (normalize, classify, decompose, expand) | 15 passing |
| `packages/queue` | Complete (priority, retries, dead-letter) | 9 passing |
| `packages/scheduler` | Complete (cron parser, schedule registry) | 11 passing |
| `packages/retrieval` | Complete (hybrid BM25+vector facade) | 11 passing |
| `packages/cli` | Complete (search/extract/research/status/providers) | 10 passing |
| `apps/api` | 15 endpoints incl. SSE + Tavily-compat | 30 passing |
| `apps/worker` | Job service with crawl/index/research handlers | 4 passing |
| `apps/dashboard` | Next.js console — 6 pages, production build verified | typecheck gate |
| `sdk/typescript` | Complete (retries, typed errors) | 5 passing |
| `sdk/python` | Complete (sync + async, 8 tests) | 8 passing |
| `integrations/mcp` | Complete (4 tools, stdio transport) | 6 passing |
| `integrations/langchain` | Complete (3 StructuredTools) | 5 passing |
| `integrations/llamaindex` | Complete (3 callables + FunctionTool adapter) | 7 passing |
| `integrations/tavily-compatible` | Complete (drop-in surface) | 6 passing |
| `benchmarks` | 8 measured perf benchmarks with ceilings | 8 passing |
| `tests` (security) | 12 cross-layer attack scenarios | 12 passing |

**385+ tests across 30 packages.** All three CI workflows green on HEAD:
CI (typecheck + full suite), Docker (image build + container health
probe), Dashboard (typecheck + next build).

## Security posture (validated by the attack suite)

The cross-layer security suite caught and led to fixes for:
- userinfo credentials surviving URL canonicalization (leak risk)
- bracketed IPv6 literals bypassing URL-level SSRF checks

Both fixed; suite now guards against regression.

## Known limitations

- Postgres persistence covers documents; jobs/api-keys/usage tables
  exist in the schema but their stores are not yet wired into the API
  request path.
- No SSE for the dashboard research view (API streams; page polls).
- Browser rendering (Playwright) not yet implemented.
- PDF extraction not yet implemented.
- Embeddings default to deterministic hash vectors; the OpenAI-
  compatible embedder activates only when configured.
- Postgres rehydration loads the corpus into memory on boot; very
  large corpora will need the SQL read path (fullTextSearch) exposed.

## Next tasks (priority order)

1. Jobs API: /v1/jobs endpoints (submit crawl/index/research, poll
   status, cancel) over the queue.
2. Playwright browser rendering path for JS-heavy extraction.
3. PDF extraction.
4. Wire api-keys/usage stores into the request path.
5. Documentation site (apps/docs).
