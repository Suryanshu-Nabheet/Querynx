# Benchmarks & Quality

Everything here is measured, reproducible from the repo, and enforced
by CI. No numbers are estimated or compared against competitors.

## Search quality (judged fixtures)

Method: packages/ranking/test/evaluation.test.ts — 7-document corpus,
8 hand-judged queries, BM25 top-10.

| Metric | Value |
|---|---|
| MRR | 0.88 |
| Recall@10 | 1.00 |
| NDCG@10 | 0.80 |
| Precision@10 | 0.125 |

CI enforces mrr >= 0.6, recall@10 == 1, ndcg@10 >= 0.5 — ranking
regressions fail builds.

## Performance (hot paths)

Method: benchmarks/bench/core.perf.test.ts, dev-laptop baselines with
5-10x regression ceilings.

| Benchmark | Result |
|---|---|
| BM25 query over 2000-doc corpus | P50 0.66ms / P95 1.61ms |
| BM25 index 500 docs | P50 49ms |
| Extract realistic page | P50 4.2ms |
| Federated merge 3×20 results | P50 4.6ms |
| Cache stampede: 100 concurrent identical gets | 1 compute |
| Bounded concurrency 200 tasks @ 16-wide | peak exactly 16 |

## Test surface

- 480+ test blocks across 32 packages
- Security attack scenarios (SSRF, exhaustion, leakage, injection)
- OpenAPI contract tests (spec vs live API)
- Measured perf benchmarks with CI ceilings
- End-to-end: Docker container boot + health probe on every push
