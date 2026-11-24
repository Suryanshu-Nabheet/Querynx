# Querynx

**The open web, built for agents.**

Querynx is an open-source, self-hostable, agent-native web search, crawling,
extraction, indexing and research infrastructure platform. It exposes the
capabilities of commercial web-intelligence APIs (search, extract, crawl,
research) through a single self-hosted service you fully control.

## Why

Agents and AI applications need web access, but the current options force a
choice between expensive closed APIs and brittle scraping scripts. Querynx
gives you the infrastructure of a commercial search platform — federated
multi-provider search, hardened fetching, content extraction, hybrid
retrieval, autonomous research orchestration — as software you run and own.

## Status

Early, active development. The core foundation packages are implemented and
tested; the HTTP API, indexing and research engine are landing next. See
[ROADMAP.md](./ROADMAP.md) and [docs/STATUS.md](./docs/STATUS.md) for the
current state.

## Monorepo layout

| Package              | Responsibility                                                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/types`     | Domain contracts shared across services                                                                                                                        |
| `packages/shared`    | Fingerprinting, URL canonicalization, bounded concurrency, circuit breakers, rate limiting, error taxonomy                                                     |
| `packages/fetcher`   | SSRF-hardened HTTP fetching: DNS validation, rebinding defense, redirect re-validation, size limits                                                            |
| `packages/extractor` | Readability-based main-content extraction, metadata (JSON-LD/OG), tables, links, heading-aware chunking                                                        |
| `packages/providers` | Search provider adapters (SearXNG, Brave, Tavily) and the federated concurrent search orchestrator (RRF merge, dedupe, circuit breakers, graceful degradation) |
| `apps/api`           | Fastify HTTP API (in progress)                                                                                                                                 |

## Security posture

- **SSRF protection by default.** The fetcher resolves DNS itself and only
  returns public addresses; every redirect hop is re-validated. Private
  networks are unreachable unless the operator explicitly enables
  intranet mode via `QUERYNX_ALLOW_PRIVATE_NETWORKS=true`.
- **Content limits.** Response bodies are capped; decompression bombs
  and oversized documents cannot exhaust memory.
- **No credentials in code.** All provider keys come from the environment.
  The default provider (SearXNG) needs none.

## Development

Requires Node.js >= 22 and pnpm >= 9.

```bash
pnpm install
pnpm test        # run all package tests
pnpm typecheck   # tsc --noEmit across the workspace
```

## License

AGPL-3.0-or-later. See [LICENSE](./LICENSE).
