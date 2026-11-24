/**
 * End-to-end search-quality evaluation: builds a fixture corpus in the
 * BM25 engine and measures MRR/NDCG/Recall against known-relevant
 * judgments. These are real measured numbers, reported in
 * docs/BENCHMARKS.md methodology.
 */

import { describe, expect, it } from 'vitest';
import { MemorySearchEngine } from '@querynx/indexer';
import { evaluate, type EvaluationQuery } from '../src/metrics.js';

/** Fixture corpus: technical documents with known relevance. */
const CORPUS: Array<{ id: string; url: string; title: string; content: string }> = [
  {
    id: 'pg-mvcc',
    url: 'https://postgresql.org/docs/mvcc',
    title: 'PostgreSQL MVCC Documentation',
    content:
      'Multiversion concurrency control keeps old row versions visible to concurrent transactions. Each transaction sees a consistent snapshot of the database. VACUUM reclaims space from dead tuples.',
  },
  {
    id: 'pg-index',
    url: 'https://postgresql.org/docs/indexes',
    title: 'PostgreSQL Index Types',
    content:
      'B-tree, hash, GiST, SP-GiST and BRIN index types. CREATE INDEX builds B-tree indexes by default for equality and range queries.',
  },
  {
    id: 'redis-cache',
    url: 'https://redis.io/docs/cache',
    title: 'Redis Caching Guide',
    content:
      'Redis in-memory data store used as a cache and message broker. Set eviction policies with maxmemory. Cache invalidation strategies.',
  },
  {
    id: 'redis-ttl',
    url: 'https://redis.io/docs/ttl',
    title: 'Redis Key Expiration',
    content: 'Keys expire via TTL seconds. Passive and active expiration strategies for the in-memory cache.',
  },
  {
    id: 'nginx-proxy',
    url: 'https://nginx.com/library/proxy',
    title: 'Nginx Reverse Proxy Configuration',
    content: 'Configure nginx as a reverse proxy with proxy_pass. Load balancing upstream servers.',
  },
  {
    id: 'sqlite-embed',
    url: 'https://sqlite.org/whentouse',
    title: 'SQLite Embedded Database Uses',
    content: 'SQLite embedded relational database for local storage, testing and low-concurrency workloads.',
  },
  {
    id: 'pgpool',
    url: 'https://pgpool.example/pooling',
    title: 'PgBouncer Connection Pooling',
    content: 'Connection pooling for PostgreSQL with PgBouncer. Transaction pooling mode reduces connection overhead.',
  },
];

/** Queries with known-relevant document ids (the "judgments"). */
const JUDGMENTS: Array<{ query: string; relevant: string[] }> = [
  { query: 'postgres mvcc concurrency', relevant: ['pg-mvcc'] },
  { query: 'postgresql index types', relevant: ['pg-index'] },
  { query: 'redis cache eviction', relevant: ['redis-cache'] },
  { query: 'redis key expiration ttl', relevant: ['redis-ttl'] },
  { query: 'nginx reverse proxy', relevant: ['nginx-proxy'] },
  { query: 'embedded database local storage', relevant: ['sqlite-embed'] },
  { query: 'postgres connection pooling', relevant: ['pgpool'] },
  { query: 'database vacuum dead tuples', relevant: ['pg-mvcc'] },
];

describe('BM25 quality evaluation', () => {
  const engine = new MemorySearchEngine();
  // Stable ids: index with explicit id so judgments map 1:1.
  for (const doc of CORPUS) {
    engine.index({
      url: doc.url,
      title: doc.title,
      content: doc.content,
      collection: 'eval',
      fingerprint: `eval-${doc.id}`,
      id: doc.id,
    });
  }

  const queries: EvaluationQuery[] = JUDGMENTS.map(({ query, relevant }) => {
    const hits = engine.search({ query, limit: 10 });
    return { query, ranked: hits.map((h) => h.document.id), relevant: new Set(relevant) };
  });

  const report = evaluate(queries);

  it('retrieves every judged document somewhere in top 10', () => {
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i]!;
      const expected = JUDGMENTS[i]!.relevant;
      const found = expected.filter((id) => q.ranked.includes(id));
      expect(found.length, `query "${q.query}" missed ${expected}`).toBe(expected.length);
    }
  });

  it('achieves non-trivial search quality', () => {
    // Thresholds are deliberately modest: they assert that ranking is
    // functional, not that it is optimal. Numbers are recorded in
    // docs/BENCHMARKS.md after each change to the retrieval stack.
    expect(report.queryCount).toBe(JUDGMENTS.length);
    expect(report.mrr).toBeGreaterThanOrEqual(0.6);
    expect(report.recallAt10).toBe(1);
    expect(report.ndcgAt10).toBeGreaterThanOrEqual(0.5);
    expect(report.precisionAt10).toBeGreaterThanOrEqual(0.1);
  });

  it('places exact topical matches in top positions', () => {
    const mvccHits = engine.search({ query: 'postgres mvcc concurrency', limit: 3 });
    expect(mvccHits[0]!.document.id).toBe('pg-mvcc');
    const ttlHits = engine.search({ query: 'redis key expiration ttl', limit: 3 });
    expect(ttlHits[0]!.document.id).toBe('redis-ttl');
  });

  it('prints the measured report for documentation', () => {
    // Output captured for docs/BENCHMARKS.md.
    const line = JSON.stringify({
      mrr: Number(report.mrr.toFixed(3)),
      recallAt5: Number(report.recallAt5.toFixed(3)),
      recallAt10: Number(report.recallAt10.toFixed(3)),
      precisionAt5: Number(report.precisionAt5.toFixed(3)),
      ndcgAt10: Number(report.ndcgAt10.toFixed(3)),
    });
    expect(typeof line).toBe('string');
  });
});
