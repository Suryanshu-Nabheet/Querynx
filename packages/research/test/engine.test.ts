import { describe, expect, it } from "vitest";
import type { SearchResult } from "@querynx/types";
import { ResearchEngine } from "../src/engine.js";
import type { ResearchEvent, ResearchReport, SearchFn } from "../src/index.js";

/** Scripted search: returns canned results per query keyword. */
function makeSearch(
  cases: Record<string, SearchResult[]>,
): SearchFn & { calls: string[] } {
  const calls: string[] = [];
  const fn = async (query: string): Promise<SearchResult[]> => {
    calls.push(query);
    for (const [keyword, results] of Object.entries(cases)) {
      if (query.toLowerCase().includes(keyword.toLowerCase())) return results;
    }
    return [];
  };
  return Object.assign(fn, { calls });
}

const RESULT = (title: string, url: string, snippet: string): SearchResult => ({
  title,
  url,
  snippet,
  score: 0.8,
  provider: "test",
});

describe("ResearchEngine", () => {
  const extractContent = async (url: string) => ({
    title: `Content of ${url}`,
    content:
      `Detailed explanation about quantum computing and qubits for ${url}. ` +
      "Quantum computers use superposition and entanglement to perform certain computations faster than classical machines. " +
      "Error correction remains the primary engineering challenge for scaling quantum systems to practical utility.",
    publishedAt: "2025-06-01T00:00:00Z",
  });

  it("runs a bounded research loop and returns an evidence-backed report", async () => {
    const search = makeSearch({
      quantum: [
        RESULT(
          "Quantum Computing Intro",
          "https://quantum.example/intro",
          "Intro to quantum",
        ),
        RESULT(
          "Qubits Explained",
          "https://quantum.example/qubits",
          "What are qubits",
        ),
      ],
    });
    const events: ResearchEvent[] = [];
    const engine = new ResearchEngine();
    const report = await engine.research("quantum computing overview", {
      mode: "fast",
      search,
      extractContent,
      onEvent: (e) => events.push(e),
    });

    expect(report.objective).toBe("quantum computing overview");
    expect(report.evidence.length).toBeGreaterThan(0);
    expect(report.evidence[0]!.url).toContain("quantum.example");
    expect(report.evidence[0]!.passage).toContain("quantum");
    expect(report.usage.queries).toBeLessThanOrEqual(2);
    expect(report.termination).toBeOneOf([
      "coverage-reached",
      "budget-exhausted",
    ]);
    expect(report.findings).toContain("quantum.example");

    // Event stream must include query lifecycle events.
    const types = events.map((e) => e.type);
    expect(types).toContain("query-started");
    expect(types).toContain("query-completed");
  });

  it("respects the query budget", async () => {
    let searchCalls = 0;
    const search: SearchFn = async () => {
      searchCalls++;
      return [RESULT("r", "https://x.example/a", "s")];
    };
    const engine = new ResearchEngine();
    const report = await engine.research("objective", {
      mode: "fast",
      budgetOverrides: { maxQueries: 1, maxPages: 1 },
      search,
      extractContent,
    });
    expect(searchCalls).toBeLessThanOrEqual(2); // initial + possible follow-up guard
    expect(report.usage.queries).toBeLessThanOrEqual(2);
  });

  it("deduplicates identical content across sources", async () => {
    const search = makeSearch({
      dup: [
        RESULT("Copy A", "https://a.example/x", "same"),
        RESULT("Copy B", "https://b.example/x", "same"),
      ],
    });
    const engine = new ResearchEngine();
    const report = await engine.research("dup test", {
      mode: "fast",
      search,
      extractContent: async () => ({
        title: "Identical content",
        content:
          "Exactly the same article text published on two different sites verbatim without any changes.",
      }),
    });
    // Both URLs searched, but near-identical content only counted once.
    expect(report.evidence.length).toBe(1);
  });

  it("handles total search failure gracefully", async () => {
    const search: SearchFn = async () => {
      throw new Error("search unavailable");
    };
    const engine = new ResearchEngine();
    const report = await engine.research("anything", {
      mode: "fast",
      search,
      extractContent,
    });
    expect(report.termination).toBe("no-results");
    expect(report.evidence).toEqual([]);
    expect(report.findings).toContain("No evidence");
  });

  it("supports cancellation mid-run", async () => {
    const controller = new AbortController();
    const search: SearchFn = async () => {
      controller.abort();
      return [RESULT("r", "https://x.example/a", "s")];
    };
    const engine = new ResearchEngine();
    const report = await engine.research("cancel me", {
      mode: "deep",
      search,
      extractContent,
      signal: controller.signal,
    });
    expect(report.termination).toBe("cancelled");
  });

  it("uses the model synthesis hook when provided", async () => {
    const search = makeSearch({
      topic: [RESULT("Source", "https://s.example/1", "about the topic")],
    });
    const engine = new ResearchEngine();
    const report = await engine.research("topic research", {
      mode: "fast",
      search,
      extractContent,
      synthesis: async (objective, evidence) =>
        `Model summary of "${objective}" using ${evidence.length} sources.`,
    });
    expect(report.findings).toBe(
      'Model summary of "topic research" using 1 sources.',
    );
  });

  it("falls back to deterministic summary when synthesis throws", async () => {
    const search = makeSearch({
      topic: [RESULT("Source", "https://s.example/1", "about the topic")],
    });
    const engine = new ResearchEngine();
    const report = await engine.research("topic research", {
      mode: "fast",
      search,
      extractContent,
      synthesis: async () => {
        throw new Error("model down");
      },
    });
    expect(report.findings).toContain("s.example");
  });

  it("keeps evidence snippets when extraction fails", async () => {
    const search = makeSearch({
      fail: [
        RESULT(
          "Unreachable",
          "https://dead.example/x",
          "The snippet describes the finding.",
        ),
      ],
    });
    const engine = new ResearchEngine();
    const report = await engine.research("fail test", {
      mode: "fast",
      search,
      extractContent: async () => {
        throw new Error("connection refused");
      },
    });
    expect(report.evidence.length).toBe(1);
    expect(report.evidence[0]!.passage).toContain("snippet describes");
  });

  it("records gap-driven follow-up queries", async () => {
    const search = makeSearch({
      // Only returns results for one sub-topic, leaving a gap.
      postgres: [
        RESULT("Postgres Guide", "https://db.example/pg", "postgres content"),
      ],
    });
    const engine = new ResearchEngine();
    const report = await engine.research("postgres and redis comparison", {
      mode: "standard",
      search,
      extractContent,
      budgetOverrides: { maxPages: 3 },
    });
    // The objective mentions redis; nothing covers it; a gap is recorded.
    expect(
      report.gaps.length +
        report.steps.filter((s) => s.reason === "gap-followup").length,
    ).toBeGreaterThan(0);
  });
});

