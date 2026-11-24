/**
 * Querynx MCP server.
 *
 * Exposes Querynx search, extraction, research and provider-health as
 * MCP tools over stdio, so any MCP-compatible agent (Claude Code,
 * Claude Desktop, IDE agents) can use self-hosted web intelligence.
 *
 * Run standalone with QUERYNX_URL (and optionally QUERYNX_API_KEY):
 *   QUERYNX_URL=http://localhost:3001 npx tsx src/server.ts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { QuerynxClient } from "@querynx/sdk";
import {
  SEARCH_TOOL,
  EXTRACT_TOOL,
  RESEARCH_TOOL,
  PROVIDERS_TOOL,
} from "./tools.js";

export function createMcpServer(client: QuerynxClient): McpServer {
  const server = new McpServer(
    { name: "querynx", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.tool(
    SEARCH_TOOL.name,
    SEARCH_TOOL.description,
    {
      query: z.string().min(1).max(500),
      maxResults: z.number().int().min(1).max(50).optional(),
      includeDomains: z.array(z.string()).max(20).optional(),
      excludeDomains: z.array(z.string()).max(20).optional(),
      category: z.enum(["web", "news", "academic", "code", "docs"]).optional(),
      freshness: z.enum(["any", "day", "week", "month", "year"]).optional(),
    },
    async (args) => {
      const response = await client.search(args.query, {
        maxResults: args.maxResults,
        includeDomains: args.includeDomains,
        excludeDomains: args.excludeDomains,
        category: args.category,
        freshness: args.freshness,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                results: response.results,
                diagnostics: response.diagnostics,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    EXTRACT_TOOL.name,
    EXTRACT_TOOL.description,
    {
      urls: z.array(z.string().url()).min(1).max(10),
    },
    async (args) => {
      const response = await client.extract(args.urls);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              response.results.map((r) =>
                r.ok
                  ? {
                      url: r.url,
                      title: r.document?.title,
                      content: r.document?.content,
                      metadata: r.document?.metadata,
                    }
                  : { url: r.url, error: r.error },
              ),
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    RESEARCH_TOOL.name,
    RESEARCH_TOOL.description,
    {
      objective: z.string().min(3).max(1000),
      mode: z
        .enum([
          "fast",
          "standard",
          "advanced",
          "deep",
          "academic",
          "technical",
          "documentation",
        ])
        .optional(),
    },
    async (args) => {
      const { report } = await client.research(args.objective, {
        mode: args.mode,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                findings: report.findings,
                evidence: report.evidence.map((e) => ({
                  url: e.url,
                  title: e.title,
                  relevance: e.relevance,
                })),
                gaps: report.gaps,
                usage: report.usage,
                termination: report.termination,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(PROVIDERS_TOOL.name, PROVIDERS_TOOL.description, {}, async () => {
    const { providers } = await client.providers();
    return {
      content: [{ type: "text", text: JSON.stringify(providers, null, 2) }],
    };
  });

  return server;
}

/** Standalone stdio entrypoint. */
export async function runStdio(): Promise<void> {
  const url = process.env["QUERYNX_URL"];
  if (!url) {
    console.error("QUERYNX_URL is required (e.g. http://localhost:3001)");
    process.exit(1);
  }
  const client = new QuerynxClient({
    baseUrl: url,
    apiKey: process.env["QUERYNX_API_KEY"],
  });
  const server = createMcpServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && process.env["QUERYNX_MCP_STANDALONE"] === "1") {
  runStdio().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
