# Implementation Status

Last updated: 2026-11-24 (after SSE streaming milestone)

## Validated and working

| Component | State | Tests |
|---|---|---|
| `packages/shared` | Complete (fingerprint, URL, concurrency, errors) | 37 passing |
| `packages/fetcher` | Complete (SSRF defense, redirects, size caps) | 18 passing |
| `packages/extractor` | Complete (readability, metadata, chunking) | 13 passing |
| `packages/providers` | Complete (orchestrator + 3 adapters, streaming callback) | 12 passing |
| `packages/cache` | Complete (TTL, LRU, stampede protection) | 11 passing |
| `packages/crawler` | Complete (robots, frontier, engine, sitemaps) | 21 passing |
| `packages/indexer` | Complete (BM25 engine, hybrid RRF, vector store) | 24 passing |
| `packages/research` | Complete (bounded engine, planner, evidence) | 12 passing |
| `packages/ranking` | Complete (signals, pipeline, measured evaluation) | 27 passing |
| `apps/api` | search (+batch/+semantic/+stream), extract, index, research (+stream), providers, health/metrics | 26 passing |
| `sdk/typescript` | Complete (typed client, retries, error surface) | 5 passing |
| `integrations/mcp` | Complete (4 tools, stdio + in-memory transports) | 6 passing |

**212 tests passing across 12 packages.** CI green on GitHub Actions:
typecheck + full suite (CI workflow), image build + container health
probe (Docker workflow — the stack boots and serves /health on a clean
Linux runner).

## Infrastructure validated by execution

- Docker image builds; container runs non-root, read-only rootfs, and
  answers `/health` inside the container (CI Docker workflow).
- Measured search quality on the fixture corpus: MRR 0.88,
  Recall@10 1.0, NDCG@10 0.80 (docs/BENCHMARKS.md, reproducible).
- SSE streams emit real event framing end-to-end (parse-tested).

## Known limitations

- No persistence layer yet — index, cache and crawl state are
  in-memory; restart loses them. Postgres/Drizzle schema is the top
  remaining architectural gap.
- Provider adapters have unit coverage but no live-network contract
  tests yet.
- Extraction has no PDF or browser-rendering path yet.
- API auth uses static env-provided keys; hashed-key store arrives with
  the database package.
- No latency/throughput benchmarks yet (quality metrics exist;
  performance measurement is queued — directive §17).

## Next tasks (priority order)

1. `packages/database` — Drizzle schema + Postgres/pgvector
   persistence for index, jobs and API keys.
2. Performance benchmark harness (P50/P95/P99 latency, throughput)
   with reproducible methodology.
3. Browser rendering path (Playwright, isolated) for JS-heavy pages.
4. Python SDK + CLI.
5. Next.js developer dashboard.

