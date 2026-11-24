/**
 * Persistence adapter with the same contract the in-memory engines
 * implement. Postgres/Drizzle when DATABASE_URL is set; the API can
 * fall back to the in-memory engines otherwise, so local development
 * needs zero infrastructure.
 */

import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, desc, sql, and, count } from 'drizzle-orm';
import {
  documents,
  chunks,
  apiKeys,
  jobs,
  usageEvents,
} from './schema.js';

/** Row shape returned by raw sql queries over the documents table. */
type DocumentRow = typeof documents.$inferSelect;

export interface DocumentUpsert {
  collection: string;
  url: string;
  title: string;
  content: string;
  fingerprint: string;
  publishedAt?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface DocumentRecord extends DocumentUpsert {
  id: string;
  indexedAt: string;
}

export interface JobRecord {
  id: string;
  type: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  priority: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * SQL-backed document store. `upsert` is atomic on the url unique key.
 */
export class DocumentStore {
  constructor(
    private readonly db: PostgresJsDatabase<Record<string, never>>,
    private readonly query: postgres.Sql
  ) {}

  /** Insert or replace by URL; returns the stored row. */
  async upsert(doc: DocumentUpsert): Promise<DocumentRecord> {
    const [row] = await this.db
      .insert(documents)
      .values({
        collection: doc.collection,
        url: doc.url,
        title: doc.title,
        content: doc.content,
        fingerprint: doc.fingerprint,
        publishedAt: doc.publishedAt ? new Date(doc.publishedAt) : null,
        metadata: doc.metadata ?? null,
      })
      .onConflictDoUpdate({
        target: documents.url,
        set: {
          collection: doc.collection,
          title: doc.title,
          content: doc.content,
          fingerprint: doc.fingerprint,
          publishedAt: doc.publishedAt ? new Date(doc.publishedAt) : null,
          metadata: doc.metadata ?? null,
          indexedAt: new Date(),
        },
      })
      .returning();

    return rowToRecord(row!);
  }

  /** Replace all chunks for a document. */
  async replaceChunks(
    documentId: string,
    rows: ReadonlyArray<{
      ordinal: number;
      sectionTitle?: string | null;
      content: string;
      tokenEstimate: number;
      embedding?: readonly number[] | null;
    }>
  ): Promise<void> {
    await this.db.delete(chunks).where(eq(chunks.documentId, documentId));
    if (rows.length === 0) return;
    await this.db.insert(chunks).values(
      rows.map((r) => ({
        documentId,
        ordinal: r.ordinal,
        sectionTitle: r.sectionTitle ?? null,
        content: r.content,
        tokenEstimate: r.tokenEstimate,
        embedding: r.embedding ? [...r.embedding] : null,
      }))
    );
  }

  async findByUrl(url: string): Promise<DocumentRecord | null> {
    const [row] = await this.db.select().from(documents).where(eq(documents.url, url)).limit(1);
    return row ? rowToRecord(row) : null;
  }

  async delete(id: string): Promise<boolean> {
    const res = await this.db.delete(documents).where(eq(documents.id, id)).returning();
    return res.length > 0;
  }

  async stats(): Promise<{
    documents: number;
    collections: number;
    contentChars: number;
  }> {
    const [row] = await this.db
      .select({
        documents: count(),
        collections: sql<number>`count(distinct ${documents.collection})`,
        contentChars: sql<number>`coalesce(sum(length(${documents.content})), 0)`,
      })
      .from(documents);
    return {
      documents: Number(row?.documents ?? 0),
      collections: Number(row?.collections ?? 0),
      contentChars: Number(row?.contentChars ?? 0),
    };
  }

  /** Full-text search using Postgres tsquery ranking (production path
   * for /v1/search/semantic when DATABASE_URL is configured). */
  async fullTextSearch(
    queryText: string,
    options: { collection?: string; limit?: number } = {}
  ): Promise<Array<{ document: DocumentRecord; rank: number }>> {
    const limit = options.limit ?? 10;
    const rows = await this.query<Array<DocumentRow & { rank: number | string }>>`
      SELECT d.*, ts_rank(
        to_tsvector('english', d.title || ' ' || d.content),
        websearch_to_tsquery('english', ${queryText})
      ) AS rank
      FROM documents d
      WHERE to_tsvector('english', d.title || ' ' || d.content)
        @@ websearch_to_tsquery('english', ${queryText})
      ${options.collection ? this.query`AND d.collection = ${options.collection}` : this.query``}
      ORDER BY rank DESC
      LIMIT ${limit}
    `;
    const list = (rows as unknown as Array<DocumentRow & { rank: number | string }>) ?? [];
    return list.map((row) => ({
      document: rowToRecord(row),
      rank: Number(row.rank),
    }));
  }
}

/** Durable job store used by the queue and /v1/jobs endpoints. */
export class JobStore {
  constructor(private readonly db: PostgresJsDatabase<Record<string, never>>) {}

  async create(
    type: string,
    payload: Record<string, unknown>,
    priority = 0
  ): Promise<JobRecord> {
    const [row] = await this.db
      .insert(jobs)
      .values({ type, payload, priority })
      .returning();
    return rowToJob(row!);
  }

  async get(id: string): Promise<JobRecord | null> {
    const [row] = await this.db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
    return row ? rowToJob(row) : null;
  }

