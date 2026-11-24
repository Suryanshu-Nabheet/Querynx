# Self-Hosting Querynx

Querynx is designed to run entirely on your own infrastructure with
**zero required API keys**. The default search provider is a bundled
SearXNG instance (open-source metasearch), so the platform is useful
the moment it boots.

## Quick start (Docker Compose)

```bash
git clone https://github.com/Suryanshu-Nabheet/Querynx.git
cd Querynx

# Generate a secret for SearXNG
echo "SEARXNG_SECRET=$(openssl rand -hex 32)" > .env

docker compose -f infrastructure/docker/docker-compose.yml up -d
```

Verify:

```bash
curl http://localhost:3001/health
curl -X POST http://localhost:3001/v1/search \
  -H 'content-type: application/json' \
  -d '{"query": "hello world"}'
```

Services:

| Service | Address | Purpose |
|---|---|---|
| `api` | http://localhost:3001 | Querynx HTTP API |
| `searxng` | http://localhost:8080 | Metasearch backend (internal) |

Both ports bind to `127.0.0.1` by default — the stack is private to
your machine. Put a TLS-terminating reverse proxy in front for network
exposure.

## Configuration

All configuration is environment-driven (see `apps/api/src/config.ts`).

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3001` | API listen port |
| `HOST` | `127.0.0.1` (compose: `0.0.0.0` behind the port map) | Listen address |
| `QUERYNX_API_KEYS` | *(empty = open)* | Comma-separated API keys. Empty disables auth for local dev; set for production. |
| `SEARXNG_BASE_URL` | *(compose sets it)* | SearXNG instance URL |
| `BRAVE_API_KEY` | — | Optional Brave Search key |
| `TAVILY_API_KEY` | — | Optional Tavily key |
| `SEARCH_CACHE_TTL_MS` | `300000` | Result cache TTL |
| `PRODUCER_CONCURRENCY` | `4` | Max simultaneous provider requests |
| `ANONYMOUS_RATE_LIMIT_PER_MIN` | `30` | Per-identity request budget |
| `QUERYNX_ALLOW_PRIVATE_NETWORKS` | `false` | Operator opt-in for intranet fetching. Never settable per request. |

## Production checklist

- [ ] Set `QUERYNX_API_KEYS` to strong generated values.
- [ ] Terminate TLS in front of the API (Caddy/Traefik/nginx).
- [ ] Keep the `127.0.0.1` port bindings; expose via the proxy only.
- [ ] Set `SEARXNG_SECRET` to a fresh random value.
- [ ] Point logs at your aggregation stack (`LOG_LEVEL=warn`).
- [ ] Review `SECURITY.md` for the threat model.

## Agent usage (MCP)

With the API running, point any MCP-compatible agent at Querynx:

```json
{
  "mcpServers": {
    "querynx": {
      "command": "npx",
      "args": ["tsx", "integrations/mcp/src/server.ts"],
      "env": {
        "QUERYNX_URL": "http://localhost:3001",
        "QUERYNX_MCP_STANDALONE": "1"
      }
    }
  }
}
```

## Local development (no Docker)

```bash
pnpm install
pnpm test
QUERYNX_API_KEYS=devkey pnpm --filter @querynx/api dev
```
