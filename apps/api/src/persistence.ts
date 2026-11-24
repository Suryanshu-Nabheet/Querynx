/**
 * Persistence wiring: a document index that transparently backs the
 * in-memory BM25 engine with Postgres when DATABASE_URL is set.
 *
 * - Writes go to both: Postgres is durable truth, memory serves queries.
 * - On boot, the in-memory index rehydrates from Postgres so restarts
 *   no longer lose the corpus.
 * - Postgres failures never block the request path: the write is
 *   mirrored, errors surface via metrics, and the url unique key
 *   self-heals on the next upsert.
 * - Without DATABASE_URL the memory engine stands alone (dev mode).
 */

import type { MemorySearchEngine, IndexedDocument } from "@querynx/indexer";
import type { DocumentStore } from "@querynx/database";
import { metrics } from "@querynx/observability";

export interface PersistenceOptions {
  documentStore?: DocumentStore;
  memoryEngine: MemorySearchEngine;
}

export class PersistentIndex {
  private readonly store?: DocumentStore;
  private readonly memory: MemorySearchEngine;

  constructor(options: PersistenceOptions) {
    this.store = options.documentStore;
    this.memory = options.memoryEngine;
  }

  /** True when durable persistence is active. */
  get persistent(): boolean {
    return this.store !== undefined;
  }

  /**
   * Rehydrate the memory index from Postgres. Cursor-paged so the
   * corpus can exceed RAM-safe batch sizes; stops at the first empty
   * page. Safe to call on every boot.
   */
  async rehydrate(): Promise<number> {
    if (!this.store) return 0;
    let cursor: string | undefined;
    let total = 0;
    for (;;) {
      const batch = await this.store.scan({ limit: 500, afterId: cursor });
      if (batch.length === 0) break;
      for (const record of batch) {
        this.memory.index({
          id: record.id,
          url: record.url,
          title: record.title,
          content: record.content,
          collection: record.collection,
          fingerprint: record.fingerprint,
          publishedAt: record.publishedAt ?? undefined,
          metadata: record.metadata ?? undefined,
          indexedAt: record.indexedAt,
        });
      }
      total += batch.length;
      cursor = batch.at(-1)!.id;
      if (batch.length < 500) break;
    }
    metrics.setGauge("persistence_rehydrated_documents", total);
    return total;
  }

  /**
   * Index a document: memory always, Postgres when configured.
   * Mirrored writes log + count failures instead of failing requests.
   */
  async index(
    document: Omit<IndexedDocument, "id" | "indexedAt">,
  ): Promise<IndexedDocument> {
    const stored = this.memory.index(document);
    if (this.store) {
      try {
        await this.store.upsert({
          collection: stored.collection,
          url: stored.url,
          title: stored.title,
          content: stored.content,
          fingerprint: stored.fingerprint,
          publishedAt: stored.publishedAt ?? null,
          metadata: stored.metadata ?? null,
        });
        metrics.inc("persistence_upserts");
      } catch (err) {
        metrics.inc("persistence_errors");
        console.warn(
          `[persistence] upsert failed for ${stored.url}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return stored;
  }

  /** Corpus stats (live memory engine). */
  stats(): ReturnType<MemorySearchEngine["stats"]> {
    return this.memory.stats();
  }

  /** BM25 search stays fully in-memory. */
  search(query: Parameters<MemorySearchEngine["search"]>[0]) {
    return this.memory.search(query);
  }

  /** The live engine (dashboard/tests). */
  get engine(): MemorySearchEngine {
    return this.memory;
  }
}
