import { describe, expect, it } from "vitest";
import {
  evaluate,
  mrr,
  ndcgAtK,
  precisionAtK,
  recallAtK,
  reciprocalRank,
} from "../src/metrics.js";

describe("reciprocalRank", () => {
  it("returns 1 when the first result is relevant", () => {
    expect(reciprocalRank(["a", "b", "c"], new Set(["a"]))).toBe(1);
  });

  it("returns 1/3 when the third result is relevant", () => {
    expect(reciprocalRank(["x", "y", "a"], new Set(["a"]))).toBeCloseTo(1 / 3);
  });

  it("returns 0 when nothing is relevant", () => {
    expect(reciprocalRank(["x", "y"], new Set(["z"]))).toBe(0);
  });
});

describe("mrr", () => {
  it("averages across queries", () => {
    const value = mrr([
      { ranked: ["a", "b"], relevant: new Set(["a"]) }, // 1
      { ranked: ["x", "b"], relevant: new Set(["b"]) }, // 1/2
    ]);
    expect(value).toBeCloseTo(0.75);
  });

  it("handles empty input", () => {
    expect(mrr([])).toBe(0);
  });
});

describe("recallAtK / precisionAtK", () => {
  const ranked = ["a", "b", "c", "d", "e", "f"];
  const relevant = new Set(["b", "f", "z"]);

  it("recall@k counts found relevant docs", () => {
    expect(recallAtK(ranked, relevant, 2)).toBeCloseTo(1 / 3); // b found
    expect(recallAtK(ranked, relevant, 6)).toBeCloseTo(2 / 3); // b, f found
    expect(recallAtK(ranked, relevant, 10)).toBeCloseTo(2 / 3);
  });

  it("precision@k counts relevant fraction", () => {
    expect(precisionAtK(ranked, relevant, 2)).toBeCloseTo(1 / 2);
    expect(precisionAtK(ranked, relevant, 6)).toBeCloseTo(2 / 6);
  });

  it("returns 0 for empty rankings", () => {
    expect(precisionAtK([], relevant, 5)).toBe(0);
    expect(recallAtK([], new Set(), 5)).toBe(0);
  });
});

describe("ndcgAtK", () => {
  it("is 1 for a perfect ranking", () => {
    expect(ndcgAtK(["a", "b", "x"], new Set(["a", "b"]), 3)).toBeCloseTo(1);
  });

  it("penalizes late relevant results", () => {
    const perfect = ndcgAtK(["a", "x", "x"], new Set(["a"]), 3);
    const late = ndcgAtK(["x", "x", "a"], new Set(["a"]), 3);
    expect(perfect).toBe(1);
    expect(late).toBeLessThan(perfect);
    expect(late).toBeGreaterThan(0);
  });

  it("is 0 when nothing is relevant", () => {
    expect(ndcgAtK(["x", "y"], new Set(["z"]), 2)).toBe(0);
  });
});

describe("evaluate", () => {
  it("produces a full report", () => {
    const report = evaluate([
      {
        query: "q1",
        ranked: ["a", "b", "c"],
        relevant: new Set(["a", "c"]),
      },
      {
        query: "q2",
        ranked: ["d", "e"],
        relevant: new Set(["e"]),
      },
    ]);
    expect(report.queryCount).toBe(2);
    expect(report.mrr).toBeCloseTo((1 + 0.5) / 2);
    expect(report.recallAt5).toBeGreaterThan(0);
    expect(report.ndcgAt10).toBeGreaterThan(0);
  });

  it("handles empty query sets", () => {
    const report = evaluate([]);
    expect(report.queryCount).toBe(0);
    expect(report.mrr).toBe(0);
  });
});
