import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { QuerynxClient, QuerynxError } from "../src/client.js";

let server: Server;
let baseUrl: string;

/** Fixture API server implementing the Querynx surface. */
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = req.url ?? "/";
      const auth = req.headers["x-api-key"];

      if (url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", version: "0.1.0" }));
        return;
      }
      if (auth !== "secret-key") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { code: "UNAUTHORIZED", message: "bad key" },
            requestId: "r1",
          }),
        );
        return;
      }
      if (url === "/v1/search") {
        const parsed = JSON.parse(body) as { query: string };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            results: [
              {
                title: "Result",
                url: "https://example.com/r",
                snippet: "snippet",
                score: 0.9,
                provider: "stub",
              },
            ],
            query: parsed.query,
            generatedAt: new Date().toISOString(),
            diagnostics: {
              providersQueried: 1,
              providersSucceeded: 1,
              cacheHit: false,
              rawResultCount: 1,
              duplicateCount: 0,
              attempts: [],
            },
          }),
        );
        return;
      }
      if (url === "/flaky") {
        // Not a real endpoint; used for retry testing below via status 500.
        res.writeHead(500);
        res.end(
          JSON.stringify({
            error: { code: "INTERNAL_ERROR", message: "boom" },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("QuerynxClient", () => {
  const client = () => new QuerynxClient({ baseUrl, apiKey: "secret-key" });

  it("returns health status", async () => {
    const health = await client().health();
    expect(health.status).toBe("ok");
  });

  it("searches and returns typed results", async () => {
    const response = await client().search("test query", { maxResults: 5 });
    expect(response.results[0]!.title).toBe("Result");
    expect(response.query).toBe("test query");
  });

  it("sends API key and surfaces auth errors", async () => {
    const bad = new QuerynxClient({ baseUrl, apiKey: "wrong" });
    await expect(bad.search("x")).rejects.toMatchObject({
      name: "QuerynxError",
      status: 401,
      code: "UNAUTHORIZED",
    });
  });

  it("does not retry 4xx client errors and fails fast", async () => {
    // A nested base URL misses every fixture route -> 404, surfaced
    // immediately without retry delays.
    const c = new QuerynxClient({
      baseUrl: `${baseUrl}/nested`,
      apiKey: "secret-key",
      maxRetries: 3,
    });
    const started = Date.now();
    await expect(c.providers()).rejects.toMatchObject({ status: 404 });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("retries 5xx and eventually succeeds when the server recovers", async () => {
    let hits = 0;
    const flaky = createServer((req, res) => {
      hits++;
      if (hits < 3) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { code: "INTERNAL_ERROR", message: "boom" },
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", version: "0.1.0" }));
    });
    await new Promise<void>((r) => flaky.listen(0, "127.0.0.1", r));
    const port = (flaky.address() as { port: number }).port;
    const c = new QuerynxClient({
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: "k",
      maxRetries: 3,
      timeoutMs: 3000,
    });
    const health = await c.health();
    expect(health.status).toBe("ok");
    expect(hits).toBe(3);
    await new Promise<void>((r) => flaky.close(() => r()));
  });
});
