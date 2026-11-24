import { describe, expect, it } from "vitest";
import { SearchService } from "../src/index.js";
import { SearchOrchestrator } from "@querynx/providers";
import type { SearchProvider, SearchQuery, SearchResult } from "@querynx/types";

/**
 * Scripted provider: returns results tagged with the query it received
 * so tests can assert decomposition and routing behavior.
 */
class ScriptedProvider implements SearchProvider {
  readonly name = "scripted";
  received: string[] = [];

  constructor(private readonly results: (query: string) => SearchResult[]) {}

  isConfigured(): boolean {
    return true;
  }

  async search(query: SearchQuery): Promise<SearchResult[]> {
    this.received.push(query.query);
    return this.results(query.query);
  }
}

const result = (
  title: string,
  url: string,
  snippet = "snippet",
  publishedAt?: string,
): SearchResult => ({
  title,
  url,
  snippet,
  score: 0.5,
  provider: "scripted",
  publishedAt,
});

describe("SearchService", () => {
  it("runs the full pipeline: parse, retrieve, rank, cache", async () => {
    const provider = new ScriptedProvider((q) => [
      result(`About ${q}`, `https://fastify.dev/docs/${encodeURIComponent(q)}`),
    ]);
    const service = new SearchService({
      orchestrator: new SearchOrchestrator([provider]),
    });

    const out = await service.search({
      query: "site:fastify.dev plugin hooks",
    });
    expect(out.parsed.cleaned).toBe("plugin hooks");
    expect(out.parsed.includeDomains).toEqual(["fastify.dev"]);
    // site: filtering passed through to the orchestrator and matched.
    expect(out.results.length).toBe(1);
    expect(out.results[0]!.url).toContain("fastify.dev");
    // Operators were extracted, not passed to the provider raw.
    expect(provider.received[0]).not.toContain("site:");
  });

  it("serves identical queries from cache and reports the hit", async () => {
    let searches = 0;
    const provider = new ScriptedProvider(() => {
      searches++;
      return [result("R", "https://x.example/r")];
    });
    const service = new SearchService({
      orchestrator: new SearchOrchestrator([provider]),
    });

    const first = await service.search({ query: "cached query" });
    expect(first.diagnostics.cacheHit).toBe(false);
    const second = await service.search({ query: "cached query" });
    expect(second.diagnostics.cacheHit).toBe(true);
    expect(searches).toBe(1);
    expect(second.results[0]!.url).toBe(first.results[0]!.url);
  });

  it("honors noCache for freshness-critical queries", async () => {
    let searches = 0;
    const provider = new ScriptedProvider(() => {
      searches++;
      return [result("R", "https://x.example/r")];
    });
    const service = new SearchService({
      orchestrator: new SearchOrchestrator([provider]),
    });
    await service.search({ query: "fresh", noCache: true });
    await service.search({ query: "fresh", noCache: true });
    expect(searches).toBe(2);
  });

  it("decomposes compound queries into multiple retrievals", async () => {
    const provider = new ScriptedProvider(() => [
      result("R", "https://x.example/r"),
    ]);
    const service = new SearchService({
      orchestrator: new SearchOrchestrator([provider]),
    });
    const out = await service.search({
      query: "postgres performance and redis caching",
    });
    expect(out.decomposed).toBe(true);
    // Primary + 2 decomposed sub-queries hit the provider.
    expect(provider.received.length).toBe(3);
  });

  it("routes academic intent to the academic category", async () => {
    let seenCategory: string | undefined;
    const provider: SearchProvider = {
      name: "cat",
      isConfigured: () => true,
      search: async (q: SearchQuery) => {
        seenCategory = q.category;
        return [result("R", "https://x.example/r")];
      },
    };
    const service = new SearchService({
      orchestrator: new SearchOrchestrator([provider]),
    });
    await service.search({ query: "transformer attention arxiv paper" });
    expect(seenCategory).toBe("academic");
  });

  it("applies operator domain preferences in ranking", async () => {
    const provider = new ScriptedProvider(() => [
      result("Other site", "https://other.example/mvcc"),
      result("Trusted docs", "https://docs.trusted.example/mvcc"),
    ]);
    const service = new SearchService({
      orchestrator: new SearchOrchestrator([provider]),
      domainPreferences: { "trusted.example": 1, "other.example": -1 },
    });
    const out = await service.search({ query: "mvcc internals" });
    expect(out.results[0]!.url).toContain("trusted.example");
  });

  it("deduplicates across decomposed sub-queries", async () => {
    // Both the primary and sub-queries return the same URL.
    const provider = new ScriptedProvider(() => [
      result("Same", "https://same.example/doc"),
    ]);
    const service = new SearchService({
      orchestrator: new SearchOrchestrator([provider]),
    });
    const out = await service.search({ query: "alpha beta and gamma delta" });
    expect(out.results.length).toBe(1);
    expect(out.diagnostics.duplicateCount).toBeGreaterThan(0);
  });

  it("enforces the global search budget", async () => {
    const provider = new ScriptedProvider(() => [
      result("R", "https://x.example/r"),
    ]);
    const service = new SearchService({
      orchestrator: new SearchOrchestrator([provider]),
      searchPerMinuteBudget: 2,
    });
    await service.search({ query: "one" });
    await service.search({ query: "two" });
    await expect(service.search({ query: "three" })).rejects.toThrow(/budget/);
  });

  it("applies recency freshness to ranking", async () => {
    const provider = new ScriptedProvider(() => [
      result(
        "Old",
        "https://old.example/x",
        "query content",
        "2020-01-01T00:00:00Z",
      ),
      result(
        "New",
        "https://new.example/y",
        "query content",
        "2026-11-01T00:00:00Z",
      ),
    ]);
    const service = new SearchService({
      orchestrator: new SearchOrchestrator([provider]),
    });
    const out = await service.search({ query: "query content latest" });
    expect(out.results[0]!.title).toBe("New");
  });

  it("degrades to empty results on total provider failure", async () => {
    const failing: SearchProvider = {
      name: "fail",
      isConfigured: () => true,
      search: async () => {
        throw new Error("upstream down");
      },
    };
    const service = new SearchService({
      orchestrator: new SearchOrchestrator([failing]),
    });
    const out = await service.search({ query: "anything at all" });
    expect(out.results).toEqual([]);
    expect(out.diagnostics.providersSucceeded).toBe(0);
  });

  it("exposes cache stats and provider health", async () => {
    const provider = new ScriptedProvider(() => [
      result("R", "https://x.example/r"),
    ]);
    const service = new SearchService({
      orchestrator: new SearchOrchestrator([provider]),
    });
    await service.search({ query: "stats query" });
    expect(service.cacheStats().hits).toBe(0);
    await service.search({ query: "stats query" });
    expect(service.cacheStats().hits).toBe(1);
    expect(service.providerHealth()[0]!.name).toBe("scripted");
  });
});
