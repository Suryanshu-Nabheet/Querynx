# Implementation Status

Last updated: 2026-11-24

## Validated and working

| Component | State | Tests |
|---|---|---|
| `packages/shared` | Complete (fingerprint, URL, concurrency, errors) | 37 passing |
| `packages/fetcher` | Complete (SSRF defense, redirects, size caps) | 18 passing |
| `packages/extractor` | Complete (readability, metadata, chunking) | 13 passing |
| `packages/providers` | Orchestrator complete; 3 adapters implemented | 12 passing |

All suites green via `pnpm test`; strict typecheck clean via `pnpm typecheck`.

## Known limitations

- Provider adapters (`searxng`, `brave`, `tavily`) have unit coverage at
  the orchestrator level but no live-network contract tests yet; they will
  get fixture-based HTTP tests alongside the API integration suite.
- Extraction has no PDF support yet (planned: `pdf.js` or similar, with
  page caps).
- No persistence layer yet — search/extraction are in-memory only.

## Next tasks (priority order)

1. `packages/cache` — TTL cache with stampede protection (in-flight
   dedupe of identical queries).
2. `apps/api` — Fastify service exposing `/v1/search`, `/v1/extract`,
   `/health`, `/ready` with API-key auth, rate limiting and request IDs.
3. `packages/database` — Drizzle schema + migrations.
4. Crawler with robots.txt compliance, then indexer.
