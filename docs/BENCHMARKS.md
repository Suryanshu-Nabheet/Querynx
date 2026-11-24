# Benchmarks

Measured results only. No number in this file is estimated or copied
from marketing material. Methodology is reproducible from the linked
tests; re-run them after touching the retrieval stack.

## Search quality — BM25 over fixture corpus

- **Method**: `packages/ranking/test/evaluation.test.ts`
- **Corpus**: 7 technical documents (PostgreSQL, Redis, Nginx, SQLite)
- **Judgments**: 8 queries with known-relevant documents
- **Retrieval**: `MemorySearchEngine` (Okapi BM25, k1=1.2, b=0.75),
  top-10 results per query

**Measured (2026-11-24, Node 26, macOS):**

| Metric | Value |
|---|---|
| MRR | 0.88 |
| Recall@5 | 1.00 |
| Recall@10 | 1.00 |
| Precision@10 | 0.125 |
| NDCG@10 | 0.80 |

Interpretation: every judged document is retrieved (recall 1.0) and the
correct document is usually ranked first (MRR 0.88). Precision@10 is
low by construction — 10 retrieved for ~1 relevant each — not a defect.

## Methodology notes

- Judgments are small and hand-built; treat these numbers as a
  regression baseline, not an absolute quality claim.
- Each retrieval-stack change must re-run the evaluation; CI enforces
  the thresholds (`mrr >= 0.6`, `recall@10 == 1`, `ndcg@10 >= 0.5`).
- Latency and throughput benchmarks land with the API performance
  suite (planned); nothing is claimed before it is measured.
