# API Reference

Base URL: your instance (default `http://127.0.0.1:3001`). All request
and response bodies are JSON. The machine-readable OpenAPI 3.1
specification lives at `docs/openapi.json` and is contract-tested on
every commit.

## Authentication

When `QUERYNX_API_KEYS` is set on the server, every `/v1/*` request
needs a key in the `x-api-key` header (or `Authorization: Bearer`).
With no keys configured the API runs open for local development.

```bash
curl -H 'x-api-key: YOUR_KEY' http://127.0.0.1:3001/v1/providers
```

## Search

### POST /v1/search

Federated search across all configured providers, merged with
Reciprocal Rank Fusion, deduplicated by canonical URL and content
fingerprint.

| Field | Type | Default | Notes |
|---|---|---|---|
| query | string | — | required |
| maxResults | int | 10 | 1-50 |
| includeDomains | string[] | — | restrict to these domains |
| excludeDomains | string[] | — | drop these domains |
| language / region | string | — | ISO codes |
| freshness | enum | any | day, week, month, year |
| category | enum | web | web, news, academic, code, docs |
| providers | string[] | all | restrict providers |

Response: `{ results, query, generatedAt, diagnostics, requestId }` —
`diagnostics` reports per-provider attempts, success counts and
duplicates removed. Unknown body properties are rejected with 400.

### POST /v1/search/batch

Up to 20 queries in one request. Returns per-query responses with
individual ok/error envelopes.

### POST /v1/search/semantic

BM25 search over your local indexed corpus (see /v1/index). Returns
matched terms per hit.

### POST /v1/search/stream

SSE stream: `start`, `partial` (per provider, ahead of the merge),
`results`, `done`. Client disconnect aborts in-flight provider work.

## Extraction

### POST /v1/extract

| Field | Type | Notes |
|---|---|---|
| urls | string[] | 1-10 absolute http(s) URLs |
| format | enum | markdown (default), html, text |
| includeLinks / includeTables / includeMetadata | bool | optional extras |
| maxContentLength | int | cap in characters |

Returns `{ results }` with per-URL ok/error. SSRF-protected: private
networks, loopback and cloud metadata endpoints are rejected with 400.

## Index (local corpus)

### POST /v1/index

Ingest by fetching a URL, or inline content. Documents live in named
collections and become searchable via /v1/search/semantic. When
DATABASE_URL is configured, ingests are mirrored to Postgres and the
corpus rehydrates on restart.

### GET /v1/index/stats

Document, collection, term and character counts plus the persistence
mode.

## Research

### POST /v1/research

Bounded autonomous research: plans queries, searches, extracts pages,
deduplicates evidence and synthesizes findings — deterministically
(no LLM required).

| Field | Type | Notes |
|---|---|---|
| objective | string | the research question |
| mode | enum | fast, standard, advanced, deep, academic, technical, documentation |
| maxQueries / maxPages / timeMs | int | override the mode budgets |

The report contains `findings`, `evidence` (with source URLs and
relevance), `gaps` (unresolved questions), `usage` and an honest
`termination` reason (coverage-reached, budget-exhausted, no-results,
cancelled).

### POST /v1/research/stream

SSE: the full research lifecycle — query-started, query-completed,
page-extracted, gap-detected — ending with `completed` carrying the
report.

## Jobs

Async execution over the durable queue.

| Endpoint | Purpose |
|---|---|
| POST /v1/jobs | Submit crawl/index/research (202 + poll handle) |
| GET /v1/jobs/:id | Poll status, attempts, result |
| DELETE /v1/jobs/:id | Cancel pending/running jobs |
| GET /v1/jobs | Queue stats + recent dead letters |

## System

| Endpoint | Purpose |
|---|---|
| GET /health | Liveness |
| GET /ready | Readiness + provider/cache state |
| GET /metrics | Prometheus text format |
| GET /v1/providers | Circuit state, success rate, P50 per provider |

## Tavily-compatible surface

`POST /search` accepts Tavily's request shape (`api_key` in body or the
Authorization header, `query`, `search_depth`, `topic`, `max_results`,
`include_answer`, `time_range`) and returns Tavily's response envelope.
Point existing Tavily clients at your instance by changing the base URL.

## Errors

Every error uses one envelope:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "..." },
  "requestId": "uuid" }
```

Codes: VALIDATION_ERROR (400), UNAUTHORIZED (401), RATE_LIMITED (429,
with retry-after), UPSTREAM_ERROR/PROVIDER_ERROR (502), CANCELLED
(499), INTERNAL_ERROR (500, details logged server-side with the
request id, never leaked).
