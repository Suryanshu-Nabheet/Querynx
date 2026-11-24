import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import {
  createSearchCallable,
  createExtractCallable,
  createResearchCallable,
  createQuerynxCallables,
  toQueryEngineTools,
} from "../src/index.js";

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
                title: "Search hit",
                url: "https://example.com/hit",
                snippet: "hit snippet",
                score: 0.9,
                provider: "stub",
              },
            ],
            query: "x",
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
                url: "https://example.com/p",
                ok: true,
                document: {
                  url: "https://example.com/p",
                  title: "Page",
                  content: "Body text.",
                  format: "markdown",
                  headings: [],
                  links: [],
                  tables: [],
                  sections: [],
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
              findings: "Found things.",
              evidence: [
                {
                  url: "https://example.com/e",
                  title: "E",
                  passage: "p",
                  stepQuery: "q",
                  relevance: 1,
                },
              ],
              steps: [],
              gaps: [],
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
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("LlamaIndex callables", () => {
  it("search callable queries the API and formats output", async () => {
    const tool = createSearchCallable({ baseUrl });
    const out = await tool.call({ query: "anything" });
    expect(out).toContain("Search hit");
    expect(out).toContain("https://example.com/hit");
  });

  it("extract callable returns page content", async () => {
    const tool = createExtractCallable({ baseUrl });
    const out = await tool.call({ urls: ["https://example.com/p"] });
    expect(out).toContain("Body text.");
  });

  it("extract callable handles missing urls", async () => {
    const tool = createExtractCallable({ baseUrl });
    const out = await tool.call({});
    expect(out).toContain("No urls");
  });

  it("research callable returns findings with sources", async () => {
    const tool = createResearchCallable({ baseUrl });
    const out = await tool.call({ objective: "research question" });
    expect(out).toContain("Found things.");
    expect(out).toContain("https://example.com/e");
  });

  it("research callable rejects short objectives", async () => {
    const tool = createResearchCallable({ baseUrl });
    const out = await tool.call({ objective: "x" });
    expect(out).toContain("too short");
  });

  it("createQuerynxCallables bundles all three", () => {
    const tools = createQuerynxCallables({ baseUrl });
    expect(tools.map((t) => t.name).sort()).toEqual([
      "querynx_extract",
      "querynx_research",
      "querynx_search",
    ]);
  });

  it("toQueryEngineTools degrades gracefully without the framework", async () => {
    const tools = await toQueryEngineTools({ baseUrl });
    expect(tools.length).toBe(3);
    // Without llamaindex installed these are the plain callables.
    const first = tools[0] as {
      call: (i: Record<string, unknown>) => Promise<string>;
    };
    const out = await first.call({ query: "q" });
    expect(out).toContain("Search hit");
  });
});
