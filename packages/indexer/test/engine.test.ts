import { describe, expect, it } from "vitest";
import { MemorySearchEngine } from "../src/engine.js";
import { tokenize } from "../src/tokenize.js";

const DOCS = [
  {
    url: "https://postgresql.org/docs/mvcc",
    title: "PostgreSQL MVCC Documentation",
    content:
      "Multiversion concurrency control keeps old row versions visible. Each transaction sees a consistent snapshot. VACUUM reclaims dead tuples.",
    fingerprint: "fp-pg",
  },
  {
    url: "https://redis.io/docs",
    title: "Redis In-Memory Data Store",
    content:
      "Redis is an in-memory data structure store used as cache and message broker. Supports strings hashes lists sets.",
    fingerprint: "fp-redis",
  },
  {
    url: "https://nginx.com/library",
    title: "Nginx Reverse Proxy Guide",
    content:
      "Nginx is a web server and reverse proxy. Configuration uses directives in nginx.conf.",
    fingerprint: "fp-nginx",
  },
  {
    url: "https://sqlite.org/whentouse",
    title: "SQLite Appropriate Uses",
    content:
      "SQLite is an embedded relational database. Great for local storage and testing, not for high-concurrency writes.",
    fingerprint: "fp-sqlite",
  },
] as const;

describe("tokenize", () => {
  it("lowercases and splits on punctuation, keeps underscores", () => {
    // Underscore is preserved as an identifier character.
    expect(tokenize("Hello, World! Foo_Bar")).toEqual([
      "hello",
      "world",
      "foo_bar",
    ]);
  });

  it("drops stopwords and single characters", () => {
    const tokens = tokenize("the a is of to go c");
    expect(tokens).toEqual(["go"]);
  });

  it("handles empty input", () => {
    expect(tokenize("")).toEqual([]);
  });

  it("keeps numbers and mixed tokens, drops single chars", () => {
    // "2" is a 1-char token post-split of HTTP/2 and is dropped.
    expect(tokenize("HTTP/2 uses k8s in 2024")).toEqual([
      "http",
      "uses",
      "k8s",
      "2024",
    ]);
  });
});

