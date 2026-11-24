/**
 * Wire-contract tests for the REAL provider adapters.
 *
 * Every adapter runs against a local HTTP fixture implementing the
 * provider's documented wire format, asserting the exact request shape
 * the upstream must receive (method, path, query params, headers, body
 * fields) and the response parsing. These are the tests that catch
 * adapters which "pass" with in-memory fakes but cannot talk to the
 * real API — exactly how the Tavily body-after-GET defect slipped
 * through originally.
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import { SearxngProvider } from "../src/searxng.js";
import { BraveProvider } from "../src/brave.js";
import { TavilyProvider } from "../src/tavily.js";
import { setPrivateNetworkPolicy } from "@querynx/fetcher";

interface Captured {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function fixture(handler: (cap: Captured, res: ServerResponse) => unknown) {
  const captured: Captured[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const cap: Captured = {
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: { ...req.headers },
        body,
      };
      captured.push(cap);
      handler(cap, res as never);
    });
  });
  return { server, captured };
}

let closeAll: Array<() => Promise<void>> = [];

beforeAll(() => {
  setPrivateNetworkPolicy(true); // fixtures listen on loopback
});

afterAll(async () => {
  setPrivateNetworkPolicy(false);
  await Promise.all(closeAll.map((c) => c()));
  closeAll = [];
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  closeAll.push(
    () => new Promise<void>((r) => server.close(() => r())),
  );
  return `http://127.0.0.1:${port}`;
}

describe("SearxngProvider wire contract", () => {
  it("sends GET /search with documented params and parses the JSON format", async () => {
    const { server, captured } = fixture((cap, res) => {
      // SearXNG JSON format: results[] with title/url/content/publishedDate.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          results: [
            {
              title: "Result One",
              url: "https://example.com/one?utm_source=x",
              content: "first snippet",
              publishedDate: 1735689600, // epoch seconds
              engine: "bing",
            },
          ],
          unresponsive_engines: [],
        }),
      );
    });
    const base = await listen(server);

    const provider = new SearxngProvider({ baseUrl: base, safesearch: 1 });
    const results = await provider.search({
      query: "wire contract test",
      maxResults: 10,
      freshness: "week",
      category: "web",
      language: "en",
    });

    const req = captured[0]!;
    expect(req.method).toBe("GET");
    const url = new URL(req.url, base);
    expect(url.pathname).toBe("/search");
    const params = url.searchParams;
    expect(params.get("q")).toBe("wire contract test");
    expect(params.get("format")).toBe("json");
    expect(params.get("safesearch")).toBe("1");
    expect(params.get("time_range")).toBe("week"); // freshness mapped
    expect(params.get("language")).toBe("en");

    // Response parsing.
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe("Result One");
    expect(results[0]!.url).toBe("https://example.com/one"); // canonicalized (utm stripped)
    expect(results[0]!.snippet).toBe("first snippet");
    expect(results[0]!.publishedAt).toBe("2025-01-01T00:00:00.000Z");
  });

  it("maps academic category to SearXNG science engines", async () => {
    const { server, captured } = fixture((_cap, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: [] }));
    });
    const base = await listen(server);
    const provider = new SearxngProvider({ baseUrl: base });
    await provider.search({
      query: "attention mechanisms",
      maxResults: 5,
      category: "academic",
    });
    const url = new URL(captured[0]!.url, base);
    expect(url.searchParams.get("categories")).toBe("science");
  });

  it("surfaces non-JSON responses as explicit errors", async () => {
    const { server } = fixture((_cap, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>json format not enabled</html>");
    });
    const base = await listen(server);
    const provider = new SearxngProvider({ baseUrl: base });
    await expect(
      provider.search({ query: "x", maxResults: 5 }),
    ).rejects.toThrow(/non-JSON/);
  });
});

describe("BraveProvider wire contract", () => {
  it("sends GET /res/v1/web/search with the subscription token header", async () => {
    const { server, captured } = fixture((_cap, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          web: {
            results: [
              {
                title: "Brave Result",
                url: "https://brave.example/doc",
                description: "<b>bold</b> snippet text",
                page_age: "2026-01-02T00:00:00Z",
              },
            ],
          },
        }),
      );
    });
    const base = await listen(server);

    const provider = new BraveProvider({ apiKey: "brave-key-1", baseUrl: base });
    const results = await provider.search({
      query: "brave wire test",
      maxResults: 5,
      language: "en",
      region: "us",
      freshness: "month",
    });

    const req = captured[0]!;
    expect(req.method).toBe("GET");
    expect(req.headers["x-subscription-token"]).toBe("brave-key-1");
    expect(req.headers["accept"]).toBe("application/json");
    const url = new URL(req.url, base);
    expect(url.pathname).toBe("/res/v1/web/search");
    expect(url.searchParams.get("q")).toBe("brave wire test");
    expect(url.searchParams.get("search_lang")).toBe("en");
    expect(url.searchParams.get("country")).toBe("us");
    expect(url.searchParams.get("freshness")).toBe("pm"); // month
    expect(url.searchParams.get("count")).toBe("10"); // maxResults*2

    // Parsing: HTML stripped from descriptions, date parsed.
    expect(results[0]!.snippet).toBe("bold snippet text");
    expect(results[0]!.publishedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("reports rate limits distinctly", async () => {
    const { server } = fixture((_cap, res) => {
      res.writeHead(429);
      res.end();
    });
    const base = await listen(server);
    const provider = new BraveProvider({ apiKey: "k", baseUrl: base });
    await expect(provider.search({ query: "x", maxResults: 5 })).rejects.toThrow(
      /rate limit/i,
    );
  });
});

describe("TavilyProvider wire contract", () => {
  it("POSTS the documented body to /search with the bearer key", async () => {
    const { server, captured } = fixture((_cap, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          results: [
            {
              title: "Tavily Result",
              url: "https://tavily.example/page",
              content: "tavily snippet",
              score: 0.87,
              published_date: "2026-02-01",
            },
          ],
        }),
      );
    });
    const base = await listen(server);

    const provider = new TavilyProvider({ apiKey: "tvly-key", baseUrl: base });
    const results = await provider.search({
      query: "tavily wire test",
      maxResults: 5,
      includeDomains: ["a.com", "b.com"],
      excludeDomains: ["spam.com"],
    });

    const req = captured[0]!;
    // THE assertion that catches the historical defect: this must be a
    // POST whose body actually carries the query.
    expect(req.method).toBe("POST");
    expect(req.headers["authorization"]).toBe("Bearer tvly-key");
    const url = new URL(req.url, base);
    expect(url.pathname).toBe("/search");

    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body["query"]).toBe("tavily wire test");
    expect(body["max_results"]).toBe(10);
    expect(body["include_domains"]).toEqual(["a.com", "b.com"]);
    expect(body["exclude_domains"]).toEqual(["spam.com"]);

    expect(results[0]!.score).toBe(0.87);
    expect(results[0]!.publishedAt).toBe("2026-02-01");
  });

  it("rejects malformed JSON bodies", async () => {
    const { server } = fixture((_cap, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("gateway html error page");
    });
    const base = await listen(server);
    const provider = new TavilyProvider({ apiKey: "k", baseUrl: base });
    await expect(provider.search({ query: "x", maxResults: 5 })).rejects.toThrow();
  });
});

describe("Provider isConfigured gate", () => {
  it("refuses to run without credentials", () => {
    expect(new BraveProvider({ apiKey: "" }).isConfigured()).toBe(false);
    expect(new TavilyProvider({ apiKey: "" }).isConfigured()).toBe(false);
    expect(
      new SearxngProvider({ baseUrl: "not a url" }).isConfigured(),
    ).toBe(false);
    expect(
      new SearxngProvider({ baseUrl: "http://x:8080" }).isConfigured(),
    ).toBe(true);
  });
});
