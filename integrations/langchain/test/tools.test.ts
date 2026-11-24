import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import {
  QuerynxSearchTool,
  QuerynxExtractTool,
  QuerynxResearchTool,
  createQuerynxTools,
} from "../src/index.js";

let server: Server;
let baseUrl: string;

/** Minimal Querynx API fixture. */
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
                title: "Result one",
                url: "https://example.com/1",
                snippet: "First snippet",
                score: 0.9,
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
                  title: "Extracted page",
                  content: "Full page body content here.",
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
              findings: "Research findings text.",
              evidence: [
                {
                  url: "https://example.com/e",
                  title: "Evidence",
                  passage: "p",
                  stepQuery: "q",
                  relevance: 0.8,
                },
              ],
              steps: [],
              gaps: [{ question: "Open question?", attemptedQueries: [] }],
              usage: {
                queries: 1,
                pagesFetched: 0,
                elapsedMs: 5,
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

describe("LangChain tools", () => {
  it("search tool returns formatted results", async () => {
    const tool = new QuerynxSearchTool({ baseUrl });
    const output = await tool.invoke({ query: "test", maxResults: 3 });
    expect(output).toContain("Result one");
    expect(output).toContain("https://example.com/1");
  });

  it("extract tool returns page content", async () => {
    const tool = new QuerynxExtractTool({ baseUrl });
    const output = await tool.invoke({ urls: ["https://example.com/page"] });
    expect(output).toContain("Extracted page");
    expect(output).toContain("Full page body content");
  });

  it("research tool returns findings with citations and gaps", async () => {
    const tool = new QuerynxResearchTool({ baseUrl });
    const output = await tool.invoke({ objective: "research topic" });
    expect(output).toContain("Research findings text.");
    expect(output).toContain("https://example.com/e");
    expect(output).toContain("Open question?");
  });

  it("createQuerynxTools bundles all tools", () => {
    const tools = createQuerynxTools({ baseUrl });
    expect(tools.map((t) => t.name)).toEqual([
      "querynx_search",
      "querynx_extract",
      "querynx_research",
    ]);
  });

  it("tools carry agent-consumable descriptions", () => {
    const tool = new QuerynxSearchTool({ baseUrl });
    expect(tool.description.length).toBeGreaterThan(20);
    expect(tool.name).toBe("querynx_search");
  });
});
