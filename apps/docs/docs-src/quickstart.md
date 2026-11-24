# Quickstart

Get a working, keyless Querynx instance in under five minutes.

## Docker (recommended)

```bash
git clone https://github.com/Suryanshu-Nabheet/Querynx.git
cd Querynx
echo "SEARXNG_SECRET=$(openssl rand -hex 32)" > .env
docker compose -f infrastructure/docker/docker-compose.yml up -d
```

Verify the stack:

```bash
curl http://localhost:3001/health
# {"status":"ok","version":"0.1.0"}

curl -X POST http://localhost:3001/v1/search \
  -H 'content-type: application/json' \
  -d '{"query": "hello world"}'
```

The bundled SearXNG backend needs no API keys, so search works
immediately. Add `BRAVE_API_KEY` or `TAVILY_API_KEY` to the api
service environment for additional providers.

## Local development

Requires Node.js >= 22 and pnpm >= 9.

```bash
pnpm install
pnpm test                    # full workspace test suite
pnpm --filter @querynx/api dev    # API on http://127.0.0.1:3001
```

Open development mode (no API key required):

```bash
QUERYNX_API_KEYS= pnpm --filter @querynx/api dev
```

## Your first requests

Search:

```bash
curl -X POST http://127.0.0.1:3001/v1/search \
  -H 'content-type: application/json' \
  -d '{"query": "postgres mvcc", "maxResults": 5}'
```

Extract a page:

```bash
curl -X POST http://127.0.0.1:3001/v1/extract \
  -H 'content-type: application/json' \
  -d '{"urls": ["https://example.com/article"]}'
```

Run bounded research:

```bash
curl -X POST http://127.0.0.1:3001/v1/research \
  -H 'content-type: application/json' \
  -d '{"objective": "how does mvcc work", "mode": "fast"}'
```

## Where to go next

- [API reference](/api.html) — every endpoint with schemas
- [Integrations](/integrations.html) — MCP, SDKs, LangChain, LlamaIndex
- [Self-hosting](/self-hosting.html) — production checklist
- [Architecture](/architecture.html) — how the pieces fit together
