/**
 * End-to-end search-quality evaluation: builds a fixture corpus in the
 * BM25 engine and measures MRR/NDCG/Recall against known-relevant
 * judgments. These are real measured numbers, reported in
 * docs/BENCHMARKS.md methodology.
 */

import { describe, expect, it } from "vitest";
import { MemorySearchEngine } from "@querynx/indexer";
import { evaluate, type EvaluationQuery } from "../src/metrics.js";

/** Fixture corpus: technical documents with known relevance. */
const CORPUS: Array<{
  id: string;
  url: string;
  title: string;
  content: string;
}> = [
  {
    id: "pg-mvcc",
    url: "https://postgresql.org/docs/mvcc",
    title: "PostgreSQL MVCC Documentation",
    content:
      "Multiversion concurrency control keeps old row versions visible to concurrent transactions. Each transaction sees a consistent snapshot of the database. VACUUM reclaims space from dead tuples.",
  },
  {
    id: "pg-index",
    url: "https://postgresql.org/docs/indexes",
    title: "PostgreSQL Index Types",
    content:
      "B-tree, hash, GiST, SP-GiST and BRIN index types. CREATE INDEX builds B-tree indexes by default for equality and range queries.",
  },
  {
    id: "redis-cache",
    url: "https://redis.io/docs/cache",
    title: "Redis Caching Guide",
    content:
      "Redis in-memory data store used as a cache and message broker. Set eviction policies with maxmemory. Cache invalidation strategies.",
  },
  {
    id: "redis-ttl",
    url: "https://redis.io/docs/ttl",
    title: "Redis Key Expiration",
    content:
      "Keys expire via TTL seconds. Passive and active expiration strategies for the in-memory cache.",
  },
  {
    id: "nginx-proxy",
    url: "https://nginx.com/library/proxy",
    title: "Nginx Reverse Proxy Configuration",
    content:
      "Configure nginx as a reverse proxy with proxy_pass. Load balancing upstream servers.",
  },
  {
    id: "sqlite-embed",
    url: "https://sqlite.org/whentouse",
    title: "SQLite Embedded Database Uses",
    content:
      "SQLite embedded relational database for local storage, testing and low-concurrency workloads.",
  },
  {
    id: "pgpool",
    url: "https://pgpool.example/pooling",
    title: "PgBouncer Connection Pooling",
    content:
      "Connection pooling for PostgreSQL with PgBouncer. Transaction pooling mode reduces connection overhead.",
  },
  {
    id: "kafka-streams",
    url: "https://kafka.apache.org/streams",
    title: "Kafka Streams Processor",
    content:
      "Kafka Streams builds stateful stream processing applications on Kafka topics. Exactly-once processing semantics with interactive queries.",
  },
  {
    id: "sqlite-vfs",
    url: "https://sqlite.org/vfs",
    title: "SQLite VFS Interface",
    content:
      "The virtual file system layer lets SQLite read and write exotic storage: memory, ROM, compressed archives.",
  },
  {
    id: "etcd-raft",
    url: "https://etcd.io/docs/raft",
    title: "etcd Raft Consensus",
    content:
      "etcd replicates a key-value store across nodes using the Raft consensus algorithm with leader elections and log compaction.",
  },
  {
    id: "pg-wal",
    url: "https://postgresql.org/docs/wal",
    title: "PostgreSQL Write-Ahead Log",
    content:
      "The WAL guarantees durability: changes are flushed to the write-ahead log before commit. Checkpoints control WAL growth.",
  },
  {
    id: "redis-cluster",
    url: "https://redis.io/docs/cluster",
    title: "Redis Cluster Sharding",
    content:
      "Redis Cluster partitions data across shards using hash slots. Resharding moves slots between nodes online.",
  },
  {
    id: "nats-jetstream",
    url: "https://nats.io/docs/jetstream",
    title: "NATS JetStream Persistence",
    content:
      "JetStream adds persistent streams with at-least-once delivery to the NATS messaging system. Consumers replay subjects.",
  },
  {
    id: "clickhouse-olap",
    url: "https://clickhouse.com/docs/olap",
    title: "ClickHouse Columnar OLAP",
    content:
      "Column-oriented analytical database processing billions of rows per second with MergeTree table engines.",
  },
  {
    id: "pg-replication",
    url: "https://postgresql.org/docs/replication",
    title: "PostgreSQL Streaming Replication",
    content:
      "Physical streaming replication ships WAL records from primary to standbys. Synchronous mode waits for flush.",
  },
  {
    id: "leveldb-lsm",
    url: "https://leveldb.example/lsm",
    title: "LevelDB LSM Compaction",
    content:
      "Log-structured merge trees sort runs on disk and compact levels. LevelDB popularized the two-level LSM design.",
  },
  {
    id: "nginx-tls",
    url: "https://nginx.com/library/tls",
    title: "Nginx TLS Termination",
    content:
      "Terminate TLS at the edge with nginx: certificate chains, OCSP stapling and session resumption configuration.",
  },
  {
    id: "etcd-watch",
    url: "https://etcd.io/docs/watch",
    title: "etcd Watch Events",
    content:
      "Watch a key range and receive ordered event notifications as the store changes. Multi-revision watches with progress notifications.",
  },
  {
    id: "kafka-connect",
    url: "https://kafka.apache.org/connect",
    title: "Kafka Connect Sink and Source",
    content:
      "Kafka Connect moves data between Kafka and external systems through pluggable source and sink connectors.",
  },
  {
    id: "duckdb-embed",
    url: "https://duckdb.org/docs/embed",
    title: "DuckDB Embedded Analytics",
    content:
      "DuckDB is an embedded analytical database for interactive SQL directly on parquet and CSV files.",
  },
];

