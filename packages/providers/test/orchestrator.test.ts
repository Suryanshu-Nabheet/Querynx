import { describe, expect, it } from "vitest";
import type { SearchProvider, SearchQuery, SearchResult } from "@querynx/types";
import { SearchOrchestrator } from "../src/orchestrator.js";

/** Deterministic in-memory provider for orchestration tests. */
class FakeProvider implements SearchProvider {
  constructor(
    readonly name: string,
    private readonly results: SearchResult[],
    private readonly behavior: {
      fail?: boolean;
      delayMs?: number;
      configured?: boolean;
    } = {},
  ) {}

  isConfigured(): boolean {
    return this.behavior.configured ?? true;
  }

  async search(query: SearchQuery): Promise<SearchResult[]> {
    if (this.behavior.delayMs) {
      await new Promise((r) => setTimeout(r, this.behavior.delayMs));
    }
    if (this.behavior.fail) throw new Error(`${this.name} exploded`);
    return this.results.map((r) => ({ ...r }));
  }
}

const mk = (
  provider: string,
  title: string,
  url: string,
  snippet = "snippet text",
): SearchResult => ({
  title,
  url,
  snippet,
  score: 0.5,
  provider,
});

describe("SearchOrchestrator", () => {
  it("merges results from multiple providers with dedupe", async () => {
    const a = new FakeProvider("alpha", [
      mk("alpha", "PostgreSQL docs", "https://www.postgresql.org/docs/"),
      mk("alpha", "PgBouncer", "https://www.pgbouncer.org/"),
    ]);
    const b = new FakeProvider("beta", [
      mk(
        "beta",
        "PostgreSQL Documentation",
        "https://www.postgresql.org/docs/",
      ), // same doc, different title
      mk("beta", "Redis", "https://redis.io/"),
    ]);

    const orchestrator = new SearchOrchestrator([a, b]);
    const response = await orchestrator.search({
      query: "postgres connection pooling",
      maxResults: 10,
    });

    expect(response.results.length).toBe(3); // postgresql.org deduped, pgbouncer, redis
    expect(response.diagnostics.providersSucceeded).toBe(2);
    expect(response.diagnostics.rawResultCount).toBe(4);
    expect(response.diagnostics.duplicateCount).toBe(1);

    // The deduped result should carry both providers in metadata.
    const merged = response.results.find((r) =>
      r.url.includes("postgresql.org"),
    );
    expect(merged?.metadata?.providers).toContain("alpha");
    expect(merged?.metadata?.providers).toContain("beta");
  });

  it("ranks corroborated results higher in ties", async () => {
    const common = mk("alpha", "Same result", "https://example.com/shared");
    const a = new FakeProvider("alpha", [common]);
    const b = new FakeProvider("beta", [
      mk("beta", "Same result", "https://example.com/shared"),
      mk("beta", "Solo result", "https://example.com/solo"),
    ]);
    const orchestrator = new SearchOrchestrator([a, b]);
    const response = await orchestrator.search({ query: "q", maxResults: 10 });
    expect(response.results[0]?.url).toBe("https://example.com/shared");
  });

  it("degrades gracefully when one provider fails", async () => {
    const ok = new FakeProvider("ok", [
      mk("ok", "Good", "https://example.com/good"),
    ]);
    const bad = new FakeProvider("bad", [], { fail: true });
    const orchestrator = new SearchOrchestrator([ok, bad]);

    const response = await orchestrator.search({ query: "q", maxResults: 10 });
    expect(response.results.length).toBe(1);
    expect(response.diagnostics.providersSucceeded).toBe(1);
    const badAttempt = response.diagnostics.attempts.find(
      (a) => a.provider === "bad",
    );
    expect(badAttempt?.status).toBe("error");
    expect(badAttempt?.error).toContain("exploded");
  });

  it("opens the circuit after repeated failures and skips the provider", async () => {
    const bad = new FakeProvider("bad", [], { fail: true });
    const ok = new FakeProvider("ok", [
      mk("ok", "Fine", "https://example.com/fine"),
    ]);
    const orchestrator = new SearchOrchestrator([ok, bad], {
      breakerThreshold: 2,
      breakerResetMs: 60_000,
    });

    await orchestrator.search({ query: "q1", maxResults: 5 });
    await orchestrator.search({ query: "q2", maxResults: 5 });
    await orchestrator.search({ query: "q3", maxResults: 5 });

    const third = await orchestrator.search({ query: "q4", maxResults: 5 });
    const skipped = third.diagnostics.attempts.find(
      (a) => a.provider === "bad",
    );
    expect(skipped?.status).toBe("skipped");
    expect(skipped?.error).toBe("circuit open");
    expect(third.results.length).toBe(1);
  });

  it("returns empty response with diagnostics when no providers are configured", async () => {
    const unconfigured = new FakeProvider("ghost", [], { configured: false });
    const orchestrator = new SearchOrchestrator([unconfigured]);
    const response = await orchestrator.search({ query: "q", maxResults: 5 });
    expect(response.results).toEqual([]);
    expect(response.diagnostics.attempts[0]?.error).toContain(
      "no configured providers",
    );
  });

  it("applies include domain filters during merge", async () => {
    const a = new FakeProvider("alpha", [
      mk("alpha", "Python", "https://docs.python.org/3/"),
      mk("alpha", "Ruby", "https://www.ruby-lang.org/"),
    ]);
    const orchestrator = new SearchOrchestrator([a]);
    const response = await orchestrator.search({
      query: "python docs",
      maxResults: 10,
      includeDomains: ["python.org"],
    });
    expect(response.results.length).toBe(1);
    expect(response.results[0]?.url).toContain("python.org");
  });

  it("applies exclude domain filters during merge", async () => {
    const a = new FakeProvider("alpha", [
      mk("alpha", "Wikipedia", "https://en.wikipedia.org/wiki/X"),
      mk("alpha", "Docs", "https://example.com/docs"),
    ]);
    const orchestrator = new SearchOrchestrator([a]);
    const response = await orchestrator.search({
      query: "q",
      maxResults: 10,
      excludeDomains: ["wikipedia.org"],
    });
    expect(response.results.length).toBe(1);
    expect(response.results[0]?.url).toContain("example.com");
  });

  it("respects maxResults", async () => {
    const results = Array.from({ length: 30 }, (_, i) =>
      mk("alpha", `Result ${i}`, `https://example.com/r${i}`),
    );
    const orchestrator = new SearchOrchestrator([
      new FakeProvider("alpha", results),
    ]);
    const response = await orchestrator.search({ query: "q", maxResults: 5 });
    expect(response.results.length).toBe(5);
  });

  it("reports provider health snapshot", async () => {
    const ok = new FakeProvider("ok", [mk("ok", "x", "https://example.com/x")]);
    const bad = new FakeProvider("bad", [], { fail: true });
    const orchestrator = new SearchOrchestrator([ok, bad], {
      breakerThreshold: 1,
    });
    await orchestrator.search({ query: "q", maxResults: 5 });
    const health = orchestrator.getProviderHealth();
    const badHealth = health.find((h) => h.name === "bad");
    expect(badHealth?.state).toBe("open");
    expect(badHealth?.successRate).toBeLessThan(1);
    const okHealth = health.find((h) => h.name === "ok");
    expect(okHealth?.successRate).toBe(1);
  });

  it("supports cancellation", async () => {
    const slow = new FakeProvider(
      "slow",
      [mk("slow", "x", "https://example.com/x")],
      { delayMs: 500 },
    );
    const orchestrator = new SearchOrchestrator([slow]);
    const controller = new AbortController();
    const promise = orchestrator.search(
      { query: "q", maxResults: 5 },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 30);
    await expect(promise).rejects.toThrow();
  });

  it("rejects construction with zero providers", () => {
    expect(() => new SearchOrchestrator([])).toThrow(/at least one provider/);
  });

  it("deduplicates near-identical snippets across different URLs", async () => {
    const a = new FakeProvider("alpha", [
      mk(
        "alpha",
        "Postgres guide",
        "https://site-one.com/pg",
        "PostgreSQL is a relational database management system with MVCC",
      ),
      mk(
        "alpha",
        "Postgres tutorial",
        "https://site-two.com/pg",
        "PostgreSQL is a relational database management system with MVCC",
      ),
    ]);
    const orchestrator = new SearchOrchestrator([a], {
      duplicateSimilarityThreshold: 0.7,
    });
    const response = await orchestrator.search({
      query: "postgres",
      maxResults: 10,
    });
    expect(response.results.length).toBe(1);
  });
});
