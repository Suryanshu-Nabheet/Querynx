/**
 * Tool definitions exposed over MCP: search, extract, research.
 *
 * Descriptions are written for agent consumption: they state exactly
 * what each tool does, its inputs and its limits, so an agent can
 * route correctly without trial and error.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const SEARCH_TOOL: ToolDefinition = {
  name: 'querynx_search',
  description:
    'Search the web using the Querynx federated search engine. ' +
    'Returns normalized results (title, url, snippet, score) merged ' +
    'from multiple search providers with deduplication. Use for ' +
    'current information lookup, fact finding and source discovery.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query text' },
      maxResults: {
        type: 'integer',
        description: 'Maximum results to return (1-50, default 10)',
        minimum: 1,
        maximum: 50,
      },
      includeDomains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Restrict results to these domains',
      },
      excludeDomains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Exclude results from these domains',
      },
      category: {
        type: 'string',
        enum: ['web', 'news', 'academic', 'code', 'docs'],
        description: 'Query category for provider routing',
      },
      freshness: {
        type: 'string',
        enum: ['any', 'day', 'week', 'month', 'year'],
        description: 'Freshness window filter',
      },
    },
    required: ['query'],
  },
};

export const EXTRACT_TOOL: ToolDefinition = {
  name: 'querynx_extract',
  description:
    'Fetch one or more URLs and extract clean main content (boilerplate ' +
    'removed) plus structured metadata: title, author, publication date, ' +
    'headings, tables and links. Use when you need the full text of a ' +
    'specific page rather than a search snippet.',
  inputSchema: {
    type: 'object',
    properties: {
      urls: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 10,
        description: 'Absolute http(s) URLs to extract',
      },
    },
    required: ['urls'],
  },
};

export const RESEARCH_TOOL: ToolDefinition = {
  name: 'querynx_research',
  description:
    'Run a bounded autonomous research job: Querynx plans queries, ' +
    'searches the web, extracts relevant pages, deduplicates evidence ' +
    'and returns a structured report with findings, citations and ' +
    'remaining gaps. Slower than search; use for questions that need ' +
    'multi-source synthesis.',
  inputSchema: {
    type: 'object',
    properties: {
      objective: {
        type: 'string',
        description: 'The research question or objective',
        minLength: 3,
        maxLength: 1000,
      },
      mode: {
        type: 'string',
        enum: ['fast', 'standard', 'advanced', 'deep', 'academic', 'technical', 'documentation'],
        description: 'Research depth preset (default standard)',
      },
    },
    required: ['objective'],
  },
};

export const PROVIDERS_TOOL: ToolDefinition = {
  name: 'querynx_providers',
  description:
    'Check which search providers are configured and healthy on the ' +
    'connected Querynx instance, including circuit-breaker state and ' +
    'median latency. Use when search results look degraded.',
  inputSchema: { type: 'object', properties: {} },
};

export const ALL_TOOLS: ToolDefinition[] = [
  SEARCH_TOOL,
  EXTRACT_TOOL,
  RESEARCH_TOOL,
  PROVIDERS_TOOL,
];
