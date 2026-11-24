# Implementation Status

Last updated: 2026-11-24 (after release-acceptance audit)

## Validated and working

| Component                        | State                                                   | Tests                  |
| -------------------------------- | ------------------------------------------------------- | ---------------------- |
| `packages/shared`                | Complete (fingerprint, URL, concurrency, errors)        | 37 passing             |
| `packages/fetcher`               | Complete (SSRF defense, redirects, size caps)           | 18 passing             |
| `packages/extractor`             | Complete (readability, metadata, chunking)              | 13 passing             |
| `packages/providers`             | Complete (orchestrator + 3 adapters + streaming)        | 12 passing             |
| `packages/cache`                 | Complete (TTL, LRU, stampede protection)                | 11 passing             |
| `packages/crawler`               | Complete (robots, frontier, engine, sitemaps)           | 21 passing             |
| `packages/indexer`               | Complete (BM25 engine, hybrid RRF, vector store)        | 24 passing             |
| `packages/research`              | Complete (bounded engine, planner, evidence)            | 12 passing             |
| `packages/ranking`               | Complete (signals, pipeline, measured evaluation)       | 27 passing             |
| `packages/config`                | Complete (env loader for all services)                  | 7 passing              |
| `packages/observability`         | Complete (metrics registry, P50/95/99)                  | 9 passing              |
| `packages/security`              | Complete (redaction, audit log)                         | 11 passing             |
| `packages/auth`                  | Complete (hashed API keys, revocation)                  | 7 passing              |
| `packages/database`              | Schema + Postgres stores (Drizzle)                      | 5 passing              |
| `packages/embeddings`            | Complete (hash + OpenAI-compatible embedders)           | 8 passing              |
| `packages/parser`                | Complete (normalize, classify, decompose, expand)       | 15 passing             |
| `packages/queue`                 | Complete (priority, retries, dead-letter)               | 9 passing              |
| `packages/scheduler`             | Complete (cron parser, schedule registry)               | 11 passing             |
| `packages/retrieval`             | Complete (hybrid BM25+vector facade)                    | 11 passing             |
| `packages/cli`                   | Complete (search/extract/research/status/providers)     | 10 passing             |
| `apps/api`                       | 15 endpoints incl. SSE + Tavily-compat                  | 30 passing             |
| `apps/worker`                    | Job service with crawl/index/research handlers          | 4 passing              |
| `apps/dashboard`                 | Console — 9 pages incl. crawl mgmt, usage, SSE research | build + typecheck gate |
| `sdk/typescript`                 | Complete (retries, typed errors)                        | 5 passing              |
| `sdk/python`                     | Complete (sync + async, 8 tests)                        | 8 passing              |
| `integrations/mcp`               | Complete (4 tools, stdio transport)                     | 6 passing              |
| `integrations/langchain`         | Complete (3 StructuredTools)                            | 5 passing              |
| `integrations/llamaindex`        | Complete (3 callables + FunctionTool adapter)           | 7 passing              |
| `integrations/tavily-compatible` | Complete (drop-in surface)                              | 6 passing              |
| `benchmarks`                     | 8 measured perf benchmarks with ceilings                | 8 passing              |
| `tests` (security)               | 12 cross-layer attack scenarios                         | 12 passing             |

**385+ tests across 30 packages.** All three CI workflows green on HEAD:
CI (typecheck + full suite), Docker (image build + container health
probe), Dashboard (typecheck + next build).

## Security posture (validated by the attack suite)

The cross-layer security suite caught and led to fixes for:

- userinfo credentials surviving URL canonicalization (leak risk)
- bracketed IPv6 literals bypassing URL-level SSRF checks

Both fixed; suite now guards against regression.

## Recently closed

- §12 AI integration: @querynx/llm — OpenAI-compatible client with task
  routing, cross-provider fallback, usage accounting, and
  prompt-injection-resistant web-grounded completions; fetcher gained
  POST support for platform calls.
- §13 endpoint completion: /v1/answer (grounded Q&A with citations),
  /v1/rerank, /v1/extract/batch, /v1/crawl, /v1/map and
  GET /v1/jobs/:id/stream — OpenAPI at 20 documented operations.
- Jobs API over the durable queue (submit/poll/cancel, dead letters).
- Playwright browser rendering: isolated Chromium with in-context
  private-network blocking (operator opt-in via QUERYNX_BROWSER_PATH).