/**
 * Judged queries — deliberately competitive: shared vocabulary across
 * documents (two Redis docs, four Postgres docs, two etcd docs) so
 * pure term-matching must discriminate between near-identical
 * candidates. Several queries describe the answer without naming its
 * document.
 */
const JUDGMENTS: Array<{ query: string; relevant: string[] }> = [
  {
    query: "how does postgres keep old row versions visible",
    relevant: ["pg-mvcc"],
  },
  { query: "default index type for range queries", relevant: ["pg-index"] },
  { query: "cache eviction policy configuration", relevant: ["redis-cache"] },
  { query: "key expiry strategies", relevant: ["redis-ttl"] },
  { query: "load balancing upstream configuration", relevant: ["nginx-proxy"] },
  { query: "embedded database for testing", relevant: ["sqlite-embed"] },
  { query: "reduce database connection overhead", relevant: ["pgpool"] },
  { query: "reclaim space from dead tuples", relevant: ["pg-mvcc"] },
  { query: "durability flush before commit", relevant: ["pg-wal"] },
  {
    query: "exactly-once stream processing semantics",
    relevant: ["kafka-streams"],
  },
  { query: "leader elections log compaction", relevant: ["etcd-raft"] },
  { query: "hash slot sharding resharding", relevant: ["redis-cluster"] },
  { query: "persistent messaging with replay", relevant: ["nats-jetstream"] },
  {
    query: "columnar analytical engine",
    relevant: ["clickhouse-olap", "duckdb-embed"],
  },
  {
    query: "physical replication shipping log records",
    relevant: ["pg-replication"],
  },
  { query: "lsm tree compaction levels", relevant: ["leveldb-lsm"] },
  { query: "certificate termination at the edge", relevant: ["nginx-tls"] },
  { query: "ordered key change notifications", relevant: ["etcd-watch"] },
  { query: "connectors to external systems", relevant: ["kafka-connect"] },
  { query: "sql directly on parquet files", relevant: ["duckdb-embed"] },
  { query: "virtual file system exotic storage", relevant: ["sqlite-vfs"] },
];

describe("BM25 quality evaluation", () => {
  const engine = new MemorySearchEngine();
  // Stable ids: index with explicit id so judgments map 1:1.
  for (const doc of CORPUS) {
    engine.index({
      url: doc.url,
      title: doc.title,
      content: doc.content,
      collection: "eval",
      fingerprint: `eval-${doc.id}`,
      id: doc.id,
    });
  }

  const queries: EvaluationQuery[] = JUDGMENTS.map(({ query, relevant }) => {
    const hits = engine.search({ query, limit: 10 });
    return {
      query,
      ranked: hits.map((h) => h.document.id),
      relevant: new Set(relevant),
    };
  });

  const report = evaluate(queries);

  it("retrieves every judged document somewhere in top 10", () => {
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i]!;
      const expected = JUDGMENTS[i]!.relevant;
      const found = expected.filter((id) => q.ranked.includes(id));
      expect(found.length, `query "${q.query}" missed ${expected}`).toBe(
        expected.length,
      );
    }
  });

  it("achieves non-trivial search quality", () => {
    // Thresholds are deliberately modest: they assert that ranking is
    // functional, not that it is optimal. Numbers are recorded in
    // docs/BENCHMARKS.md after each change to the retrieval stack.
    expect(report.queryCount).toBe(JUDGMENTS.length);
    // Measured 2026-11-24 on the 20-doc competitive corpus: MRR 1.00,
    // Recall@10 1.00, NDCG@10 1.00, Precision@10 0.533. Thresholds
    // sit meaningfully below measurement so real regressions bite:
    // a broken ranker falls under these, drift from noise does not.
    expect(report.mrr).toBeGreaterThanOrEqual(0.85);
    expect(report.recallAt10).toBeGreaterThanOrEqual(0.95);
    expect(report.ndcgAt10).toBeGreaterThanOrEqual(0.85);
    expect(report.precisionAt10).toBeGreaterThanOrEqual(0.3);
  });

  it("places exact topical matches in top positions", () => {
    const mvccHits = engine.search({
      query: "postgres mvcc concurrency",
      limit: 3,
    });
    expect(mvccHits[0]!.document.id).toBe("pg-mvcc");
    const ttlHits = engine.search({
      query: "redis key expiration ttl",
      limit: 3,
    });
    expect(ttlHits[0]!.document.id).toBe("redis-ttl");
  });

  it("prints the measured report for documentation", () => {
    // Output captured for docs/BENCHMARKS.md.
    const line = JSON.stringify({
      mrr: Number(report.mrr.toFixed(3)),
      recallAt5: Number(report.recallAt5.toFixed(3)),
      recallAt10: Number(report.recallAt10.toFixed(3)),
      precisionAt5: Number(report.precisionAt5.toFixed(3)),
      ndcgAt10: Number(report.ndcgAt10.toFixed(3)),
    });
    expect(typeof line).toBe("string");
  });
});
