# Integrations

Everything an agent or application needs to use a Querynx instance.

## MCP server

Model Context Protocol over stdio — the native path for coding agents
and MCP-compatible assistants.

```json
{
  "mcpServers": {
    "querynx": {
      "command": "npx",
      "args": ["tsx", "integrations/mcp/src/server.ts"],
      "env": {
        "QUERYNX_URL": "http://localhost:3001",
        "QUERYNX_MCP_STANDALONE": "1",
        "QUERYNX_API_KEY": "optional"
      }
    }
  }
}
```

Tools exposed (agent-oriented descriptions, zod-validated inputs):

| Tool              | Use for                                            |
| ----------------- | -------------------------------------------------- |
| querynx_search    | Current information, fact lookup, source discovery |
| querynx_extract   | Full text of a specific page                       |
| querynx_research  | Multi-source synthesis with citations and gaps     |
| querynx_providers | Diagnose degraded search (health/circuit state)    |

## TypeScript SDK

```ts
import { QuerynxClient } from "@querynx/sdk";

const client = new QuerynxClient({
  baseUrl: "http://localhost:3001",
  apiKey: "your-key",
});

const search = await client.search("postgres mvcc", { maxResults: 5 });
const page = await client.extract(["https://example.com/article"]);
const { report } = await client.research("how does mvcc work", {
  mode: "fast",
});
```

Retries on 5xx with exponential backoff; 4xx fail fast with typed
`QuerynxError` (status, code, requestId).

## Python SDK

```python
from querynx import QuerynxClient

client = QuerynxClient("http://localhost:3001", api_key="key")

results = client.search("postgres mvcc", max_results=5)
doc = client.extract(["https://example.com/article"])
report = client.research("how does mvcc work", mode="fast")

# Async parity
from querynx import AsyncQuerynxClient
async_client = AsyncQuerynxClient("http://localhost:3001")
results = await async_client.search("async queries")
```

## CLI

```bash
pnpm --filter @querynx/cli start -- search "postgres mvcc"
pnpm --filter @querynx/cli start -- research "compare caching strategies" --mode advanced
pnpm --filter @querynx/cli start -- providers
```

Environment: `QUERYNX_URL`, `QUERYNX_API_KEY`.

## LangChain

```ts
import { createQuerynxTools } from "@querynx/langchain";

const tools = createQuerynxTools({ baseUrl: "http://localhost:3001" });
// -> [QuerynxSearchTool, QuerynxExtractTool, QuerynxResearchTool]
// StructuredTool subclasses: drop into any LangChain agent.
```

## LlamaIndex

```ts
import { toQueryEngineTools } from "@querynx/llamaindex";

const tools = await toQueryEngineTools({ baseUrl: "http://localhost:3001" });
// FunctionTool objects when llamaindex is installed; plain callables
// with identical contracts otherwise.
```

## Tavily-compatible API

Existing Tavily clients work unchanged — point them at your instance:

```python
# Before: client = TavilyClient(api_key="tvly-...")
# After:
import httpx
r = httpx.post("http://localhost:3001/search", json={
    "api_key": "your-querynx-key",
    "query": "your query",
    "max_results": 5,
    "include_answer": True,
})
```

Request and response shapes, error envelopes and header auth follow
Tavily's documented contract; compatibility is test-covered.

## HTTP directly

The API is the contract: 14 documented operations, OpenAPI 3.1 spec at
`docs/openapi.json`, SSE streaming for search and research, consistent
error envelopes with request ids. Anything that speaks HTTP works.
