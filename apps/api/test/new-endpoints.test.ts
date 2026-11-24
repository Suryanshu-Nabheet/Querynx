import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { SearchOrchestrator } from "@querynx/providers";
import type { SearchProvider, SearchQuery, SearchResult } from "@querynx/types";

/**
 * Endpoint-contract tests for the §13 surface additions:
 * /v1/answer, /v1/rerank, /v1/extract/batch, /v1/crawl, /v1/map and
 * GET /v1/jobs/:id/stream.
 */

class AnswerProvider implements SearchProvider {
  readonly name = "stub";
  isConfigured() {
    return true;
  }
  async search(query: SearchQuery): Promise<SearchResult[]> {
    return [
      {
        title: "MVCC Overview",
        url: "https://db.example/mvcc",
        snippet: `Multiversion concurrency control keeps row snapshots visible: ${query.query}`,
        score: 0.9,
        provider: "stub",
      },
      {
        title: "Snapshots Guide",
        url: "https://db.example/snapshots",
        snippet:
          "Transactions see consistent snapshots during concurrent writes.",
        score: 0.7,
        provider: "stub",
      },
    ];
  }
}

let app: FastifyInstance;

beforeAll(() => {
  app = buildApp({
    config: loadConfig({
      QUERYNX_API_KEYS: "new-ep-key",
      ANONYMOUS_RATE_LIMIT_PER_MIN: "100000",
    }),
    orchestrator: new SearchOrchestrator([new AnswerProvider()]),
  });
});

afterAll(async () => {
  await app.close();
});

const KEY = { "x-api-key": "new-ep-key" };

describe("POST /v1/answer", () => {
  it("returns an extractive answer with citations (no LLM configured)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/answer",
      headers: KEY,
      payload: { question: "how does mvcc work" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.synthesized).toBe(false);
    expect(body.answer).toContain("Multiversion");
    expect(body.citations).toHaveLength(2);
    expect(body.citations[0]).toMatchObject({
      index: 1,
      url: expect.stringContaining("db.example"),
    });
  });

  it("returns honest empty-evidence answers", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/answer",
      headers: { ...KEY },
      payload: {
        question: "how does mvcc work",
        includeDomains: ["nothing-here.invalid"],
      },
    });
    const body = res.json();
    expect(body.answer).toContain("No supporting evidence");
    expect(body.citations).toHaveLength(0);
  });

  it("validates question length", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/answer",
      headers: KEY,
      payload: { question: "ab" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /v1/rerank", () => {
  it("reranks documents deterministically by term overlap", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/rerank",
      headers: KEY,
      payload: {
        query: "postgres mvcc snapshots",
        documents: [
          "Cooking pasta with tomato sauce recipes",
          "Postgres MVCC keeps snapshots visible during concurrent transactions",
          "Weather forecast for tomorrow",
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results[0].index).toBe(1);
    expect(body.results[0].relevance).toBeGreaterThan(0.5);
    expect(body.usedModel).toBe(false);
  });

  it("respects topN", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/rerank",
      headers: KEY,
      payload: {
        query: "anything",
        documents: ["a", "b", "c"],
        topN: 2,
      },
    });
    expect(res.json().results).toHaveLength(2);
  });
});

describe("POST /v1/extract/batch", () => {
  it("rejects SSRF targets", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/extract/batch",
      headers: KEY,
      payload: { urls: ["http://169.254.169.254/latest"] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("reports per-URL failures without failing the batch", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/extract/batch",
      headers: KEY,
      payload: { urls: ["https://unreachable.invalid/x"] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results[0].ok).toBe(false);
    expect(typeof body.results[0].error).toBe("string");
  }, 30_000);

  it("caps batches at 50 urls", async () => {
    const urls = Array.from({ length: 51 }, (_, i) => `https://x.example/${i}`);
    const res = await app.inject({
      method: "POST",
      url: "/v1/extract/batch",
      headers: KEY,
      payload: { urls },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /v1/crawl", () => {
  it("validates and rejects blocked seeds", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/crawl",
      headers: KEY,
      payload: { seeds: ["http://localhost:9/admin"] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepts valid seeds and returns a 202 job handle", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/crawl",
      headers: KEY,
      payload: {
        seeds: ["https://example.com/docs"],
        maxPages: 1,
        maxDepth: 0,
      },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.job.type).toBe("crawl");
    expect(body.job.id).toBeTruthy();
  });
});

describe("POST /v1/map", () => {
  it("rejects blocked targets", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/map",
      headers: KEY,
      payload: { url: "http://10.0.0.5/internal" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns a URL inventory with the seed even when unreachable", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/map",
      headers: KEY,
      payload: { url: "https://unreachable.example.com", limit: 5 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.discoveredCount).toBeGreaterThanOrEqual(1);
    // Canonical root URLs carry a trailing slash per WHATWG serialization.
    expect(body.urls).toContain("https://unreachable.example.com/");
  }, 60_000);
});

describe("GET /v1/jobs/:id/stream", () => {
  it("streams job status to a terminal event", async () => {
    // Submit an index job that dead-letters quickly (unreachable host).
    const submit = await app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: KEY,
      payload: {
        type: "index",
        payload: { url: "https://unreachable.invalid/x" },
      },
    });
    const { job } = submit.json();

    const res = await app.inject({
      method: "GET",
      url: `/v1/jobs/${job.id}/stream`,
      headers: KEY,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");

    const events = res.body.toString().split("\n\n");
    const names = events
      .filter((e) => e.startsWith("event: "))
      .map((e) => e.split("\n")[0]!.slice("event: ".length));
    expect(names[0]).toBe("start");
    expect(names).toContain("status");
    expect(names.at(-1)).toBe("done");
  }, 30_000);

  it("reports unknown jobs", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/jobs/00000000-0000-0000-0000-000000000000/stream",
      headers: KEY,
    });
    const events = res.body.toString();
    expect(events).toContain("event: error");
  });
});
