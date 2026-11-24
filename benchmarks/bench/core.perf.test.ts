/**
 * Performance benchmarks for the core hot paths.
 *
 * These are functional perf tests (measured, asserted against generous
 * regression ceilings) — they run in CI and document real numbers in
 * docs/BENCHMARKS.md. Each benchmark:
 *   1. builds a deterministic corpus,
 *   2. warms up,
 *   3. measures P50/P95/P99 over N iterations,
 *   4. asserts a ceiling so perf regressions fail loudly.
 */

import { describe, expect, it } from 'vitest';
import { MemorySearchEngine } from '@querynx/indexer';
import { TTLCache, searchCacheKey } from '@querynx/cache';
import { extractDocument } from '@querynx/extractor';
import { SearchOrchestrator } from '@querynx/providers';
import { fingerprintText, canonicalizeUrl, mapWithConcurrency } from '@querynx/shared';
import type { SearchProvider, SearchResult } from '@querynx/types';
import { randomBytes } from 'node:crypto';

/** Percentile helper (linear interpolation). */
function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return lo === hi ? sorted[lo]! : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo);
}

/** Measure a sync operation across N runs, returning percentiles in ms. */
function benchSync(name: string, fn: () => void, iterations: number) {
  // Warmup.
  for (let i = 0; i < Math.max(10, Math.floor(iterations / 10)); i++) fn();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return {
    name,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    iterations,
  };
}

/** Deterministic pseudo-corpus generator. */
function makeCorpus(size: number): string {
  const topics = ['postgres', 'redis', 'nginx', 'sqlite', 'kubernetes', 'docker', 'rust', 'zig', 'fastify', 'undici'];
  const parts: string[] = [];
  for (let i = 0; i < size; i++) {
    const topic = topics[i % topics.length]!;
    parts.push(`${topic} document ${i} explains ${topic} internals in depth with examples and benchmarks`);
  }
  return parts.join(' ');
}

