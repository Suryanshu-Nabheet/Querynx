/**
 * LangChain integration: Querynx capabilities as StructuredTools that
 * plug into any LangChain agent.
 *
 *    import { QuerynxSearchTool } from '@querynx/langchain';
 *    const agent = createReactAgent({ llm, tools: [
 *      new QuerynxSearchTool({ baseUrl: 'http://localhost:3001' }),
 *    ]});
 *
 * Tools use @langchain/core's StructuredTool contract with zod schemas.
 */

import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { QuerynxClient } from '@querynx/sdk';

export interface QuerynxToolOptions {
  baseUrl: string;
  apiKey?: string;
}

/** Federated web search as a LangChain tool. */
export class QuerynxSearchTool extends StructuredTool {
  static override lc_name() {
    return 'QuerynxSearchTool';
  }
  override name = 'querynx_search';
  override description =
    'Search the web via the self-hosted Querynx federated engine. ' +
    'Returns deduplicated results with title, url and snippet. ' +
    'Use for current information, fact lookup and source discovery.';

  override schema = z.object({
    query: z.string().min(1).max(500).describe('The search query'),
    maxResults: z.number().int().min(1).max(20).optional()
      .describe('Maximum results (default 5)'),
    freshness: z.enum(['any', 'day', 'week', 'month', 'year']).optional()
      .describe('Freshness window'),
  });

  private readonly client: QuerynxClient;

  constructor(options: QuerynxToolOptions) {
    super();
    this.client = new QuerynxClient({ baseUrl: options.baseUrl, apiKey: options.apiKey });
  }

  async _call(input: {
    query: string;
    maxResults?: number;
    freshness?: 'any' | 'day' | 'week' | 'month' | 'year';
  }): Promise<string> {
    const response = await this.client.search(input.query, {
      maxResults: input.maxResults ?? 5,
      freshness: input.freshness,
    });
    return response.results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      .join('\n\n') || 'No results found.';
  }
}

/** Page content extraction as a LangChain tool. */
export class QuerynxExtractTool extends StructuredTool {
  static override lc_name() {
    return 'QuerynxExtractTool';
  }
  override name = 'querynx_extract';
  override description =
    'Fetch URL(s) and extract clean main content plus metadata ' +
    '(title, author, date). Use when the full text of a specific page is needed.';
  override schema = z.object({
    urls: z.array(z.string().url()).min(1).max(5).describe('URLs to extract'),
  });

  private readonly client: QuerynxClient;

  constructor(options: QuerynxToolOptions) {
    super();
    this.client = new QuerynxClient({ baseUrl: options.baseUrl, apiKey: options.apiKey });
  }

  async _call(input: { urls: string[] }): Promise<string> {
    const response = await this.client.extract(input.urls);
    return response.results
      .map((r) =>
        r.ok
          ? `## ${r.document?.title ?? r.url}\n${r.document?.content?.slice(0, 4000) ?? ''}`
          : `FAILED ${r.url}: ${r.error}`
      )
      .join('\n\n');
  }
}

/** Bounded autonomous research as a LangChain tool. */
export class QuerynxResearchTool extends StructuredTool {
  static override lc_name() {
    return 'QuerynxResearchTool';
  }
  override name = 'querynx_research';
  override description =
    'Run a multi-source research job: plans queries, searches, extracts, ' +
    'deduplicates evidence and returns findings with citations. Slower ' +
    'than search; use for questions needing synthesis across sources.';
  override schema = z.object({
    objective: z.string().min(3).max(500).describe('Research question'),
    mode: z
      .enum(['fast', 'standard', 'advanced', 'deep', 'academic', 'technical', 'documentation'])
      .optional()
      .describe('Depth preset (default standard)'),
  });

  private readonly client: QuerynxClient;

  constructor(options: QuerynxToolOptions) {
    super();
    this.client = new QuerynxClient({ baseUrl: options.baseUrl, apiKey: options.apiKey });
  }

  async _call(input: { objective: string; mode?: 'fast' | 'standard' | 'advanced' | 'deep' | 'academic' | 'technical' | 'documentation' }): Promise<string> {
    const { report } = await this.client.research(input.objective, { mode: input.mode });
    const citations = report.evidence
      .slice(0, 8)
      .map((e) => `- ${e.title}: ${e.url}`)
      .join('\n');
    return `${report.findings}\n\nSources:\n${citations}${
      report.gaps.length > 0
        ? `\n\nUnresolved:\n${report.gaps.map((g) => `- ${g.question}`).join('\n')}`
        : ''
    }`;
  }
}

/** All three tools bundled for agents that want everything. */
export function createQuerynxTools(options: QuerynxToolOptions): StructuredTool[] {
  return [
    new QuerynxSearchTool(options),
    new QuerynxExtractTool(options),
    new QuerynxResearchTool(options),
  ];
}
