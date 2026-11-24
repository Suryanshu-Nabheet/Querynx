/**
 * LlamaIndex integration.
 *
 * Querynx capabilities as self-contained async callables with the exact
 * metadata shape LlamaIndex agents expect for tool registration. When
 * the `llamaindex` package is installed, `toQueryEngineTools` adapts
 * them; without it, the plain wrappers below still run (framework
 * optional, per the directive: integrations must work against real
 * backend services without forcing heavyweight deps).
 */

import { QuerynxClient } from "@querynx/sdk";
import type { SearchResponse } from "@querynx/types";
import type { ResearchReport } from "@querynx/research";

export interface QuerynxLlamaOptions {
  baseUrl: string;
  apiKey?: string;
}

/** A callable + metadata pair matching LlamaIndex's tool contract. */
export interface CallableToolLike {
  name: string;
  description: string;
  call: (input: Record<string, unknown>) => Promise<string>;
}

/** Web search callable. */
export function createSearchCallable(
  options: QuerynxLlamaOptions,
): CallableToolLike {
  const client = new QuerynxClient({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
  });
  return {
    name: "querynx_search",
    description:
      'Search the web through the Querynx federated engine. Input: {"query": string, "maxResults"?: number}. ' +
      "Returns ranked deduplicated results with title, url, snippet.",
    call: async (input) => {
      const query = String(input["query"] ?? "");
      const maxResults = Number(input["maxResults"] ?? 5);
      const response: SearchResponse = await client.search(query, {
        maxResults,
      });
      return (
        response.results
          .map((r, i) => `${i + 1}. ${r.title} — ${r.url}\n   ${r.snippet}`)
          .join("\n\n") || "No results found."
      );
    },
  };
}

/** Extraction callable. */
export function createExtractCallable(
  options: QuerynxLlamaOptions,
): CallableToolLike {
  const client = new QuerynxClient({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
  });
  return {
    name: "querynx_extract",
    description:
      'Fetch URL(s) and extract main content and metadata. Input: {"urls": string[]}. ' +
      "Returns clean page text for each URL.",
    call: async (input) => {
      const urls = Array.isArray(input["urls"])
        ? (input["urls"] as string[])
        : [];
      if (urls.length === 0) return "No urls provided.";
      const response = await client.extract(urls);
      return response.results
        .map((r) =>
          r.ok
            ? `## ${r.document?.title ?? r.url}\n${r.document?.content?.slice(0, 4000) ?? ""}`
            : `FAILED ${r.url}: ${r.error}`,
        )
        .join("\n\n");
    },
  };
}

/** Research callable. */
export function createResearchCallable(
  options: QuerynxLlamaOptions,
): CallableToolLike {
  const client = new QuerynxClient({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
  });
  return {
    name: "querynx_research",
    description:
      'Run a bounded multi-source research job. Input: {"objective": string, "mode"?: string}. ' +
      "Returns findings, evidence citations and unresolved questions.",
    call: async (input) => {
      const objective = String(input["objective"] ?? "");
      if (objective.length < 3) return "Objective too short.";
      const { report } = await client.research(objective, {
        mode: input["mode"] as "fast" | "standard" | undefined,
      });
      const r = report as ResearchReport;
      const sources = r.evidence
        .slice(0, 8)
        .map((e) => `- ${e.url}`)
        .join("\n");
      const gaps =
        r.gaps.length > 0
          ? `\n\nUnresolved:\n${r.gaps.map((g) => `- ${g.question}`).join("\n")}`
          : "";
      return `${r.findings}\n\nSources:\n${sources}${gaps}`;
    },
  };
}

/** All callables for agents that want the full set. */
export function createQuerynxCallables(
  options: QuerynxLlamaOptions,
): CallableToolLike[] {
  return [
    createSearchCallable(options),
    createExtractCallable(options),
    createResearchCallable(options),
  ];
}

/**
 * Adapt callables into LlamaIndex FunctionTool objects when the
 * framework is installed. Returns the raw callables otherwise so the
 * same code path works in both environments.
 */
export async function toQueryEngineTools(
  options: QuerynxLlamaOptions,
): Promise<unknown[]> {
  const callables = createQuerynxCallables(options);
  try {
    const mod = (await import("llamaindex")) as unknown as {
      FunctionTool?: new <T, R>(
        fn: (input: T) => R,
        metadata: {
          name: string;
          description: string;
          parameters: Record<string, unknown>;
        },
      ) => unknown;
    };
    if (mod.FunctionTool) {
      return callables.map(
        (c) =>
          new mod.FunctionTool!<Record<string, unknown>, Promise<string>>(
            (input: Record<string, unknown>) => c.call(input),
            {
              name: c.name,
              description: c.description,
              parameters: { type: "object", properties: {} },
            },
          ),
      );
    }
    return callables;
  } catch {
    // llamaindex not installed: return the plain callables.
    return callables;
  }
}
