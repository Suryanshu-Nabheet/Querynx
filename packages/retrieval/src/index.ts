/**
 * Hybrid retrieval facade.
 *
 * Combines the BM25 engine (@querynx/indexer), the in-memory vector
 * store and an embedder (@querynx/embeddings) into one search call:
 * keyword hits and semantic hits fused by RRF, with source provenance.
 *
 * The indexer ships the pieces separately; this package is the
 * composition layer the API and research engine consume.
 */

import {
  MemorySearchEngine,
  MemoryVectorStore,
  fuseHybrid,
  type IndexedDocument,
  type RetrievalHit,
} from "@querynx/indexer";
import type { Embedder } from "@querynx/embeddings";
import { mapWithConcurrency } from "@querynx/shared";

export interface HybridSearchResult {
  document: IndexedDocument;
  /** Fused RRF score (unnormalized; use for ordering). */
  score: number;
  /** Which systems retrieved the document. */
  sources: Array<"bm25" | "vector">;
  /** BM25 matched terms when keyword retrieval contributed. */
  matchedTerms: string[];
  bm25Score: number;
}

export interface HybridSearchOptions {
  query: string;
  collection?: string;
  limit?: number;
  /** Fetch depth for each retrieval system before fusion. */
  candidateDepth?: number;
}

export class HybridRetrievalEngine {
  private readonly bm25: MemorySearchEngine;
  private readonly vectors = new MemoryVectorStore();
  private readonly embeddingByDoc = new Map<string, readonly number[]>();
  private readonly embedder: Embedder;
  private readonly rrfK: number;

  constructor(options: {
    bm25?: MemorySearchEngine;
    embedder: Embedder;
    rrfK?: number;
  }) {
    this.bm25 = options.bm25 ?? new MemorySearchEngine();
    this.embedder = options.embedder;
    this.rrfK = options.rrfK ?? 60;
  }

  /** Index a document: BM25 + embedding + vector upsert in one call. */
  async ingest(
    document: Omit<IndexedDocument, "id" | "indexedAt">,
  ): Promise<IndexedDocument> {
    const existing = this.bm25.findByUrl(document.url);
    const stored = this.bm25.index(
      existing ? { ...document, id: existing.id } : document,
    );

    const embedding = await this.embedder.embed(
      `${stored.title}\n${stored.content}`,
    );
    this.vectors.upsert(stored.id, embedding);
    this.embeddingByDoc.set(stored.id, embedding);
    return stored;
  }

  /** Ingest many documents under bounded concurrency. */
  async ingestBatch(
    documents: ReadonlyArray<Omit<IndexedDocument, "id" | "indexedAt">>,
    concurrency = 4,
  ): Promise<IndexedDocument[]> {
    return mapWithConcurrency(documents, concurrency, (d) => this.ingest(d));
  }

  /** Remove a document from all retrieval systems. */
  remove(id: string): boolean {
    this.vectors.remove(id);
    this.embeddingByDoc.delete(id);
    return this.bm25.remove(id);
  }

  /** The underlying BM25 engine (for stats/export). */
  get engine(): MemorySearchEngine {
    return this.bm25;
  }

  /**
   * Hybrid search: BM25 + vector nearest neighbors fused via RRF.
   * Works even when only one system matches (source attribution shows
   * which half contributed).
   */
  async search(options: HybridSearchOptions): Promise<HybridSearchResult[]> {
    const limit = options.limit ?? 10;
    const depth = options.candidateDepth ?? Math.max(limit * 3, 20);

    const bm25Hits: RetrievalHit[] = this.bm25.search({
      query: options.query,
      collection: options.collection,
      limit: depth,
    });

    const queryEmbedding = await this.embedder.embed(options.query);
    const vectorHits = this.vectors.search(queryEmbedding, depth);

    const docsById = new Map(
      this.bm25.documents().map((d) => [d.id, d] as const),
    );
    const fused = fuseHybrid(bm25Hits, vectorHits, docsById, {
      rrfK: this.rrfK,
    });

    // Collection filter for vector-only hits (vector store is dumb).
    const filtered = options.collection
      ? fused.filter((f) => f.document.collection === options.collection)
      : fused;

    return filtered.slice(0, limit).map((f) => ({
      document: f.document,
      score: f.score,
      sources: f.sources,
      matchedTerms: f.matchedTerms,
      bm25Score: f.bm25Score,
    }));
  }

  /** Vector-only semantic search (no keywords required). */
  async semanticSearch(
    text: string,
    limit = 10,
  ): Promise<Array<{ document: IndexedDocument; similarity: number }>> {
    const embedding = await this.embedder.embed(text);
    const hits = this.vectors.search(embedding, limit);
    const docsById = new Map(
      this.bm25.documents().map((d) => [d.id, d] as const),
    );
    return hits
      .map((h) => {
        const doc = docsById.get(h.docId);
        return doc ? { document: doc, similarity: h.similarity } : null;
      })
      .filter(
        (x): x is { document: IndexedDocument; similarity: number } =>
          x !== null,
      );
  }

  /** Corpus statistics. */
  stats(): { documents: number; vectors: number } {
    return {
      documents: this.bm25.stats().documents,
      vectors: this.embeddingByDoc.size,
    };
  }
}