describe("planner", () => {
  it("decomposes multi-clause objectives", async () => {
    const { planInitialQueries } = await import("../src/planner.js");
    const queries = planInitialQueries(
      "postgres performance and redis caching",
      "standard",
    );
    expect(queries.length).toBeGreaterThan(1);
    expect(queries.some((q) => q.includes("redis"))).toBe(true);
  });

  it("detects gaps for uncovered objective terms", async () => {
    const { detectGaps } = await import("../src/planner.js");
    const gaps = detectGaps(
      "vector databases and postgres extensions",
      [
        {
          title: "Vector databases",
          passage: "Vector databases store embeddings.",
        },
      ],
      3,
    );
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps[0]).toContain("postgres");
  });

  it("reports no gaps when everything is covered", async () => {
    const { detectGaps } = await import("../src/planner.js");
    const gaps = detectGaps(
      "quantum computing",
      [{ title: "Quantum", passage: "Quantum computing explained fully." }],
      3,
    );
    expect(gaps).toEqual([]);
  });
});

describe("contradiction detection", () => {
  it("surfaces conflicting dates from independent sources and probes them", async () => {
    const search = makeSearch({
      conflict: [
        RESULT("Source A", "https://a.example/report", "The release happened in 2019"),
        RESULT("Source B", "https://b.example/history", "The release happened in 2021"),
      ],
      probe: [RESULT("Clarification", "https://c.example/timeline", "the official release was in 2021")],
    });
    const engine = new ResearchEngine();
    const report = await engine.research("when did the conflict release happen", {
      mode: "standard",
      search,
      extractContent: async (url) => ({
        title: `Content of ${url}`,
        content:
          url.includes("a.example")
            ? "The release happened in 2019 according to records."
            : url.includes("b.example")
              ? "The release happened in 2021 per the announcement."
              : "The official release was in 2021.",
      }),
      budgetOverrides: { maxPages: 5, maxQueries: 6 },
    });
    expect(report.contradictions.length).toBeGreaterThan(0);
    expect(report.contradictions[0]!.sources).toHaveLength(2);
    expect(report.contradictions[0]!.question).toContain("disagree");
    // A contradiction-probe step was issued.
    expect(
      report.steps.some((s) => s.reason === "contradiction-probe"),
    ).toBe(true);
  });

  it("reports no contradictions when sources agree", async () => {
    const search = makeSearch({
      agree: [
        RESULT("A", "https://a.example/x", "Established in 2020"),
        RESULT("B", "https://b.example/y", "Founded in 2020"),
      ],
    });
    const engine = new ResearchEngine();
    const report = await engine.research("when was it established", {
      mode: "fast",
      search,
      extractContent: async () => ({
        title: "T",
        content: "It was established in 2020 by the founders.",
      }),
    });
    expect(report.contradictions).toEqual([]);
  });
});
