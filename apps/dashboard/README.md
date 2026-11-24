# Querynx Console

The developer dashboard for self-hosted Querynx instances. Functional
surfaces over the live HTTP API — no fake metrics, no placeholder
charts: every number on every page is fetched from your instance.

## Pages

| Route | Purpose |
|---|---|
| `/` | Overview — API health, provider census, cache hit rate, index size |
| `/search` | Federated search playground with freshness/max-results controls |
| `/research` | Bounded research runner with evidence, gaps and termination reasons |
| `/extract` | Multi-URL extraction with metadata display |
| `/providers` | Circuit-breaker state, success rates and latencies per provider |
| `/index` | Native corpus BM25 search with matched-term highlighting |

## Connecting

The connection bar (on every page) targets any Querynx instance:

- **API base URL** — where your instance listens (default
  `http://127.0.0.1:3001`)
- **API key** — optional for open dev instances, required when
  `QUERYNX_API_KEYS` is set on the server

Settings persist in `localStorage`. Production deployments can bake a
default target with `NEXT_PUBLIC_QUERYNX_URL` at build time.

## Development

```bash
pnpm --filter @querynx/dashboard dev    # dev server on :3000
pnpm --filter @querynx/dashboard build  # production build
```

The API URL for local development usually is `http://127.0.0.1:3001` —
run the API with `pnpm --filter @querynx/api dev` alongside.

## Design notes

- Understated terminal aesthetic: monospace, dark surfaces, high-
  contrast text. Infrastructure tooling, not marketing.
- Every interactive control is labeled (`aria-label`) and keyboard-
  operable; results render as semantic HTML (links, tables, lists).
- The browser talks to the API directly over `fetch` (lib/api.ts) —
  no server-side proxy, no bundled SDK; the dashboard is deployable as
  static output against any reachable instance.
