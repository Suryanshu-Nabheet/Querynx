# Self-Hosting

## Docker Compose stack

```bash
git clone https://github.com/Suryanshu-Nabheet/Querynx.git
cd Querynx
echo "SEARXNG_SECRET=$(openssl rand -hex 32)" > .env
docker compose -f infrastructure/docker/docker-compose.yml up -d
```

| Service | Address               | Purpose                    |
| ------- | --------------------- | -------------------------- |
| api     | http://localhost:3001 | Querynx HTTP API           |
| searxng | internal              | Keyless metasearch backend |

Ports bind to 127.0.0.1 — the stack is private to the host. Expose
via a TLS-terminating reverse proxy for network access.

## Configuration reference

All configuration is environment-driven; no keys are required.

| Variable                       | Default          | Meaning                                             |
| ------------------------------ | ---------------- | --------------------------------------------------- |
| PORT / HOST                    | 3001 / 127.0.0.1 | API listen                                          |
| QUERYNX_API_KEYS               | empty (open)     | Comma-separated keys; empty disables auth           |
| SEARXNG_BASE_URL               | set by compose   | Search backend                                      |
| BRAVE_API_KEY / TAVILY_API_KEY | —                | Additional providers                                |
| DATABASE_URL                   | —                | Postgres persistence (documents, jobs, keys, usage) |
| SEARCH_CACHE_TTL_MS            | 300000           | Result cache TTL                                    |
| PRODUCER_CONCURRENCY           | 4                | Provider fan-out width                              |
| ANONYMOUS_RATE_LIMIT_PER_MIN   | 30               | Per-identity request budget                         |
| EMBEDDINGS_BASE_URL + MODEL    | —                | OpenAI-compatible semantic embeddings               |
| QUERYNX_ALLOW_PRIVATE_NETWORKS | false            | Operator intranet opt-in                            |

## Production checklist

- [ ] Set QUERYNX_API_KEYS to strong generated values
- [ ] Terminate TLS in front (Caddy/Traefik/nginx)
- [ ] Keep 127.0.0.1 bindings; expose via the proxy only
- [ ] Fresh SEARXNG_SECRET
- [ ] DATABASE_URL for durable corpus and jobs
- [ ] LOG_LEVEL=warn for production noise
- [ ] Review SECURITY.md threat model

## Workers

Single-instance deployments run jobs in-process (POST /v1/jobs).
Dedicated fleets run the worker service:

```bash
QUERYNX_URL=... pnpm --filter @querynx/worker start
```

Crawl, index and research handlers plus the scheduler poll loop;
metrics on the worker's side port.
