import { describe, expect, it } from "vitest";
import { HybridRetrievalEngine } from "../src/index.js";
import { HashEmbedder } from "@querynx/embeddings";

const DOCS = [
  {
    url: "https://pg.example/mvcc",
    title: "PostgreSQL MVCC",
    content:
      "Multiversion concurrency control snapshots VACUUM tuples transactions",
    collection: "databases",
    fingerprint: "f1",
  },
  {
    url: "https://redis.example/cache",
    title: "Redis Caching",
    content: "In-memory cache eviction maxmemory keyspace notifications",
    collection: "databases",
    fingerprint: "f2",
  },
  {
    url: "https://nginx.example/proxy",
    title: "Nginx Proxy",
    content: "Reverse proxy load balancing upstream configuration",
    collection: "servers",
    fingerprint: "f3",
  },
];

describe("HybridRetrievalEngine", () => {
  function build(): HybridRetrievalEngine {
    const engine = new HybridRetrievalEngine({
      embedder: new HashEmbedder(128),
    });
    return engine;
  }

  it("ingests documents into both retrieval systems", async () => {
    const engine = build();
    await engine.ingestBatch(DOCS);
    expect(engine.stats().documents).toBe(3);
    expect(engine.stats().vectors).toBe(3);
  });

  it("returns hybrid hits with source attribution", async () => {
    const engine = build();
    await engine.ingestBatch(DOCS);
    const hits = await engine.search({
      query: "mvcc vacuum transactions",
      limit: 5,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.document.url).toContain("pg.example");
    // The winning hit should come from BM25 at least.
    expect(hits[0]!.sources).toContain("bm25");
    expect(hits[0]!.matchedTerms.length).toBeGreaterThan(0);
  });

  it("fuses corroborated documents above single-system hits", async () => {
    const engine = build();
    await engine.ingestBatch(DOCS);
    const hits = await engine.search({
      query: "concurrency control snapshots",
      limit: 3,
    });
    const bothSystemHits = hits.filter((h) => h.sources.length === 2);
    // Whatever the ranking, any doc found by both systems must outrank
    // docs found by only one (RRF property).
    if (bothSystemHits.length > 0 && hits.length > bothSystemHits.length) {
      const lastBoth = hits.indexOf(bothSystemHits.at(-1)!);
      const firstSingle = hits.findIndex((h) => h.sources.length === 1);
      expect(lastBoth).toBeLessThan(firstSingle);
    }
  });

  it("filters by collection", async () => {
    const engine = build();
    await engine.ingestBatch(DOCS);
    const hits = await engine.search({
      query: "proxy upstream configuration",
      collection: "servers",
      limit: 5,
    });
    expect(hits.every((h) => h.document.collection === "servers")).toBe(true);
    expect(hits[0]!.document.url).toContain("nginx.example");
  });

  it("supports pure semantic search", async () => {
    const engine = build();
    await engine.ingestBatch(DOCS);
    const hits = await engine.semanticSearch(
      "in-memory cache eviction policies",
      2,
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.document.url).toContain("redis.example");
  });

  it("removes documents from all systems", async () => {
    const engine = build();
    const stored = await engine.ingestBatch(DOCS);
    expect(engine.remove(stored[0]!.id)).toBe(true);
    const hits = await engine.search({ query: "mvcc vacuum", limit: 5 });
    expect(hits.find((h) => h.document.id === stored[0]!.id)).toBeUndefined();
    expect(engine.stats().documents).toBe(2);
    expect(engine.stats().vectors).toBe(2);
  });

  it("upserts by url without duplicating", async () => {
    const engine = build();
    await engine.ingest(DOCS[0]!);
    await engine.ingest({
      ...DOCS[0]!,
      content: "updated content about WAL archiving",
    });
    expect(engine.stats().documents).toBe(1);
    const hits = await engine.search({ query: "WAL archiving", limit: 5 });
    expect(hits.length).toBe(1);
  });
});
