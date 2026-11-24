/**
 * Environment-driven API configuration.
 *
 * Credentials arrive only via environment variables. Nothing here is
 * hardcoded and no provider is mandatory: with zero keys the API runs
 * on the keyless SearXNG default, and with no SearXNG instance it
 * starts empty and reports unconfigured providers honestly.
 */

export interface ApiConfig {
  port: number;
  host: string;
  /** Comma-separated provider order, e.g. "searxng,brave". */
  enabledProviders: string[];
  searxngBaseUrl?: string;
  searxngEngines?: string;
  braveApiKey?: string;
  tavilyApiKey?: string;
  /** Result cache TTL in ms. */
  searchCacheTtlMs: number;
  searchCacheMaxEntries: number;
  /** Global provider fan-out concurrency. */
  providerConcurrency: number;
  /** Per-key request budget per minute for the anonymous tier. */
  anonymousRateLimitPerMinute: number;
  /** Master API keys with full access (comma-separated env). */
  apiKeys: string[];
  /** Postgres connection string; enables durable persistence. */
  databaseUrl?: string;
  /** Request logging. */
  logLevel: 'error' | 'warn' | 'info' | 'debug';
}

function num(env: string | undefined, fallback: number): number {
  const n = Number(env);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function csv(env: string | undefined): string[] {
  return (env ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const port = num(env['PORT'], 3001);
  const host = env['HOST'] ?? '127.0.0.1';

  const enabledProviders = csv(env['QUERYNX_PROVIDERS']);
  const searxngBaseUrl = env['SEARXNG_BASE_URL'];
  const braveApiKey = env['BRAVE_API_KEY'];
  const tavilyApiKey = env['TAVILY_API_KEY'];

  const defaults = ['searxng', 'brave', 'tavily'];
  const enabled =
    enabledProviders.length > 0
      ? enabledProviders
      : [searxngBaseUrl ? 'searxng' : '', braveApiKey ? 'brave' : '', tavilyApiKey ? 'tavily' : '']
          .concat([])
          .filter((s) => s.length > 0);
  // If nothing is configured we still enable all adapters: they report
  // isConfigured() honestly and the orchestrator degrades gracefully.
  const finalEnabled = enabled.length > 0 ? enabled : defaults;

  const level = (env['LOG_LEVEL'] ?? 'info') as ApiConfig['logLevel'];

  return {
    port,
    host,
    enabledProviders: finalEnabled,
    searxngBaseUrl,
    searxngEngines: env['SEARXNG_ENGINES'],
    braveApiKey,
    tavilyApiKey,
    searchCacheTtlMs: num(env['SEARCH_CACHE_TTL_MS'], 5 * 60_000),
    searchCacheMaxEntries: num(env['SEARCH_CACHE_MAX_ENTRIES'], 1000),
    providerConcurrency: num(env['PROVIDER_CONCURRENCY'], 4),
    anonymousRateLimitPerMinute: num(env['ANONYMOUS_RATE_LIMIT_PER_MIN'], 30),
    apiKeys: csv(env['QUERYNX_API_KEYS']),
    databaseUrl: env['DATABASE_URL'],
    logLevel: ['error', 'warn', 'info', 'debug'].includes(level) ? level : 'info',
  };
}
