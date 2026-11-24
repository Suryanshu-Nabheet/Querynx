# Benchmarks

Measured results only. No number in this file is estimated or copied
from marketing material. Methodology is reproducible from the linked
tests; re-run them after touching the retrieval stack.

## Search quality — BM25 over fixture corpus

- **Method**: `packages/ranking/test/evaluation.test.ts`
- **Corpus**: 20 technical documents with deliberately shared vocabulary
  (four PostgreSQL, two Redis, two etcd, two Kafka, two embedded-DB
  docs) so term matching must discriminate between near-identical
  candidates
- **Judgments**: 21 queries phrased descriptively (the query does not
  name the target document)
- **Retrieval**: `MemorySearchEngine` (Okapi BM25, k1=1.2, b=0.75),
  top-10 results per query

**Measured (2026-11-24 audit reproduction, Node 26, macOS):**

| Metric       | Value |
| ------------ | ----- |
| MRR          | 1.00  |
| Recall@5     | 1.00  |
| Recall@10    | 1.00  |
| Precision@10 | 0.533 |
| NDCG@10      | 1.00  |

Interpretation: every judged document is retrieved and ranked first on
this corpus. Honest caveats: 20 documents is a small corpus — these
numbers prove the ranker discriminates competitive candidates, not
web-scale quality. Test thresholds (MRR >= 0.85, Recall@10 >= 0.95,
NDCG@10 >= 0.85) sit below measurement so regressions fail loudly.

Audit correction: an earlier version of this table published MRR 0.88
/ NDCG 0.80 from a stale corpus state. Those numbers did not reproduce
when checked against the committed corpus (which measured 1.00/1.00)
— the table now carries only numbers regenerated from the exact
committed fixtures, and the corpus was expanded from 7 to 20 documents
because perfect scores on the tiny original made the evaluation
uninformative.

## Performance — core hot paths

- **Method**: `benchmarks/bench/core.perf.test.ts` (runs in CI; each
  ceiling asserts against regression).
- **Machine**: dev laptop (Apple Silicon), Node 26, single process.
  Numbers are directional baselines, not certified SLOs.

**Measured (2026-11-24):**

| Benchmark                                     | Result                                 |
| --------------------------------------------- | -------------------------------------- |
| BM25 index 500 docs (60 sentences each)       | P50 49ms (~10k docs/s single-threaded) |
| BM25 query over 2000-doc corpus               | P50 0.66ms / P95 1.61ms                |
| Fingerprint 100-sentence text                 | P50 0.45ms                             |
| Canonicalize 100 URLs                         | P50 0.97ms                             |
| Cache stampede: 100 concurrent identical gets | 1 compute, 11.5ms total                |
| Extract realistic page (150 paragraphs)       | P50 4.2ms                              |
| Federated merge, 3 providers × 20 results     | P50 4.57ms                             |
| Bounded concurrency: 200 tasks @ 16-wide      | peak exactly 16, 29ms                  |

Interpretation: retrieval and merge paths are well inside interactive
latency budgets; the cache prevents thundering herds exactly as
designed (100 → 1 upstream call).

## Methodology notes

- Judgments are small and hand-built; treat these numbers as a
  regression baseline, not an absolute quality claim.
- Each retrieval-stack change must re-run the evaluation; CI enforces
  the thresholds (`mrr >= 0.6`, `recall@10 == 1`, `ndcg@10 >= 0.5`).
- Perf ceilings are deliberately generous (5–10× observed) to catch
  regressions without flaking on CI runner variance.
- No comparison against competing implementations is claimed anywhere;
  numbers exist to keep Querynx honest about itself.
