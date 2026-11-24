# Querynx Architecture

## Overview

Querynx is a TypeScript monorepo building an agent-native web intelligence
platform: search, extraction, crawling, indexing and autonomous research,
exposed through a self-hosted HTTP API.

The architecture separates **capability packages** (pure libraries with
explicit contracts) from **service apps** (processes that wire capabilities
together over the network). Packages never reach upward into apps; apps
compose packages.

## Layers

```
┌──────────────────────────────────────────────────────────┐
│ apps: api (Fastify) · dashboard (Next.js) · worker       │
├──────────────────────────────────────────────────────────┤
│ integrations: MCP server · Tavily-compatible surface      │
├──────────────────────────────────────────────────────────┤
│ orchestration: search orchestrator · research engine ·   │
│ crawl scheduler · job queue                              │
├──────────────────────────────────────────────────────────┤
│ capability packages                                       │
│   fetcher ─ SSRF-hardened HTTP (undici + DNS validation) │
│   extractor ─ readability, metadata, chunking            │
│   providers ─ provider adapters (searxng, brave, tavily) │
│   indexer/retrieval ─ BM25 + vectors (planned)           │
├──────────────────────────────────────────────────────────┤
│ foundation: shared (fingerprint, URL, concurrency,       │
│ circuit breaker, rate limit, errors) · types (contracts) │
└──────────────────────────────────────────────────────────┘
```

## Decisions

### D1 — Provider-normalized contracts (`packages/types`)

Every search provider normalizes to `SearchResult` at the adapter boundary.
Downstream (merge, rank, cache, index) never sees provider-specific shapes.
This lets providers be added or removed without touching orchestration.

### D2 — SSRF defense at the resolver, not just the URL parser

`packages/fetcher` resolves DNS through a validating lookup that filters
private/reserved/loopback addresses and pins the connection to the validated
result. Redirects are followed manually, re-validating each hop — so a
public URL that redirects to `169.254.169.254` fails before dialing. The
operator may opt into intranet indexing with
`QUERYNX_ALLOW_PRIVATE_NETWORKS=true`; this is environment-level policy,
never settable per request, so API consumers cannot probe internal
networks.

### D3 — Bounded concurrency everywhere

No code path runs unbounded `Promise.all` over external input. All fan-outs
go through `mapWithConcurrency` with explicit limits, per-provider
semaphores and cooperative `AbortSignal` cancellation. Circuit breakers
open per provider after repeated failures so one dead upstream cannot
consume request budget.

### D4 — RRF merge with cross-provider dedupe

Federated search merges results with Reciprocal Rank Fusion (k=60),
deduplicates by canonical URL key, then drops near-duplicate content by
fingerprint similarity. Corroboration (multiple providers returning the
same result) contributes to ranking. Provider scores are not trusted
across providers; only per-provider ordering is used.

### D5 — Extraction treats web content as untrusted data

Readability runs over a DOM built by linkedom (no scripts execute).
Documents carry provenance (final URL after redirects, fetch timestamp,
fingerprints). Extraction is capped by content length and chunk count so
hostile inputs cannot exhaust the indexer.

### D6 — Deterministic core, optional model intelligence

Fetching, caching, parsing, merging and basic ranking are deterministic and
LLM-free. Language models are reserved for query expansion, research
planning and synthesis — and the platform stays fully functional without
any model configured.

## Data flow: federated search

```
SearchQuery ─▶ Orchestrator ─▶ [provider A ┊ provider B ┊ provider C]
                    │                (bounded concurrency, breakers)
                    │
                    └─▶ normalize ─▶ domain filters ─▶ canonical dedupe
                            ─▶ fingerprint dedupe ─▶ RRF rank ─▶ top-K
```

## Data flow: extraction

```
URL ─▶ fetcher (validate, resolve, redirect-check, size-cap)
   ─▶ readability ─▶ metadata (JSON-LD, OG, meta) ─▶ headings/links/tables
   ─▶ sections ─▶ fingerprint ─▶ ExtractedDocument
```

## Planned components

- **indexer/retrieval**: persistent document store (PostgreSQL + pgvector),
  BM25 full-text + vector hybrid retrieval with RRF fusion.
- **queue**: BullMQ durable jobs for crawl/index/research workloads.
- **api**: Fastify service exposing `/v1/*` with auth, rate limiting, SSE
  streaming and request idempotency.
- **research engine**: bounded iterative retrieve-rank-synthesize loop
  with explicit budgets and cancellation.
