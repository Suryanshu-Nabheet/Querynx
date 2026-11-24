# Architecture

Querynx is a TypeScript monorepo separating **capability packages**
(pure libraries with explicit contracts) from **service apps**
(processes that compose capabilities).

## Layers

```
┌───────────────────────────────────────────────────────────────┐
│ apps: api (Fastify) · worker (jobs) · dashboard (Next.js) ·    │
│       docs (static site)                                      │
├───────────────────────────────────────────────────────────────┤
│ integrations: MCP · Tavily-compat · LangChain · LlamaIndex    │
├───────────────────────────────────────────────────────────────┤
│ facades: @querynx/search (parse→retrieve→rank→cache) ·         │
│         @querynx/retrieval (BM25+vectors) · research engine   │
├───────────────────────────────────────────────────────────────┤
│ capabilities: fetcher (SSRF-hardened HTTP) · extractor        │
│ (readability+metadata) · providers (federated adapters) ·    │
│ crawler (robots+frontier) · indexer (BM25) · embeddings ·     │
│ ranking (signals+metrics) · parser (query understanding) ·   │
│ queue/scheduler (durable async)                              │
├───────────────────────────────────────────────────────────────┤
│ platform: config · observability · security · auth ·         │
│ database (Drizzle+Postgres) · cache · shared · types          │
└───────────────────────────────────────────────────────────────┘
```

## Key decisions

### SSRF defense at the resolver, not just the URL parser

The fetcher resolves DNS through a validating lookup that rejects
private/reserved/loopback addresses (v4 and v6, including mapped
forms) and pins the connection to the validated result. Redirects
are followed manually with re-validation of every hop. The security
attack suite proves a public URL redirecting to `169.254.169.254`
fails before dialing. Private-network access is an operator-level
environment flag, never a request parameter.

### Provider-normalized contracts

Every search provider normalizes to `SearchResult` at the adapter
boundary. Downstream (merge, rank, cache, index) never sees
provider-specific shapes — providers are added without touching
orchestration. Provider scores are not trusted across providers;
only per-provider ordering feeds the RRF merge.

### Bounded concurrency everywhere

No unbounded `Promise.all` over external input. Fan-outs go through
`mapWithConcurrency` with explicit limits, per-provider semaphores and
cooperative `AbortSignal` cancellation. Circuit breakers open per
provider after repeated failures. Research adds hard budgets
(queries, pages, time, content chars) and stops honestly.

### Deterministic core, optional intelligence

Fetching, caching, parsing, ranking and research synthesis are fully
functional with zero model keys. The hash embedder activates hybrid
retrieval offline; an OpenAI-compatible embeddings endpoint upgrades
it when configured. Research synthesis is extractive by default with
a pluggable model hook.

### Persistence as a mirror, not a gate

The BM25 engine serves all reads from memory for latency. When
DATABASE_URL is set, writes mirror to Postgres (durable truth) and the
corpus rehydrates on boot. Mirror failures never fail requests — they
surface via metrics and self-heal on the next upsert through the url
unique key.

### Measured, not assumed

Search quality is evaluated against hand-judged fixtures with
CI-enforced thresholds (MRR 0.88, Recall@10 1.0, NDCG@10 0.80).
Performance is benchmarked with ceilings that fail builds on
regression. The numbers live in docs/BENCHMARKS.md with methodology.

## Data flow: federated search

```
raw text ─▶ parser (normalize, classify, site:/freshness operators,
            decomposition, expansion)
        ─▶ orchestrator (concurrent providers, breakers, RRF merge,
            canonical + fingerprint dedupe)
        ─▶ ranking pipeline (relevance, freshness, diversity,
            domain preferences, corroboration)
        ─▶ cache (stampede-protected) ─▶ response with diagnostics
```

## Data flow: research

```
objective ─▶ planner (initial queries) ─▶ search rounds ─▶ extract
  pages (bounded concurrency) ─▶ evidence dedupe (fingerprints) ─▶
  gap detection ─▶ follow-up rounds (≤2) ─▶ synthesis
  (deterministic or model hook) ─▶ report: findings, evidence,
  gaps, usage, termination
```

## Services

| Service   | Role                                                                                     |
| --------- | ---------------------------------------------------------------------------------------- |
| api       | HTTP surface: search/extract/index/research/jobs + SSE, Tavily-compat, auth, rate limits |
| worker    | Dedicated job fleet: crawl/index/research handlers, scheduler polling, metrics port      |
| dashboard | Browser console over the live API (static output, no server runtime)                     |
| docs      | This site — markdown built by a dependency-free generator                                |
