import { describe, expect, it } from "vitest";
import type { SearchResult } from "@querynx/types";
import {
  rankResults,
  textRelevance,
  freshness,
  domainBoost,
} from "../src/pipeline.js";

const mk = (
  title: string,
  url: string,
  snippet: string,
  extra: Partial<SearchResult> = {},
): SearchResult => ({
  title,
  url,
  snippet,
  score: 0.5,
  provider: "test",
  ...extra,
});

describe("rankResults", () => {
  it("ranks text-relevant results first", () => {
    const candidates = [
      mk(
        "Unrelated cooking blog",
        "https://food.example/a",
        "pasta recipes and kitchen tips",
      ),
      mk(
        "PostgreSQL MVCC guide",
        "https://db.example/mvcc",
        "multiversion concurrency control in postgres",
      ),
    ];
    const ranked = rankResults(candidates, {
      query: "postgresql mvcc concurrency",
    });
    expect(ranked[0]!.title).toBe("PostgreSQL MVCC guide");
  });

  it("applies freshness decay to dated results", () => {
    const now = new Date("2026-11-24T00:00:00Z");
    const candidates = [
      mk("Old article", "https://a.example/x", "topic content", {
        publishedAt: "2020-01-01T00:00:00Z",
      }),
      mk("New article", "https://b.example/y", "topic content", {
        publishedAt: "2026-11-01T00:00:00Z",
      }),
    ];
    const ranked = rankResults(candidates, { query: "topic", now });
    expect(ranked[0]!.title).toBe("New article");
  });

  it("demotes duplicate domains but keeps them", () => {
    const candidates = [
      mk(
        "First from domain",
        "https://same.example/1",
        "relevant topic content",
      ),
      mk(
        "Second from domain",
        "https://same.example/2",
        "relevant topic content",
      ),
      mk("Other domain", "https://other.example/1", "relevant topic content"),
    ];
    const ranked = rankResults(candidates, { query: "relevant topic" });
    const sameDomainEntries = ranked.filter((r) =>
      r.url.includes("same.example"),
    );
    // Both remain present.
    expect(sameDomainEntries.length).toBe(2);
    // The first occurrence outranks the second.
    expect(ranked.indexOf(sameDomainEntries[0]!)).toBeLessThan(
      ranked.indexOf(sameDomainEntries[1]!),
    );
  });

  it("honors operator domain preferences", () => {
    const candidates = [
      mk(
        "Random site result",
        "https://random.example/a",
        "postgresql mvcc content",
      ),
      mk(
        "Trusted docs",
        "https://docs.trusted.example/mvcc",
        "postgresql mvcc content",
      ),
    ];
    const ranked = rankResults(candidates, {
      query: "postgresql mvcc",
      domainPreferences: { "trusted.example": 1, "random.example": -1 },
    });
    expect(ranked[0]!.url).toContain("trusted.example");
  });

  it("weights provider corroboration", () => {
    const counts = new Map([
      ["alpha", 1],
      ["beta", 1],
    ]);
    const candidates = [
      mk("Single source", "https://a.example/x", "query content", {
        metadata: { providers: ["alpha"] },
      }),
      mk("Corroborated", "https://b.example/y", "query content", {
        metadata: { providers: ["alpha", "beta"] },
      }),
    ];
    const ranked = rankResults(candidates, {
      query: "query",
      providerCounts: counts,
    });
    expect(ranked[0]!.title).toBe("Corroborated");
  });

  it("exposes per-signal diagnostics", () => {
    const ranked = rankResults([mk("T", "https://x.example/t", "content")], {
      query: "content",
    });
    expect(ranked[0]!.signalScores).toHaveProperty("text-relevance");
    expect(ranked[0]!.signalScores).toHaveProperty("freshness");
    expect(ranked[0]!.rankScore).toBeGreaterThan(0);
  });

  it("handles empty candidates", () => {
    expect(rankResults([], { query: "x" })).toEqual([]);
  });
});

describe("individual signals", () => {
  it("textRelevance returns 1 on full term coverage", () => {
    const score = textRelevance.score(
      mk("Alpha Beta", "https://x.example", "alpha beta content"),
      { query: "alpha beta" },
    );
    expect(score).toBe(1);
  });

  it("freshness handles missing dates neutrally", () => {
    const score = freshness.score(mk("t", "https://x.example", "s"), {
      query: "q",
    });
    expect(score).toBe(0.5);
  });

  it("domainBoost clamps out-of-range preferences", () => {
    const score = domainBoost.score(
      mk("t", "https://sub.pref.example/x", "s"),
      { query: "q", domainPreferences: { "pref.example": 5 } },
    );
    expect(score).toBe(1); // clamped to +1 => (1+1)/2
  });
});
