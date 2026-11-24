# Deployment Guide

Production deployment patterns beyond the basic Docker Compose stack
(see docs/SELF-HOSTING.md for the quickstart).

## Topology options

### Single host (compose)

```
[caddy/nginx TLS] ─▶ [api :3001] ─▶ [searxng :8080]
                          │
                          └▶ [postgres] (optional persistence)
```

Everything on one machine, ports bound to loopback, TLS at the edge.
Right for most self-hosters.

### Dedicated worker fleet

```
[api x N] ─▶ shared Postgres (jobs table, SKIP LOCKED claiming)
[worker x M] ┘
```

The api submits jobs; workers claim them. Set DATABASE_URL on both.
Scale workers independently of API capacity.

## Reference: docker-compose.production.yml

A production-oriented compose file lives alongside this README:

- Postgres with a named volume (documents, jobs, keys, usage)
- API and worker services sharing the database
- SearXNG with its own volume
- Restart policies and resource limits throughout
- No host ports exposed for internal services

## Reverse proxy notes

Terminate TLS in front of the API and pass through:

```nginx
location / {
  proxy_pass http://127.0.0.1:3001;
  proxy_http_version 1.1;
  proxy_set_header Connection '';      # SSE: no buffering
  proxy_buffering off;                  # SSE: stream events live
  proxy_read_timeout 300s;              # research jobs run long
}
```

SSE endpoints (/v1/search/stream, /v1/research/stream) require
buffering disabled and long read timeouts.

## Database migrations

```bash
cd packages/database
DATABASE_URL=postgres://... pnpm db:generate   # drizzle-kit migrations
DATABASE_URL=postgres://... pnpm db:migrate
```

Schema: documents (unique url, collection index), chunks (cascade),
api_keys (unique hash), jobs (status+type indexes), usage_events
(route+time indexes).

## Capacity planning (measured baselines)

From docs/BENCHMARKS.md on dev-class hardware:

- BM25 queries: sub-2ms at 2k documents; the in-memory index is the
  read path, so RAM must hold the corpus (~content chars × ~1.5).
- Extraction: ~4ms/page single-threaded; bounded to 4-wide in the API,
  so ~1000 pages/min per worker.
- Federated search: latency is upstream-bound; concurrency 4 keeps
  provider politeness while serving interactive traffic.

Start with 1 vCPU / 1GB per service; scale workers for crawl-heavy
loads, scale api replicas for request volume.

## Monitoring

- `/health` for liveness, `/ready` for provider/cache state
- `/metrics` (api) and `:3002/metrics` (worker) in Prometheus format
- Watch: cache hit rate, provider success rates, circuit state,
  queue depth (pending/running/dead), persistence error counters

## Backups

- Postgres: standard pg_dump cadence; the corpus rebuilds from it
  (rehydration on boot).
- SearXNG: config volume only.
- Secrets: re-deployable from your environment management; the repo
  never stores credentials.