- PDF extraction with input/page/char caps.
- Documentation site (apps/docs): 8 pages, dependency-free builder,
  link-integrity tests.
- Search facade (@querynx/search): parse → federated retrieval with
  decomposition → ranking → cache in one entrypoint.
- Production compose + deployment guide; release-check gate script;
  live API smoke test.
- DB-backed key auth (hashed Postgres keys alongside env keys) and
  usage accounting with GET /v1/usage (P95 per route).
- Dashboard: crawl management, usage analytics, SSE-streamed research
  with live progress and cooperative Stop; 9 pages serving 200s
  against the running API.
- Shared cross-layer fixtures (robots/html/sitemap/attacks) with
  integrity tests.

## Release-acceptance audit (external-style review)

An adversarial audit re-verified every major claim by execution. Findings
fixed in this pass:

1. **Tavily adapter never sent its query** — bare GET with the request
   body built after the fetch (dead code). Caught by writing wire-contract
   tests against each provider's documented format; all fake-based tests
   had passed. Fixed + wire suite added.
2. **Every hostname fetch on a real network failed** ('Invalid IP
   address: undefined') — the validating DNS lookup answered in
   single-address form while undici reads the all-form array. Only
   loopback-literal fixtures had ever run, so no suite caught it. Fixed
   with the proper dual-form contract + hostname regression tests.
3. **Plain-text documents lost their beginnings** — text/plain input ran
   through Readability, which discarded RFC title pages as boilerplate.
   Plain-text detection + verbatim path added; verified live.
4. **Compressed mapped-IPv6 SSRF bypass** — [::ffff:169.254.169.254]
   normalizes to hex-compressed form ([::ffff:a9fe:a9fe]) which the
   dotted-quad check missed. Decoder added; 3 regression vectors.
5. **Contradiction detection was a type value with no implementation** —
   §11 step 10 now implemented conservatively (single-value factual
   claims; probe step; report field) with end-to-end tests.
6. **Published quality numbers were stale** — the committed corpus
   measured MRR 1.00/NDCG 1.00, not the published 0.88/0.80. Numbers
   corrected, corpus expanded from 7 to 20 docs with competitive
   distractors, thresholds set just below measurement.
7. **Live 99-query evaluation** (real fetched corpus): MRR 1.000,
   recall@5 100%, p99 0.38ms — and 3/19 false positives on nonsense
   queries, fixed by BM25 floor + query-coverage gates (now 1/19, the
   remaining case is an honest borderline recorded below).
8. **Env-key auth compared secrets with non-constant-time includes** —
   now hash-compared via timingSafeEqual, matching the DB path.

Fresh-clone verification (the newcomer test): frozen install 2.5s,
typecheck 34/34, tests 33/33 tasks, server boots with auth enforced.

## Known limitations

- **No search provider runs by default**: federated web search needs a
  SearXNG instance or a Brave/Tavily key. Without one, search returns
  honest empty results with per-provider diagnostics. This is the
  platform's biggest usability gap for a first-time user — the
  documented Docker quickstart ships SearXNG, but it requires Docker.
- One live-eval false positive remains: 'kubernetes operator pattern'
  matches the genuine HTTP term 'operator' at exactly the 1/3 coverage
  minimum. Deliberately not overfit to a 7-document corpus.
- Embeddings default to deterministic hash vectors; the OpenAI-compatible
  embedder activates only when configured.
- Postgres rehydration loads the corpus into memory on boot; very large
  corpora will need the SQL read path (fullTextSearch) exposed.
- The worker service and API share handler contracts; the Postgres
  jobs-table bridge (workers claiming API-submitted jobs) requires
  QUERYNX_DELEGATE_JOBS=1 + DATABASE_URL. API-submitted jobs run
  in-process otherwise.
- Browser rendering is an operator opt-in (QUERYNX_BROWSER_PATH); no
  browser ships with the default stack.
- Research synthesis is extractive by default; LLM synthesis requires
  LLM_BASE_URL + LLM_MODEL. The platform is fully functional without.

## Next tasks (priority order)

1. Multi-worker jobs bridge: API enqueue -> Postgres jobs table ->
   worker SKIP LOCKED claim (production compose topology).
2. Ranking evaluation corpus expansion (more judgments).
3. Webhook support for completed research jobs.
4. Browser rendering as automatic fallback in the extract path when
   HTTP extraction returns insufficient content.
