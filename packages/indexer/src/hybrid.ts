/**
 * Hybrid retrieval: fuses BM25 keyword hits with vector similarity hits
 * via Reciprocal Rank Fusion, preserving provenance of each signal.
 *
 * The vector store is abstracted: the in-memory engine accepts
 * precomputed embeddings (from @querynx/embeddings or any external
 * model), so semantic retrieval works without mandating a model.
 */

import type { RetrievalHit, RetrievalQuery } from './store.js';

/** A pluggable vector store over indexed document ids. */
export interface VectorStore {
  /** Upsert an embedding for a document id. */
  upsert(docId: string, embedding: readonly number[]): void;
  /** Remove a document's vector. */
  remove(docId: string): void;
  /** k nearest neighbors by cosine similarity. */
  search(embedding: readonly number[], k: number, collection?: string): Array<{ docId: string; similarity: number }>;
}

/** In-memory cosine-similarity vector store. */
export class MemoryVectorStore implements VectorStore {
  private readonly vectors = new Map<string, { values: readonly number[]; norm: number; collection?: string }>();

  upsert(docId: string, embedding: readonly number[]): void {
    this.vectors.set(docId, {
      values: embedding,
      norm: l2norm(embedding),
    });
  }

  remove(docId: string): void {
    this.vectors.delete(docId);
  }

  search(
    embedding: readonly number[],
    k: number,
    collection?: string
  ): Array<{ docId: string; similarity: number }> {
    const queryNorm = l2norm(embedding);
    if (queryNorm === 0) return [];
    const results: Array<{ docId: string; similarity: number }> = [];
    for (const [docId, stored] of this.vectors) {
      if (stored.norm === 0) continue;
      const dot = stored.values.reduce(
        (sum, v, i) => sum + v * (embedding[i] ?? 0),
        0
      );
      const similarity = dot / (queryNorm * stored.norm);
      results.push({ docId, similarity });
    }
    // Note: collection filtering is applied by the hybrid engine, which
    // owns collection membership; the store is intentionally dumb.
    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, k);
  }
}

function l2norm(vector: readonly number[]): number {
  return Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
}

export interface HybridHit extends RetrievalHit {
  /** Which retrieval systems returned this document. */
  sources: Array<'bm25' | 'vector'>;
}

export interface HybridEngineOptions {
  /** RRF constant; 60 is the standard choice. */
  rrfK?: number;
}

/**
 * Fuses BM25 and vector rankings with RRF. Documents found by both
 * systems rank highest, matching the directive's hybrid-search goal
 * without requiring a model for the keyword half.
 */
export function fuseHybrid(
  bm25Hits: readonly RetrievalHit[],
  vectorHits: ReadonlyArray<{ docId: string; similarity: number }>,
  documentsById: ReadonlyMap<string, RetrievalHit['document']>,
  options: HybridEngineOptions = {}
): HybridHit[] {
  const k = options.rrfK ?? 60;
  const fused = new Map<string, { rrf: number; sources: Set<'bm25' | 'vector'>; bm25Hit?: RetrievalHit }>();

  bm25Hits.forEach((hit, rank) => {
    const entry = fused.get(hit.document.id) ?? {
      rrf: 0,
      sources: new Set<'bm25' | 'vector'>(),
    };
    entry.rrf += 1 / (k + rank + 1);
    entry.sources.add('bm25');
    entry.bm25Hit = hit;
    fused.set(hit.document.id, entry);
  });

  vectorHits.forEach((hit, rank) => {
    const entry = fused.get(hit.docId) ?? {
      rrf: 0,
      sources: new Set<'bm25' | 'vector'>(),
    };
    entry.rrf += 1 / (k + rank + 1);
    entry.sources.add('vector');
    fused.set(hit.docId, entry);
  });

  return [...fused.entries()]
    .map(([docId, { rrf, sources, bm25Hit }]) => {
      if (bm25Hit) {
        return {
          document: bm25Hit.document,
          bm25Score: bm25Hit.bm25Score,
          score: rrf,
          matchedTerms: bm25Hit.matchedTerms,
          sources: [...sources],
        };
      }
      // Vector-only hit: look the document up by id.
      const doc = documentsById.get(docId);
      if (!doc) throw new Error(`fused hit references unknown document ${docId}`);
      return {
        document: doc,
        bm25Score: 0,
        score: rrf,
        matchedTerms: [],
        sources: [...sources],
      };
    })
    .sort((a, b) => b.score - a.score);
}

/** Convenience: RRF fuse two ranked lists of doc ids. */
export function reciprocalRankFusion(
  lists: ReadonlyArray<readonly string[]>,
  k = 60
): Array<{ docId: string; score: number }> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((docId, rank) => {
      scores.set(docId, (scores.get(docId) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return [...scores.entries()]
    .map(([docId, score]) => ({ docId, score }))
    .sort((a, b) => b.score - a.score);
}
