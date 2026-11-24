# Technical Research

Ongoing research log: competitive analysis, design references, and the
improvement opportunities they surface. Sources are public
documentation and open-source code; nothing proprietary is reproduced.

## Competitive landscape (2026-11)

| Capability | Tavily | Exa | Firecrawl | SearXNG | **Querynx** |
|---|---|---|---|---|---|
| Federated multi-provider search | proprietary | proprietary (own index) | — | yes (engines) | ✅ RRF merge + dedupe |
| Self-hostable | no | no | no | yes (search only) | ✅ full stack, keyless default |
| Content extraction | basic | basic | strong (crawler-grade) | — | ✅ Readability + metadata |
| Crawling | limited | — | strong | — | ✅ robots-compliant, resumable |
| Native corpus + retrieval | — | own index | — | — | ✅ BM25 + hybrid RRF |
| Bounded research orchestration | API "research" | — | — | — | ✅ budgets, evidence, gaps |
| MCP server | yes | yes | yes | — | ✅ 4 tools, tested over protocol |
| Quality metrics published | no | no | no | n/a | ✅ MRR/NDCG measured in-repo |
| Open license | closed | closed | AGPL | AGPL | ✅ AGPL |

### Where Querynx is ahead
- **Fully keyless self-hosting** with measured quality gates.
- **Honest degradation**: providers report health/circuit state; research
  reports gaps and termination reasons rather than false confidence.
- **Deterministic core**: search/extract/rank work with zero model keys;
  the model is a pluggable upgrade, not a dependency.

### Where competitors are ahead (honest gaps)
- **Exa's neural index** embeds billions of pages; Querynx's native corpus
  starts empty and grows by crawl/ingest. Vector search is wired but has
  no default embedding model yet.
- **Firecrawl's JS rendering** handles SPAs; Querynx extraction is
  HTTP+Readability today (browser rendering is planned, directive §7).
- **Tavily's answer synthesis** returns generated prose by default;
  Querynx returns extractive summaries unless a model is configured.

## Algorithm references

- Okapi BM25 — Robertson & Zaragoza, "The Probabilistic Relevance
  Framework: BM25 and Beyond" (2010). k1=1.2, b=0.75 defaults.
- Reciprocal Rank Fusion — Cormack et al. (2009), k=60 standard.
- REP (robots.txt) — Google's robots.txt documentation semantics for
  group selection (most-specific agent match excludes wildcard) and
  longest-match path rules.
- MinHash-style sketching for near-duplicate detection — sized 64
  buckets/5-gram, tuned for snippet-level dedupe.

## Prioritized improvement opportunities

1. **Postgres persistence** (Drizzle + pgvector): the index, cache and
   crawl state die on restart today. This blocks production use.
2. **SSE streaming**: research progress and partial search results are
   batch-returned; streaming matches the directive's UX goals.
3. **Browser rendering path** (Playwright, isolated): for JS-heavy pages
   HTTP extraction misses.
4. **Embedding service** (@querynx/embeddings): Transformers.js or
   OpenAI-compatible embeddings to activate the vector half of hybrid
   retrieval by default.
5. **PDF extraction**: `pdf.js`-based text extraction with page caps.
6. **Benchmarks**: latency/throughput harness for the API (quality
   metrics exist; performance metrics don't yet — directive §17).

## Method note

This file records findings from public documentation and papers, and
from reading competitor product behavior through their own published
docs. No proprietary code is copied; licenses are respected (AGPL
components are used only in compliance).
