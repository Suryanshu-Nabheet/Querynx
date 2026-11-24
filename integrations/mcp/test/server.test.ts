import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/server.js";
import { QuerynxClient } from "@querynx/sdk";

let api: Server;
let baseUrl: string;

/** Minimal Querynx API fixture the MCP server will talk to. */
beforeAll(async () => {
  api = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = req.url ?? "/";
      if (req.headers["x-api-key"] !== "mcp-test-key") {
        res.writeHead(401).end();
        return;
      }
      if (url === "/v1/search") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            results: [
              {
                title: "MVCC in PostgreSQL",
                url: "https://example.com/mvcc",
                snippet: "Concurrency control overview",
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
                  title: "Example page",
                  content: "Main content of the page",
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
              objective: JSON.parse(body).objective,
              mode: "fast",
              findings: "Summary of findings.",
              evidence: [
                {
                  url: "https://example.com/r",
                  title: "Source",
                  passage: "passage",
                  stepQuery: "q",
                  relevance: 0.8,
                },
              ],
              steps: [],
              gaps: [],
              usage: {
                queries: 1,
                pagesFetched: 1,
                elapsedMs: 5,
                contentChars: 100,
              },
              termination: "coverage-reached",
              completedAt: new Date().toISOString(),
            },
            events: [],
            requestId: "req-1",
          }),
        );
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
                consecutiveFailures: 0,
                successRate: 1,
                medianLatencyMs: 10,
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
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => api.close(() => r()));
});

describe("MCP server over in-memory transport", () => {
  it("lists all Querynx tools", async () => {
    const { client, cleanup } = await connect();
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "querynx_extract",
      "querynx_providers",
      "querynx_research",
      "querynx_search",
    ]);
    await cleanup();
  });

  it("searches through the tool protocol", async () => {
    const { client, cleanup } = await connect();
    const result = await client.callTool({
      name: "querynx_search",
      arguments: { query: "postgres mvcc", maxResults: 5 },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!
      .text;
    const parsed = JSON.parse(text) as { results: Array<{ title: string }> };
    expect(parsed.results[0]!.title).toBe("MVCC in PostgreSQL");
    await cleanup();
  });

  it("extracts URLs through the tool protocol", async () => {
    const { client, cleanup } = await connect();
    const result = await client.callTool({
      name: "querynx_extract",
      arguments: { urls: ["https://example.com/page"] },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!
      .text;
    const parsed = JSON.parse(text) as Array<{ url: string; title?: string }>;
    expect(parsed[0]!.title).toBe("Example page");
    await cleanup();
  });

  it("runs research through the tool protocol", async () => {
    const { client, cleanup } = await connect();
    const result = await client.callTool({
      name: "querynx_research",
      arguments: { objective: "how does mvcc work", mode: "fast" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!
      .text;
    const parsed = JSON.parse(text) as {
      findings: string;
      termination: string;
    };
    expect(parsed.findings).toContain("Summary");
    expect(parsed.termination).toBe("coverage-reached");
    await cleanup();
  });

  it("reports provider health", async () => {
    const { client, cleanup } = await connect();
    const result = await client.callTool({
      name: "querynx_providers",
      arguments: {},
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!
      .text;
    const parsed = JSON.parse(text) as Array<{ name: string }>;
    expect(parsed[0]!.name).toBe("stub");
    await cleanup();
  });

  it("surfaces invalid tool arguments as isError results", async () => {
    const { client, cleanup } = await connect();
    // MCP reports schema violations as tool results with isError set,
    // not as protocol-level rejections.
    const result = await client.callTool({
      name: "querynx_search",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]!
      .text;
    expect(text).toContain("validation error");
    await cleanup();
  });
});

async function connect(): Promise<{
  client: Client;
  cleanup: () => Promise<void>;
}> {
  const sdkClient = new QuerynxClient({ baseUrl, apiKey: "mcp-test-key" });
  const server = createMcpServer(sdkClient);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "0.1.0" });
  await client.connect(clientTransport);

  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}
