'use client';

/**
 * Dashboard API access.
 *
 * The dashboard talks to the Querynx HTTP API directly with fetch —
 * it runs in the browser, so it needs no SDK dependency (the SDK's
 * Node-oriented retry/agent logic stays server-side). Connection
 * settings persist in localStorage.
 */

export function getStoredConnection(): { url: string; apiKey?: string } {
  if (typeof window === 'undefined') {
    return { url: process.env['NEXT_PUBLIC_QUERYNX_URL'] ?? 'http://127.0.0.1:3001' };
  }
  const url =
    localStorage.getItem('querynx.url') ??
    process.env['NEXT_PUBLIC_QUERYNX_URL'] ??
    'http://127.0.0.1:3001';
  const apiKey = localStorage.getItem('querynx.key') ?? undefined;
  return { url, apiKey };
}

export function storeConnection(url: string, apiKey?: string): void {
  localStorage.setItem('querynx.url', url);
  if (apiKey) localStorage.setItem('querynx.key', apiKey);
  else localStorage.removeItem('querynx.key');
}

/** Throw typed errors mirroring the API error envelope. */
export class DashboardApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'DashboardApiError';
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const { url, apiKey } = getStoredConnection();
  const response = await fetch(`${url}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    let code: string | undefined;
    try {
      const body = (await response.json()) as { error?: { message?: string; code?: string } };
      message = body.error?.message ?? message;
      code = body.error?.code;
    } catch {
      // non-JSON error body
    }
    throw new DashboardApiError(message, response.status, code);
  }
  return (await response.json()) as T;
}

export const apiGet = <T>(path: string) => api<T>(path);
export const apiPost = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body) });

// ---- Typed response views used by pages ----------------------------

export interface SearchResultView {
  title: string;
  url: string;
  snippet: string;
  score: number;
  provider: string;
  metadata?: { providers?: string[] } & Record<string, unknown>;
}

export interface SearchResponseView {
  results: SearchResultView[];
  diagnostics: {
    providersQueried: number;
    providersSucceeded: number;
    duplicateCount: number;
  };
}

export interface ExtractItemView {
  url: string;
  ok: boolean;
  document?: {
    title?: string;
    content?: string;
    metadata?: { author?: string; publishedAt?: string };
  };
  error?: string;
}

export interface ResearchReportView {
  report: {
    findings: string;
    evidence: Array<{ url: string; title: string; passage: string; relevance: number }>;
    gaps: Array<{ question: string }>;
    usage: { queries: number; pagesFetched: number; elapsedMs: number };
    termination: string;
  };
}

export interface ProvidersResponseView {
  providers: Array<{
    name: string;
    state: string;
    configured: boolean;
    successRate: number;
    medianLatencyMs: number;
  }>;
}

export interface IndexStatsView {
  stats: { documents: number; collections: number; uniqueTerms: number; contentChars: number };
}

export interface SemanticResponseView {
  results: Array<{
    title: string;
    url: string;
    snippet: string;
    score: number;
    matchedTerms: string[];
    collection: string;
  }>;
}
