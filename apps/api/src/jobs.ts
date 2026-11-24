/**
 * API-side job handlers: bind the queue's crawl/index/research types
 * to the API's own capabilities. Mirrors the worker service's
 * handlers; the API queue serves single-instance deployments, the
 * worker service serves dedicated fleets.
 */

import type { JobQueue, Job } from "@querynx/queue";
import type { PersistentIndex } from "./persistence.js";
import { fetchUrl } from "@querynx/fetcher";
import { extractDocument } from "@querynx/extractor";
import { CrawlEngine } from "@querynx/crawler";
import { ResearchEngine, type ResearchMode } from "@querynx/research";
import type { SearchOrchestrator } from "@querynx/providers";

export interface ApiJobHandlers {
  queue: JobQueue;
  index: PersistentIndex;
  orchestrator?: SearchOrchestrator;
}

const USER_AGENT =
  "QuerynxBot/0.1 (+https://github.com/Suryanshu-Nabheet/Querynx)";

export function registerApiJobHandlers(deps: ApiJobHandlers): void {
  const { queue, index, orchestrator } = deps;

  queue.handle("index", async (payload, signal) => {
    const url = String(payload["url"] ?? "");
    const collection = String(payload["collection"] ?? "default");
    const fetched = await fetchUrl(url, {
      timeoutMs: 20_000,
      maxBytes: 5 * 1024 * 1024,
      signal,
    });
    if (fetched.statusCode !== 200)
      throw new Error(`HTTP ${fetched.statusCode}`);
    const document = extractDocument(
      fetched.body,
      fetched.url,
      fetched.statusCode,
    );
    const stored = await index.index({
      url: document.url,
      title: document.title ?? document.url,
      content: document.content,
      collection,
      fingerprint: document.fingerprint,
      publishedAt: document.metadata?.publishedAt,
      metadata: document.metadata as Record<string, unknown> | undefined,
    });
    return { id: stored.id, url: stored.url, title: stored.title };
  });

  queue.handle("crawl", async (payload, signal) => {
    const seeds = payload["seeds"] as string[];
    const collection = String(payload["collection"] ?? "default");
    const engine = new CrawlEngine();
    const report = await engine.crawl(
      {
        seeds,
        maxDepth: Number(payload["maxDepth"] ?? 1),
        maxPages: Number(payload["maxPages"] ?? 20),
        respectRobots: true,
        perDomainDelayMs: 1_000,
        dedupeByContent: true,
      },
      { userAgent: USER_AGENT, signal, maxConcurrency: 3 },
    );
    let ingested = 0;
    for (const page of report.pages) {
      if (signal.aborted) break;
      if (!page.document) continue;
      await index.index({
        url: page.document.url,
        title: page.document.title ?? page.document.url,
        content: page.document.content,
        collection,
        fingerprint: page.document.fingerprint,
      });
      ingested++;
    }
    return {
      status: report.status,
      pages: report.pages.length,
      ingested,
      robotsSkipped: report.progress.robotsSkipped,
    };
  });

  queue.handle("research", async (payload, signal) => {
    if (!orchestrator)
      throw new Error("research jobs require search providers");
    const engine = new ResearchEngine();
    const report = await engine.research(String(payload["objective"]), {
      mode: (payload["mode"] as ResearchMode | undefined) ?? "standard",
      search: async (queryText, maxResults) => {
        const r = await orchestrator.search({
          query: queryText,
          maxResults,
          freshness: "any",
          category: "web",
        });
        return r.results;
      },
      extractContent: async (url) => {
        try {
          const fetched = await fetchUrl(url, {
            timeoutMs: 10_000,
            maxBytes: 2 * 1024 * 1024,
            signal,
          });
          if (fetched.statusCode !== 200) return null;
          const doc = extractDocument(
            fetched.body,
            fetched.url,
            fetched.statusCode,
          );
          return {
            title: doc.title ?? url,
            content: doc.content,
            publishedAt: doc.metadata?.publishedAt,
          };
        } catch {
          return null;
        }
      },
      signal,
    });
    return {
      findings: report.findings,
      evidenceCount: report.evidence.length,
      termination: report.termination,
      usage: report.usage,
    };
  });
}

/** Serialize a queue job for API responses (camelCase envelope). */
export function serializeJob(job: Job): Record<string, unknown> {
  const result = (job as Job & { result?: Record<string, unknown> }).result;
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    priority: job.priority,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    error: job.error,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    ...(result ? { result } : {}),
  };
}
