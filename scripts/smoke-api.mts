#!/usr/bin/env node
/**
 * API production smoke test: boots the real server, probes health,
 * runs a search round-trip against a stub-free configuration (SearXNG
 * unreachable is the honest expected state), verifies graceful
 * degradation and the metrics surface — then shuts down.
 *
 * Exits non-zero on any failure.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

const PORT = 13001;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = 'smoke-key-123';

interface Check {
  name: string;
  fn: () => Promise<void>;
}

async function fetchJson(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${BASE}${path}`, init);
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

const checks: Check[] = [
  {
    name: 'health returns ok',
    fn: async () => {
      const { status, body } = await fetchJson('/health');
      if (status !== 200) throw new Error(`health status ${status}`);
      const health = body as { status: string };
      if (health.status !== 'ok') throw new Error(`health body ${JSON.stringify(body)}`);
    },
  },
  {
    name: 'ready reports provider state',
    fn: async () => {
      const { body } = await fetchJson('/ready');
      const ready = body as { status: string; providers: Array<{ name: string }> };
      if (!['ready', 'degraded'].includes(ready.status)) {
        throw new Error(`unexpected ready status ${ready.status}`);
      }
      if (!Array.isArray(ready.providers) || ready.providers.length === 0) {
        throw new Error('ready reports no providers');
      }
    },
  },
  {
    name: 'search requires auth when keys configured',
    fn: async () => {
      const { status } = await fetchJson('/v1/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'x' }),
      });
      if (status !== 401) throw new Error(`expected 401, got ${status}`);
    },
  },
  {
    name: 'search round-trips with auth (degrades honestly)',
    fn: async () => {
      const { status, body } = await fetchJson('/v1/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': KEY },
        body: JSON.stringify({ query: 'smoke test query' }),
      });
      if (status !== 200) throw new Error(`search status ${status}`);
      const search = body as {
        results: unknown[];
        diagnostics: { attempts: Array<{ status: string }> };
      };
      // With no reachable provider the API must still respond 200
      // with honest attempt diagnostics.
      if (!Array.isArray(search.results)) throw new Error('no results array');
      if (search.diagnostics.attempts.some((a) => a.status === 'ok')) {
        throw new Error('unexpected provider success with nothing configured');
      }
    },
  },
  {
    name: 'ssrf protection rejects metadata targets',
    fn: async () => {
      const { status, body } = await fetchJson('/v1/extract', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': KEY },
        body: JSON.stringify({ urls: ['http://169.254.169.254/latest'] }),
      });
      if (status !== 400) throw new Error(`expected 400, got ${status}`);
      const err = body as { error: { code: string } };
      if (err.error.code !== 'VALIDATION_ERROR') throw new Error('wrong error code');
    },
  },
  {
    name: 'metrics expose prometheus text',
    fn: async () => {
      const response = await fetch(`${BASE}/metrics`);
      if (response.status !== 200) throw new Error(`metrics status ${response.status}`);
      const text = await response.text();
      if (!text.includes('querynx_cache')) throw new Error('missing querynx metrics');
    },
  },
];

// ---- Boot ----
const server = spawn('npx', ['tsx', 'apps/api/src/server.ts'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    QUERYNX_API_KEYS: KEY,
    LOG_LEVEL: 'error',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

server.stdout!.on('data', () => {});
server.stderr!.on('data', (chunk: Buffer) => {
  const text = chunk.toString();
  if (text.includes('EADDRINUSE')) {
    console.error(`[smoke] port ${PORT} in use`);
    process.exit(1);
  }
});

const cleanup = (code: number) => {
  server.kill('SIGTERM');
  process.exit(code);
};
process.on('SIGINT', () => cleanup(1));
process.on('SIGTERM', () => cleanup(1));

// Wait for boot.
let booted = false;
for (let i = 0; i < 40; i++) {
  try {
    await fetch(`${BASE}/health`);
    booted = true;
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 250));
  }
}
if (!booted) {
  console.error('[smoke] server did not boot within 10s');
  cleanup(1);
}

let failed = 0;
for (const check of checks) {
  try {
    await check.fn();
    console.log(`[smoke] PASS ${check.name}`);
  } catch (err) {
    console.error(`[smoke] FAIL ${check.name}: ${err instanceof Error ? err.message : err}`);
    failed++;
  }
}

console.log('');
if (failed > 0) {
  console.error(`[smoke] ${failed} check(s) failed`);
  cleanup(1);
}
console.log('[smoke] all checks passed');
cleanup(0);
