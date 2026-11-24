/**
 * Centralized environment-driven configuration.
 *
 * One loader for every service (api, worker). Credentials arrive only
 * via environment; nothing is hardcoded; nothing is mandatory — the
 * platform boots keyless and reports what is unconfigured honestly.
 */

export interface AppConfig {
  // HTTP
  port: number;
  host: string;
  logLevel: 'error' | 'warn' | 'info' | 'debug';

  // Auth
  apiKeys: string[];
  anonymousRateLimitPerMinute: number;

  // Search providers
  enabledProviders: string[];
  searxngBaseUrl?: string;
  searxngEngines?: string;
  braveApiKey?: string;
  tavilyApiKey?: string;
  providerConcurrency: number;
  providerTimeoutMs: number;

  // Cache
  searchCacheTtlMs: number;
  searchCacheMaxEntries: number;

  // Infrastructure backends (optional; memory fallbacks when unset)
  databaseUrl?: string;
  redisUrl?: string;
  queueBackend: 'memory' | 'redis';

  // Worker
  workerEnabled: boolean;
  workerConcurrency: number;

  // Embeddings (optional; deterministic hash embeddings when unset)
  embeddingsBaseUrl?: string;
  embeddingsApiKey?: string;
  embeddingsModel?: string;
  embeddingsDimensions: number;

  // Fetch policy
  allowPrivateNetworks: boolean;

  // Research
  researchMaxTimeMs: number;
}

function num(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const n = Number(env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function csv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const e = env as Record<string, string | undefined>;
  const level = e['LOG_LEVEL'] ?? 'info';
  const queueBackend = e['QUEUE_BACKEND'] === 'redis' ? 'redis' : 'memory';

  const searxngBaseUrl = e['SEARXNG_BASE_URL'];
  const braveApiKey = e['BRAVE_API_KEY'];
  const tavilyApiKey = e['TAVILY_API_KEY'];
  const explicit = csv(e['QUERYNX_PROVIDERS']);
  const detected = [
    searxngBaseUrl ? 'searxng' : '',
    braveApiKey ? 'brave' : '',
    tavilyApiKey ? 'tavily' : '',
  ].filter((s) => s.length > 0);

  return {
    port: num(e, 'PORT', 3001),
    host: e['HOST'] ?? '127.0.0.1',
    logLevel: (['error', 'warn', 'info', 'debug'].includes(level)
      ? level
      : 'info') as AppConfig['logLevel'],

    apiKeys: csv(e['QUERYNX_API_KEYS']),
    anonymousRateLimitPerMinute: num(e, 'ANONYMOUS_RATE_LIMIT_PER_MIN', 30),

    enabledProviders: explicit.length > 0 ? explicit : detected.length > 0 ? detected : ['searxng', 'brave', 'tavily'],
    searxngBaseUrl,
    searxngEngines: e['SEARXNG_ENGINES'],
    braveApiKey,
    tavilyApiKey,
    providerConcurrency: num(e, 'PROVIDER_CONCURRENCY', 4),
    providerTimeoutMs: num(e, 'PROVIDER_TIMEOUT_MS', 12_000),

    searchCacheTtlMs: num(e, 'SEARCH_CACHE_TTL_MS', 5 * 60_000),
    searchCacheMaxEntries: num(e, 'SEARCH_CACHE_MAX_ENTRIES', 1000),

    databaseUrl: e['DATABASE_URL'],
    redisUrl: e['REDIS_URL'],
    queueBackend: e['REDIS_URL'] ? queueBackend : 'memory',

    workerEnabled: e['QUERYNX_DISABLE_WORKER'] !== '1',
    workerConcurrency: num(e, 'WORKER_CONCURRENCY', 2),

    embeddingsBaseUrl: e['EMBEDDINGS_BASE_URL'],
    embeddingsApiKey: e['EMBEDDINGS_API_KEY'],
    embeddingsModel: e['EMBEDDINGS_MODEL'],
    embeddingsDimensions: num(e, 'EMBEDDINGS_DIMENSIONS', 384),

    allowPrivateNetworks: e['QUERYNX_ALLOW_PRIVATE_NETWORKS'] === 'true',

    researchMaxTimeMs: num(e, 'RESEARCH_MAX_TIME_MS', 300_000),
  };
}
