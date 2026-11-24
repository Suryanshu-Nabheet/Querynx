import { describe, expect, it } from "vitest";
import { MetricsRegistry } from "../src/index.js";

describe("MetricsRegistry", () => {
  it("counts increments", () => {
    const r = new MetricsRegistry();
    r.inc("search_total");
    r.inc("search_total", 4);
    expect(r.counter("search_total")).toBe(5);
  });

  it("tracks gauges", () => {
    const r = new MetricsRegistry();
    r.setGauge("cache_entries", 42);
    expect(r.gauge("cache_entries")).toBe(42);
    r.setGauge("cache_entries", 10);
    expect(r.gauge("cache_entries")).toBe(10);
  });

  it("computes percentiles with interpolation", () => {
    const r = new MetricsRegistry();
    for (let i = 1; i <= 100; i++) r.observe("lat", i);
    expect(r.percentile("lat", 50)).toBeCloseTo(50.5, 0);
    expect(r.percentile("lat", 95)).toBeCloseTo(95.05, 0);
    expect(r.percentile("lat", 99)).toBeCloseTo(99, 0);
    expect(r.percentile("lat", 100)).toBe(100);
  });

  it("returns 0 for unknown or empty histograms", () => {
    const r = new MetricsRegistry();
    expect(r.percentile("nope", 50)).toBe(0);
  });

  it("times async functions and records the observation", async () => {
    const r = new MetricsRegistry();
    await r.timed("op", async () => new Promise((res) => setTimeout(res, 20)));
    expect(r.percentile("op", 50)).toBeGreaterThanOrEqual(15);
  });

  it("times even when the function throws", async () => {
    const r = new MetricsRegistry();
    await expect(
      r.timed("fail", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(r.percentile("fail", 50)).toBeGreaterThan(0);
  });

  it("bounds histogram memory", () => {
    const r = new MetricsRegistry();
    for (let i = 0; i < 15_000; i++) r.observe("big", i);
    // The registry keeps at most 10k samples.
    const p50 = r.percentile("big", 50);
    expect(p50).toBeGreaterThan(5000); // recent half retained
  });

  it("renders prometheus text format", () => {
    const r = new MetricsRegistry();
    r.inc("search_total", 3);
    r.setGauge("cache_entries", 7);
    r.observe("latency_ms", 12);
    const text = r.prometheus();
    expect(text).toContain("# TYPE search_total counter");
    expect(text).toContain("search_total 3");
    expect(text).toContain("cache_entries 7");
    expect(text).toContain("latency_ms_count 1");
    expect(text).toContain("latency_ms_p95");
  });

  it("clears all state", () => {
    const r = new MetricsRegistry();
    r.inc("a");
    r.setGauge("b", 1);
    r.observe("c", 1);
    r.clear();
    expect(r.names()).toEqual([]);
  });
});
