/**
 * Standard information-retrieval metrics.
 *
 * Every function takes a ranked list of document ids and a set of
 * relevant ids — nothing about providers or engines leaks in, so the
 * same harness evaluates BM25, hybrid retrieval, or any search backend.
 */

/**
 * Mean Reciprocal Rank: average of 1/rank of the first relevant result.
 * 1.0 means the top result is always relevant.
 */
export function reciprocalRank(
  ranked: readonly string[],
  relevant: ReadonlySet<string>,
): number {
  for (let i = 0; i < ranked.length; i++) {
    if (relevant.has(ranked[i]!)) return 1 / (i + 1);
  }
  return 0;
}

export function mrr(
  queries: ReadonlyArray<{
    ranked: readonly string[];
    relevant: ReadonlySet<string>;
  }>,
): number {
  if (queries.length === 0) return 0;
  return (
    queries.reduce((sum, q) => sum + reciprocalRank(q.ranked, q.relevant), 0) /
    queries.length
  );
}

/**
 * Recall@K: fraction of relevant documents present in the top K.
 */
export function recallAtK(
  ranked: readonly string[],
  relevant: ReadonlySet<string>,
  k: number,
): number {
  if (relevant.size === 0) return 0;
  const topK = new Set(ranked.slice(0, k));
  let hits = 0;
  for (const id of relevant) {
    if (topK.has(id)) hits++;
  }
  return hits / relevant.size;
}

/**
 * Precision@K: fraction of top-K results that are relevant.
 */
export function precisionAtK(
  ranked: readonly string[],
  relevant: ReadonlySet<string>,
  k: number,
): number {
  if (ranked.length === 0) return 0;
  const topK = ranked.slice(0, k);
  let hits = 0;
  for (const id of topK) {
    if (relevant.has(id)) hits++;
  }
  return topK.length === 0 ? 0 : hits / topK.length;
}

/**
 * Normalized Discounted Cumulative Gain at K (binary relevance).
 * DCG@K = Σ rel_i / log2(i + 1); NDCG normalizes by the ideal DCG.
 */
export function ndcgAtK(
  ranked: readonly string[],
  relevant: ReadonlySet<string>,
  k: number,
): number {
  const topK = ranked.slice(0, k);
  let dcg = 0;
  for (let i = 0; i < topK.length; i++) {
    if (relevant.has(topK[i]!)) {
      dcg += 1 / Math.log2(i + 2);
    }
  }
  // Ideal DCG: all relevant documents ranked at the top.
  const idealHits = Math.min(relevant.size, k);
  let idcg = 0;
  for (let i = 0; i < idealHits; i++) {
    idcg += 1 / Math.log2(i + 2);
  }
  return idcg === 0 ? 0 : dcg / idcg;
}

/** Full evaluation report over a query set. */
export interface EvaluationReport {
  queryCount: number;
  mrr: number;
  recallAt5: number;
  recallAt10: number;
  precisionAt5: number;
  precisionAt10: number;
  ndcgAt5: number;
  ndcgAt10: number;
}

export interface EvaluationQuery {
  query: string;
  ranked: readonly string[];
  relevant: ReadonlySet<string>;
}

export function evaluate(
  queries: readonly EvaluationQuery[],
): EvaluationReport {
  if (queries.length === 0) {
    return {
      queryCount: 0,
      mrr: 0,
      recallAt5: 0,
      recallAt10: 0,
      precisionAt5: 0,
      precisionAt10: 0,
      ndcgAt5: 0,
      ndcgAt10: 0,
    };
  }
  const avg = (fn: (q: EvaluationQuery) => number) =>
    queries.reduce((sum, q) => sum + fn(q), 0) / queries.length;

  return {
    queryCount: queries.length,
    mrr: avg((q) => reciprocalRank(q.ranked, q.relevant)),
    recallAt5: avg((q) => recallAtK(q.ranked, q.relevant, 5)),
    recallAt10: avg((q) => recallAtK(q.ranked, q.relevant, 10)),
    precisionAt5: avg((q) => precisionAtK(q.ranked, q.relevant, 5)),
    precisionAt10: avg((q) => precisionAtK(q.ranked, q.relevant, 10)),
    ndcgAt5: avg((q) => ndcgAtK(q.ranked, q.relevant, 5)),
    ndcgAt10: avg((q) => ndcgAtK(q.ranked, q.relevant, 10)),
  };
}
