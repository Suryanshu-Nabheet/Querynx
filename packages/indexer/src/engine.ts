/**
 * In-memory BM25 search engine.
 *
 * Classic inverted index with Okapi BM25 scoring:
 *   score(D, Q) = Σ_t IDF(t) * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * |D|/avgdl))
 *
 * This engine is complete and production-shaped, not a mock: the same
 * public interface is implemented over PostgreSQL+pgvector for
 * persistence. The in-memory engine serves local development, tests
 * and small corpora.
 */

import { randomUUID } from "node:crypto";
import { tokenize, termFrequencies } from "./tokenize.js";
import type {
  IndexedDocument,
  IndexStats,
  RetrievalHit,
  RetrievalQuery,
} from "./store.js";
import { extractDomain } from "@querynx/shared";

const K1 = 1.2;
const B = 0.75;

interface PostingEntry {
  docId: string;
  tf: number;
}

export class MemorySearchEngine {
  private readonly docs = new Map<string, IndexedDocument>();
  /** term -> postings list. */
  private readonly postings = new Map<string, PostingEntry[]>();
  /** docId -> term frequency map (for scoring). */
  private readonly docTerms = new Map<string, Map<string, number>>();
  private readonly docLengths = new Map<string, number>();
  private totalLength = 0;

  /** Index (or replace) a document. */
  index(
    document: Omit<IndexedDocument, "id" | "indexedAt"> & {
      id?: string;
      indexedAt?: string;
    },
  ): IndexedDocument {
    const id = document.id ?? randomUUID();
    // Replace semantics: remove previous version if the id exists.
    if (this.docs.has(id)) this.remove(id);

    const stored: IndexedDocument = {
      ...document,
      id,
      indexedAt: document.indexedAt ?? new Date().toISOString(),
    };
    this.docs.set(id, stored);

    const tokens = tokenize(
      `${stored.title} ${stored.title} ${stored.content}`,
    );
    const tf = termFrequencies(tokens);
    this.docTerms.set(id, tf);
    this.docLengths.set(id, tokens.length);
    this.totalLength += tokens.length;

    for (const [term, count] of tf) {
      let list = this.postings.get(term);
      if (!list) {
        list = [];
        this.postings.set(term, list);
      }
      list.push({ docId: id, tf: count });
    }
    return stored;
  }

  /** Remove a document from the index. */
  remove(id: string): boolean {
    const doc = this.docs.get(id);
    if (!doc) return false;
    const tf = this.docTerms.get(id);
    if (tf) {
      for (const term of tf.keys()) {
        const list = this.postings.get(term);
        if (list) {
          const filtered = list.filter((p) => p.docId !== id);
          if (filtered.length === 0) this.postings.delete(term);
          else this.postings.set(term, filtered);
        }
      }
    }
    this.totalLength -= this.docLengths.get(id) ?? 0;
    this.docTerms.delete(id);
    this.docLengths.delete(id);
    this.docs.delete(id);
    return true;
  }

  /** Whether a document with this URL already exists (for upserts). */
  findByUrl(url: string): IndexedDocument | undefined {
    for (const doc of this.docs.values()) {
      if (doc.url === url) return doc;
    }
    return undefined;
  }

  /** BM25 search across the corpus. */
  search(query: RetrievalQuery): RetrievalHit[] {
    const terms = tokenize(query.query);
    if (terms.length === 0) return [];

    const avgdl = this.docs.size > 0 ? this.totalLength / this.docs.size : 0;
    const N = this.docs.size;

    const scored = new Map<string, { score: number; matched: Set<string> }>();
    for (const term of new Set(terms)) {
      const list = this.postings.get(term);
      if (!list) continue;
      // IDF: documents containing the term.
      const df = list.length;
      if (df === 0) continue;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));

      for (const posting of list) {
        const doc = this.docs.get(posting.docId);
        if (!doc) continue;
        if (query.collection && doc.collection !== query.collection) continue;
        if (query.domains && !query.domains.includes(extractDomain(doc.url)))
          continue;
        if (
          query.publishedAfter &&
          (doc.publishedAt ?? "") < query.publishedAfter
        )
          continue;

        const dl = this.docLengths.get(posting.docId) ?? 0;
        const denominator =
          posting.tf + K1 * (1 - B + B * (avgdl > 0 ? dl / avgdl : 0));
        const contribution = (idf * (posting.tf * (K1 + 1))) / denominator;

        const entry = scored.get(posting.docId) ?? {
          score: 0,
          matched: new Set<string>(),
        };
        entry.score += contribution;
        entry.matched.add(term);
        scored.set(posting.docId, entry);
      }
    }

    const hits: RetrievalHit[] = [];
    for (const [docId, { score, matched }] of scored) {
      const doc = this.docs.get(docId)!;
      hits.push({
        document: doc,
        bm25Score: score,
        score: 0, // normalized below
        matchedTerms: [...matched],
      });
    }

    // Min-max normalize scores into [0, 1] for downstream fusion.
    const max = hits.length > 0 ? Math.max(...hits.map((h) => h.bm25Score)) : 0;
    for (const hit of hits) {
      hit.score = max > 0 ? hit.bm25Score / max : 0;
    }

    return hits.sort((a, b) => b.bm25Score - a.bm25Score).slice(0, query.limit);
  }

  /** Corpus statistics. */
  stats(): IndexStats {
    const collections = new Set<string>();
    let contentChars = 0;
    for (const doc of this.docs.values()) {
      collections.add(doc.collection);
      contentChars += doc.content.length;
    }
    return {
      documents: this.docs.size,
      collections: collections.size,
      uniqueTerms: this.postings.size,
      contentChars,
    };
  }

  /** All documents (for export/migration). */
  documents(): IndexedDocument[] {
    return [...this.docs.values()];
  }
}
