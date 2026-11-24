import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { runCli, parseArgs } from "../src/index.js";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = req.url ?? "";
      if (url === "/v1/search") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            results: [
              {
                title: "CLI result",
                url: "https://example.com/cli",
                snippet: "cli snippet",
                score: 1,
                provider: "stub",
              },
            ],
            query: JSON.parse(body).query,
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
      if (url === "/v1/extract") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            results: [
              {
                url: "https://example.com/page",
                ok: true,
                document: {
                  url: "https://example.com/page",
                  title: "Page title",
                  content: "extracted content",
                  format: "markdown",
                  fingerprint: "f",
                  statusCode: 200,
                  fetchedAt: new Date().toISOString(),
                  warnings: [],
                },
              },
            ],
            generatedAt: new Date().toISOString(),
          }),
        );
        return;
      }
      if (url === "/v1/research") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            report: {
              objective: "x",
              mode: "fast",
              findings: "found",
              evidence: [
                {
                  url: "https://e.example",
                  title: "E",
                  passage: "p",
                  stepQuery: "q",
                  relevance: 1,
                },
              ],
              steps: [],
              gaps: [{ question: "unresolved?", attemptedQueries: [] }],
              usage: {
                queries: 1,
                pagesFetched: 0,
                elapsedMs: 1,
                contentChars: 0,
              },
              termination: "coverage-reached",
              completedAt: new Date().toISOString(),
            },
            events: [],
            requestId: "r",
          }),
        );
        return;
      }
      if (url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", version: "0.1.0" }));
        return;
      }
      if (url === "/v1/providers") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            providers: [
              {
                name: "stub",
                state: "closed",
                successRate: 1,
                medianLatencyMs: 5,
                configured: true,
              },
            ],
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("parseArgs", () => {
  it("splits flags, options and positionals", () => {
    // Real shells tokenize; "hello world" arrives as two argv tokens.
    const parsed = parseArgs([
      "search",
      "hello",
      "world",
      "--max",
      "5",
      "--json",
    ]);
    expect(parsed.positionals).toEqual(["search", "hello", "world"]);
    expect(parsed.options["max"]).toBe("5");
    expect(parsed.flags.has("json")).toBe(true);
  });

  it("supports --key=value syntax", () => {
    const parsed = parseArgs(["--url=http://x", "cmd"]);
    expect(parsed.options["url"]).toBe("http://x");
    expect(parsed.positionals).toEqual(["cmd"]);
  });
});

describe("runCli", () => {
  it("search formats results", async () => {
    const out = await runCli(["search", "test query", "--url", baseUrl]);
    expect(out.exitCode).toBe(0);
    expect(out.text).toContain("CLI result");
    expect(out.text).toContain("https://example.com/cli");
  });

  it("extract prints page content", async () => {
    const out = await runCli([
      "extract",
      "https://example.com/page",
      "--url",
      baseUrl,
    ]);
    expect(out.exitCode).toBe(0);
    expect(out.text).toContain("Page title");
    expect(out.text).toContain("extracted content");
  });

  it("research prints findings with sources and gaps", async () => {
    const out = await runCli(["research", "objective here", "--url", baseUrl]);
    expect(out.exitCode).toBe(0);
    expect(out.text).toContain("found");
    expect(out.text).toContain("https://e.example");
    expect(out.text).toContain("unresolved?");
    expect(out.text).toContain("termination: coverage-reached");
  });

  it("status prints health json", async () => {
    const out = await runCli(["status", "--url", baseUrl]);
    expect(out.exitCode).toBe(0);
    expect(out.text).toContain('"ok"');
  });

  it("providers lists health rows", async () => {
    const out = await runCli(["providers", "--url", baseUrl]);
    expect(out.exitCode).toBe(0);
    expect(out.text).toContain("stub");
    expect(out.text).toContain("state=closed");
  });

  it("missing command shows usage", async () => {
    const out = await runCli([]);
    expect(out.exitCode).toBe(2);
    expect(out.text).toContain("Usage:");
  });

  it("search without query shows usage", async () => {
    const out = await runCli(["search"]);
    expect(out.exitCode).toBe(2);
    expect(out.text).toContain("requires a query");
  });

  it("surfaces API errors with exit codes", async () => {
    const out = await runCli(["status", "--url", "http://127.0.0.1:1"]);
    expect(out.exitCode).not.toBe(0);
    expect(out.text).toContain("error:");
  });
});