describe('benchmarks', () => {
  it('BM25 indexing throughput', () => {
    const engine = new MemorySearchEngine();
    const docs = Array.from({ length: 500 }, (_, i) => ({
      url: `https://bench.example/doc${i}`,
      title: `Doc ${i}`,
      content: makeCorpus(60),
      collection: 'bench',
      fingerprint: `fp${i}`,
    }));
    const result = benchSync('index-500-docs', () => {
      const fresh = new MemorySearchEngine();
      for (const d of docs) fresh.index({ ...d, id: d.url });
    }, 3);
    console.log(`[bench] ${result.name}: p50=${result.p50.toFixed(1)}ms`);
    // Ceiling: indexing 500 docs of 60 sentences each under 5s.
    expect(result.p50).toBeLessThan(5_000);
  });

  it('BM25 query latency P95 over a 2000-doc corpus', () => {
    const engine = new MemorySearchEngine();
    for (let i = 0; i < 2000; i++) {
      engine.index({
        url: `https://bench.example/doc${i}`,
        title: `Doc ${i}`,
        content: makeCorpus(30),
        collection: 'bench',
        fingerprint: `fp${i}`,
        id: `id${i}`,
      });
    }
    const queries = ['postgres internals', 'redis benchmarks', 'kubernetes examples', 'zig depth', 'fastify undici'];
    const samples: number[] = [];
    for (let i = 0; i < 300; i++) {
      const t0 = performance.now();
      engine.search({ query: queries[i % queries.length]!, limit: 10 });
      samples.push(performance.now() - t0);
    }
    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);
    console.log(`[bench] bm25-query-2000-docs: p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms`);
    // Ceilings: interactive query latency.
    expect(p50).toBeLessThan(25);
    expect(p95).toBeLessThan(80);
  });

  it('fingerprint throughput', () => {
    const text = makeCorpus(100);
    const result = benchSync('fingerprint-100-sentences', () => fingerprintText(text), 200);
    console.log(`[bench] ${result.name}: p50=${result.p50.toFixed(2)}ms`);
    expect(result.p50).toBeLessThan(5);
  });

  it('URL canonicalization latency', () => {
    const urls = Array.from({ length: 100 }, (_, i) =>
      `https://Sub${i % 7}.Example.COM:443/path${i}/?utm_source=x&id=${i}#frag`
    );
    const result = benchSync('canonicalize-100-urls', () => {
      for (const u of urls) canonicalizeUrl(u);
    }, 100);
    console.log(`[bench] ${result.name}: p50=${result.p50.toFixed(2)}ms`);
    // Ceiling: CI runners measure ~3-5ms after the userinfo-stripping
    // security fix; the regression budget is 4x that, catching
    // algorithmic regressions without flaking on runner variance.
    expect(result.p50).toBeLessThan(20);
  });

  it('cache get/set + stampede prevention under concurrency', async () => {
    const cache = new TTLCache<string>(60_000, 10_000);
    const key = searchCacheKey({ query: 'bench', maxResults: 10 });
    let computes = 0;
    const t0 = performance.now();
    // 100 concurrent identical lookups must coalesce into ~1 compute.
    await Promise.all(
      Array.from({ length: 100 }, () =>
        cache.getOrCompute(key, async () => {
          computes++;
          await new Promise((r) => setTimeout(r, 10));
          return 'value';
        })
      )
    );
    const elapsed = performance.now() - t0;
    console.log(`[bench] cache-stampede-100: ${computes} computes in ${elapsed.toFixed(1)}ms`);
    expect(computes).toBe(1);
    expect(elapsed).toBeLessThan(1_000);
  });

  it('extraction latency on a realistic page', () => {
    const html = `<!DOCTYPE html><html><head><title>Bench page</title></head><body>
      <nav>${'<a href="/x">nav</a>'.repeat(50)}</nav>
      <article><h1>Heading</h1>${'<p>Paragraph with technical content about systems and databases.</p>'.repeat(150)}</article>
    </body></html>`;
    const result = benchSync('extract-realistic-page', () => {
      extractDocument(html, 'https://bench.example/page', 200);
    }, 20);
    console.log(`[bench] ${result.name}: p50=${result.p50.toFixed(1)}ms`);
    expect(result.p50).toBeLessThan(500);
  });

  it('federated merge latency with 3 providers x 20 results', async () => {
    const makeProvider = (id: string): SearchProvider => ({
      name: `p${id}`,
      isConfigured: () => true,
      search: async (): Promise<SearchResult[]> =>
        Array.from({ length: 20 }, (_, i) => ({
          title: `Result ${i} ${randomBytes(4).toString('hex')}`,
          url: `https://p${id}.example/r${i}`,
          snippet: 'snippet content for benchmarking merge',
          score: Math.random(),
          provider: `p${id}`,
        })),
    });
    const orchestrator = new SearchOrchestrator(
      [makeProvider('1'), makeProvider('2'), makeProvider('3')],
      { maxProviderConcurrency: 3 }
    );
    // Warmup + measure.
    const samples: number[] = [];
    for (let i = 0; i < 30; i++) {
      const t0 = performance.now();
      await orchestrator.search({ query: 'bench query', maxResults: 20 });
      samples.push(performance.now() - t0);
    }
    const p50 = percentile(samples, 50);
    console.log(`[bench] federated-merge: p50=${p50.toFixed(2)}ms`);
    expect(p50).toBeLessThan(150);
  });

  it('bounded concurrency honors limits under load', async () => {
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 200 }, (_, i) => i);
    const t0 = performance.now();
    await mapWithConcurrency(items, 16, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
    });
    const elapsed = performance.now() - t0;
    console.log(`[bench] bounded-concurrency-200-at-16: peak=${peak} in ${elapsed.toFixed(0)}ms`);
    expect(peak).toBeLessThanOrEqual(16);
    expect(peak).toBe(16);
    // 200 items at 2ms each at 16-wide: ~25ms lower bound; assert sane.
    expect(elapsed).toBeGreaterThanOrEqual(20);
    expect(elapsed).toBeLessThan(5_000);
  });
});
