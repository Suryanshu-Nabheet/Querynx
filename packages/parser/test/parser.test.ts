import { describe, expect, it } from "vitest";
import {
  classifyQuery,
  decomposeQuery,
  expandQuery,
  extractOperators,
  normalizeQuery,
  parseQuery,
} from "../src/index.js";

describe("normalizeQuery", () => {
  it("collapses whitespace and strips control characters", () => {
    expect(normalizeQuery("  hello \t world \n ")).toBe("hello world");
    // eslint-disable-next-line no-control-regex
    expect(normalizeQuery("bad\u0007chars")).toBe("bad chars");
  });

  it("caps length at 500", () => {
    expect(normalormalizeGuard("x".repeat(600))).toHaveLength(500);
  });

  function normalormalizeGuard(s: string): string {
    return normalizeQuery(s);
  }
});

describe("classifyQuery", () => {
  it("classifies academic intent", () => {
    const c = classifyQuery("transformer attention arxiv paper");
    expect(c.category).toBe("academic");
    expect(c.signals).toContain("academic-terms");
  });

  it("classifies code intent", () => {
    expect(classifyQuery("useeffect react hooks code").category).toBe("code");
  });

  it("classifies documentation intent", () => {
    expect(classifyQuery("fastify plugin documentation").category).toBe("docs");
  });

  it("detects questions", () => {
    expect(classifyQuery("how does mvcc work").isQuestion).toBe(true);
    expect(classifyQuery("postgres performance tuning").isQuestion).toBe(false);
  });

  it("detects freshness intent", () => {
    const c = classifyQuery("latest ai news");
    expect(c.wantsFresh).toBe(true);
    expect(c.signals).toContain("freshness-term");
  });

  it("extracts site hints", () => {
    expect(classifyQuery("site:docs.python.org asyncio").siteHint).toBe(
      "docs.python.org",
    );
  });
});

describe("extractOperators", () => {
  it("pulls site: filters out of the query", () => {
    const { cleaned, includeDomains } = extractOperators(
      "error handling site:fastify.dev",
    );
    expect(cleaned).toBe("error handling");
    expect(includeDomains).toEqual(["fastify.dev"]);
  });

  it("maps recency phrases to freshness", () => {
    expect(extractOperators("postgres releases this week").freshness).toBe(
      "week",
    );
    expect(extractOperators("ai announcements today").freshness).toBe("day");
    expect(extractOperators("history of databases").freshness).toBeUndefined();
  });
});

describe("decomposeQuery", () => {
  it("splits compound queries at connectors", () => {
    expect(decomposeQuery("postgres performance and redis caching")).toEqual([
      "postgres performance",
      "redis caching",
    ]);
  });

  it("keeps atomic queries whole", () => {
    expect(decomposeQuery("postgresql mvcc")).toEqual(["postgresql mvcc"]);
  });
});

describe("expandQuery", () => {
  it("adds category-specific variants", () => {
    expect(expandQuery("attention mechanisms", "academic")).toContain(
      "attention mechanisms paper",
    );
    expect(expandQuery("fastify hooks", "docs")).toContain(
      "fastify hooks documentation",
    );
  });

  it("never exceeds three variants", () => {
    expect(expandQuery("anything at all", "web").length).toBeLessThanOrEqual(3);
  });
});

describe("parseQuery", () => {
  it("runs the full pipeline", () => {
    const parsed = parseQuery(
      "how to tune postgres site:postgresql.org latest",
    );
    expect(parsed.cleaned).toBe("how to tune postgres latest");
    expect(parsed.includeDomains).toEqual(["postgresql.org"]);
    expect(parsed.classification.isQuestion).toBe(true);
    expect(parsed.freshness ?? parsed.classification.wantsFresh).toBeTruthy();
  });
});
