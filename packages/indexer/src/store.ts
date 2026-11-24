/**
 * Document model and storage contract for the indexer.
 */

import type { ExtractedDocument } from '@querynx/types';

/** A document indexed into a collection. */
export interface IndexedDocument {
  /** Storage-assigned unique id. */
  id: string;
  /** Original source URL (canonical). */
  url: string;
  /** Document title. */
  title: string;
  /** Main content text. */
  content: string;
  /** Collection the document belongs to. */
  collection: string;
  /** Publication date ISO 8601 when known. */
  publishedAt?: string;
  /** Fetched-at timestamp. */
  indexedAt: string;
  /** Content fingerprint (dedupe and change detection). */
  fingerprint: string;
  /** Metadata blob (JSON-LD, OG, language, author). */
  metadata?: Record<string, unknown>;
}

/** Convert an extracted web document into an indexable one. */
export function fromExtractedDocument(
  doc: ExtractedDocument,
  collection: string
): Omit<IndexedDocument, 'id' | 'indexedAt'> {
  return {
    url: doc.url,
    title: doc.title ?? doc.url,
    content: doc.content,
    collection,
    publishedAt: doc.metadata?.publishedAt,
    fingerprint: doc.fingerprint,
    metadata: doc.metadata as Record<string, unknown> | undefined,
  };
}

/** Query for retrieving from a collection. */
export interface RetrievalQuery {
  /** Free-text query. */
  query: string;
  /** Restrict to one collection. */
  collection?: string;
  /** Maximum hits. */
  limit: number;
  /** Optional domain filter. */
  domains?: readonly string[];
  /** Optional date lower bound (ISO). */
  publishedAfter?: string;
}

/** A retrieval hit. */
export interface RetrievalHit {
  document: IndexedDocument;
  /** BM25 score, unbounded positive. */
  bm25Score: number;
  /** Normalized relevance in [0, 1] after fusion. */
  score: number;
  /** Which terms matched (for highlighting). */
  matchedTerms: string[];
}

export interface IndexStats {
  documents: number;
  collections: number;
  uniqueTerms: number;
  /** Total indexed content characters. */
  contentChars: number;
}