describe("MemorySearchEngine", () => {
  function buildEngine(): MemorySearchEngine {
    const engine = new MemorySearchEngine();
    for (const doc of DOCS) engine.index({ ...doc, collection: "docs" });
    return engine;
  }

  it("indexes and searches by keyword", () => {
    const engine = buildEngine();
    const hits = engine.search({ query: "postgresql concurrency", limit: 10 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.document.url).toContain("postgresql.org");
  });

  it("ranks documents by relevance", () => {
    const engine = buildEngine();
    const hits = engine.search({ query: "in-memory cache", limit: 10 });
    expect(hits[0]!.document.url).toContain("redis.io");
  });

  it("returns empty for stopword-only queries", () => {
    const engine = buildEngine();
    expect(engine.search({ query: "the of is", limit: 10 })).toEqual([]);
  });

  it("filters by collection", () => {
    const engine = new MemorySearchEngine();
    engine.index({ ...DOCS[0]!, collection: "databases" });
    engine.index({ ...DOCS[2]!, collection: "servers" });
    const hits = engine.search({
      query: "concurrency",
      collection: "databases",
      limit: 10,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.document.collection).toBe("databases");
  });

  it("filters by domain", () => {
    const engine = buildEngine();
    const hits = engine.search({
      query: "cache message broker",
      domains: ["redis.io"],
      limit: 10,
    });
    expect(hits.every((h) => h.document.url.includes("redis.io"))).toBe(true);
    expect(hits.length).toBeGreaterThan(0);
  });

  it("remove() deletes the document from postings", () => {
    const engine = buildEngine();
    const hitsBefore = engine.search({
      query: "nginx reverse proxy",
      limit: 10,
    });
    expect(hitsBefore.length).toBe(1);
    engine.remove(hitsBefore[0]!.document.id);
    expect(engine.search({ query: "nginx reverse proxy", limit: 10 })).toEqual(
      [],
    );
  });

  it("index() with same id replaces the old version", () => {
    const engine = new MemorySearchEngine();
    const first = engine.index({ ...DOCS[0]!, collection: "docs" });
    engine.index({
      ...first,
      id: first.id,
      title: "Cooking Recipes",
      content: "totally different text about pasta making",
    });
    // Old body content must be gone from the postings.
    expect(
      engine.search({ query: "multiversion snapshot", limit: 10 }),
    ).toEqual([]);
    // New content is searchable.
    const hits = engine.search({ query: "pasta making", limit: 10 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.document.title).toBe("Cooking Recipes");
    expect(engine.stats().documents).toBe(1);
  });

  it("replaces on url upsert via findByUrl", () => {
    const engine = buildEngine();
    const existing = engine.findByUrl("https://postgresql.org/docs/mvcc")!;
    expect(existing).toBeTruthy();
    engine.index({
      ...existing,
      id: existing.id,
      content: "Updated PostgreSQL content about WAL archiving",
    });
    expect(engine.stats().documents).toBe(DOCS.length);
    const hits = engine.search({ query: "WAL archiving", limit: 10 });
    expect(hits[0]!.document.url).toContain("postgresql.org");
  });

  it("reports corpus statistics", () => {
    const engine = buildEngine();
    const stats = engine.stats();
    expect(stats.documents).toBe(4);
    expect(stats.collections).toBe(1);
    expect(stats.uniqueTerms).toBeGreaterThan(10);
    expect(stats.contentChars).toBeGreaterThan(100);
  });

  it("normalizes scores into [0,1]", () => {
    const engine = buildEngine();
    const hits = engine.search({ query: "database store", limit: 10 });
    for (const hit of hits) {
      expect(hit.score).toBeGreaterThanOrEqual(0);
      expect(hit.score).toBeLessThanOrEqual(1);
    }
    if (hits.length > 0) expect(hits[0]!.score).toBeCloseTo(1);
  });

  it("respects limit", () => {
    const engine = buildEngine();
    expect(engine.search({ query: "database", limit: 1 })).toHaveLength(1);
  });

  it("applies publishedAfter filter", () => {
    const engine = new MemorySearchEngine();
    engine.index({
      ...DOCS[0]!,
      collection: "docs",
      publishedAt: "2020-01-01T00:00:00Z",
    });
    engine.index({
      ...DOCS[1]!,
      collection: "docs",
      publishedAt: "2026-01-01T00:00:00Z",
    });
    const recent = engine.search({
      query: "store database",
      publishedAfter: "2025-01-01T00:00:00Z",
      limit: 10,
    });
    expect(recent.length).toBe(1);
    expect(recent[0]!.document.url).toContain("redis.io");
  });
});

describe("relevance gating (live-eval regressions)", () => {
  it("does not surface single-token coincidences for nonsense queries", () => {
    const engine = new MemorySearchEngine();
    // 'error' is a common token in these docs; a 4-term query matching
    // ONLY 'error' must not surface (the 1/3-coverage gate blocks it).
    engine.index({
      url: "https://docs.example/http-errors",
      title: "HTTP Error Semantics",
      content: "error handling in status codes covers error conditions and retries",
      collection: "g",
      fingerprint: "g1",
    });
    const hits = engine.search({ query: "quantum computing error correction", limit: 5 });
    expect(hits).toHaveLength(0);
  });

  it("keeps genuine single-concept matches", () => {
    const engine = new MemorySearchEngine();
    engine.index({
      url: "https://docs.example/pooling",
      title: "Connection Pooling",
      content: "connection pooling reduces overhead for databases",
      collection: "g",
      fingerprint: "g2",
    });
    const hits = engine.search({ query: "pooling", limit: 5 });
    expect(hits).toHaveLength(1);
  });
});