  /** Claim the highest-priority pending job (atomic state transition). */
  async claimNext(): Promise<JobRecord | null> {
    const [row] = await this.db
      .update(jobs)
      .set({ status: 'running', startedAt: new Date() })
      .where(
        and(
          eq(jobs.status, 'pending'),
          sql`${jobs.id} = (
            SELECT id FROM jobs WHERE status = 'pending'
            ORDER BY priority DESC, created_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )`
        )
      )
      .returning();
    return row ? rowToJob(row) : null;
  }

  async complete(id: string, result: Record<string, unknown>): Promise<void> {
    await this.db
      .update(jobs)
      .set({ status: 'completed', result, finishedAt: new Date() })
      .where(eq(jobs.id, id));
  }

  async fail(id: string, error: string): Promise<void> {
    await this.db
      .update(jobs)
      .set({ status: 'failed', error, finishedAt: new Date() })
      .where(eq(jobs.id, id));
  }

  async cancel(id: string): Promise<boolean> {
    const res = await this.db
      .update(jobs)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(and(eq(jobs.id, id), eq(jobs.status, 'pending')))
      .returning();
    return res.length > 0;
  }

  /** Recover jobs stuck in running (worker crash) back to pending. */
  async recoverStuck(olderThanMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const res = await this.db
      .update(jobs)
      .set({ status: 'pending', startedAt: null })
      .where(and(eq(jobs.status, 'running'), sql`${jobs.startedAt} < ${cutoff}`))
      .returning();
    return res.length;
  }

  async recent(limit = 50): Promise<JobRecord[]> {
    const rows = await this.db
      .select()
      .from(jobs)
      .orderBy(desc(jobs.createdAt))
      .limit(limit);
    return rows.map(rowToJob);
  }
}

/** API-key persistence. */
export class ApiKeyDbStore {
  constructor(private readonly db: PostgresJsDatabase<Record<string, never>>) {}

  async load(): Promise<Array<{ hash: string; label: string; revoked: boolean }>> {
    const rows = await this.db
      .select({ hash: apiKeys.hash, label: apiKeys.label, revoked: apiKeys.revoked })
      .from(apiKeys);
    return rows;
  }

  async save(record: { hash: string; label: string; rateLimitPerMinute?: number }): Promise<void> {
    await this.db
      .insert(apiKeys)
      .values(record)
      .onConflictDoUpdate({
        target: apiKeys.hash,
        set: { label: record.label },
      });
  }

  async revoke(hash: string): Promise<boolean> {
    const res = await this.db
      .update(apiKeys)
      .set({ revoked: true })
      .where(eq(apiKeys.hash, hash))
      .returning();
    return res.length > 0;
  }
}

/** Usage accounting. */
export class UsageStore {
  constructor(private readonly db: PostgresJsDatabase<Record<string, never>>) {}

  async record(event: {
    apiKeyHash?: string | null;
    route: string;
    statusCode: number;
    durationMs: number;
  }): Promise<void> {
    await this.db.insert(usageEvents).values(event);
  }

  async summary(hours = 24): Promise<{
    totalRequests: number;
    byRoute: Record<string, number>;
    p95DurationMs: number;
  }> {
    const since = new Date(Date.now() - hours * 3_600_000);
    const rows = await this.db
      .select({
        route: usageEvents.route,
        total: count(),
        p95: sql<number>`percentile_cont(0.95) WITHIN GROUP (ORDER BY ${usageEvents.durationMs})`,
      })
      .from(usageEvents)
      .where(sql`${usageEvents.createdAt} > ${since}`)
      .groupBy(usageEvents.route);

    let total = 0;
    let p95 = 0;
    const byRoute: Record<string, number> = {};
    for (const row of rows) {
      const c = Number(row.total);
      byRoute[row.route] = c;
      total += c;
      p95 = Math.max(p95, Number(row.p95 ?? 0));
    }
    return { totalRequests: total, byRoute, p95DurationMs: Math.round(p95) };
  }
}

function rowToRecord(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    collection: row.collection,
    url: row.url,
    title: row.title,
    content: row.content,
    fingerprint: row.fingerprint,
    publishedAt: row.publishedAt ? new Date(row.publishedAt).toISOString() : null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    indexedAt: new Date(row.indexedAt).toISOString(),
  };
}

function rowToJob(row: typeof jobs.$inferSelect): JobRecord {
  return {
    id: row.id,
    type: row.type,
    status: row.status as JobRecord['status'],
    payload: (row.payload as Record<string, unknown>) ?? {},
    result: (row.result as Record<string, unknown> | null) ?? null,
    error: row.error,
    priority: row.priority,
    createdAt: new Date(row.createdAt).toISOString(),
    startedAt: row.startedAt ? new Date(row.startedAt).toISOString() : null,
    finishedAt: row.finishedAt ? new Date(row.finishedAt).toISOString() : null,
  };
}

/** Connect all stores to a DATABASE_URL. */
export function connectStores(databaseUrl: string): {
  documentStore: DocumentStore;
  jobStore: JobStore;
  apiKeyStore: ApiKeyDbStore;
  usageStore: UsageStore;
  close: () => Promise<void>;
} {
  const client = postgres(databaseUrl, { max: 10 });
  const db = drizzle(client);
  return {
    documentStore: new DocumentStore(db, client),
    jobStore: new JobStore(db),
    apiKeyStore: new ApiKeyDbStore(db),
    usageStore: new UsageStore(db),
    close: () => client.end(),
  };
}
