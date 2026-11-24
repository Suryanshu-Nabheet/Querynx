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

Working, audited 0.1.x. The full pipeline — federated search, extraction,
crawling, native BM25 corpus, bounded research with evidence citations and
contradiction detection, jobs, SSE streaming, SDKs and MCP — is implemented
and tested (460+ test assertions across 33 packages, three CI workflows).
Quality and performance numbers are measured, not claimed, and reproduce
from committed fixtures: see [docs/BENCHMARKS.md](./docs/BENCHMARKS.md) for
the evaluation methodology (including a live-corpus 99-query run) and
[docs/STATUS.md](./docs/STATUS.md) for current state and known limitations.

### Verified by external-style audit (not self-reported)

- Real-network fetching, extraction and research verified against
  live sources (rfc-editor.org, iana.org) during a fresh-clone audit
- Two production-blocking defects found and fixed by that audit:
  every hostname fetch was broken (DNS lookup callback contract), and
  plain-text documents lost their beginnings to the readability filter
- SSRF surface re-audited: compressed mapped-IPv6 metadata bypass fixed
- Provider wire contracts (SearXNG, Brave, Tavily) verified against
  documented request/response shapes, not fakes — which caught the
  Tavily adapter never sending its query

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
