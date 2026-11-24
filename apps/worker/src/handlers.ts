/**
 * Worker job handlers: bind queue job types to crawler/retrieval/
 * research capabilities with full progress accounting.
 */

import type { JobQueue } from "@querynx/queue";
import { CrawlEngine } from "@querynx/crawler";
import { HybridRetrievalEngine } from "@querynx/retrieval";
import type { Embedder } from "@querynx/embeddings";
import { ResearchEngine, type ResearchMode } from "@querynx/research";
import type { SearchOrchestrator } from "@querynx/providers";
import { fetchUrl } from "@querynx/fetcher";
import { extractDocument } from "@querynx/extractor";
import type { CrawlRequest } from "@querynx/types";
import { metrics } from "@querynx/observability";

export interface HandlerDeps {
  queue: JobQueue;
  retrieval: HybridRetrievalEngine;
  embedder: Embedder;
  orchestrator: SearchOrchestrator;
  userAgent: string;
}

/** Register all job handlers on the queue. */
export function registerHandlers(deps: HandlerDeps): void {
  const { queue, retrieval, orchestrator, userAgent } = deps;

  // ---- crawl: run a bounded crawl and ingest every extracted page ----
  queue.handle("crawl", async (payload, signal) => {
    const request = payload as unknown as CrawlRequest & {
      collection?: string;
    };
    if (!Array.isArray(request.seeds) || request.seeds.length === 0) {
      throw new Error("crawl job requires seeds");
    }
    const collection = request.collection ?? "default";

    const engine = new CrawlEngine();
    const report = await engine.crawl(
      {
        seeds: request.seeds,
        maxDepth: request.maxDepth ?? 1,
        maxPages: request.maxPages ?? 25,
        strategy: request.strategy ?? "breadth-first",
        respectRobots: request.respectRobots ?? true,
        perDomainDelayMs: request.perDomainDelayMs ?? 1_000,
        followSitemaps: request.followSitemaps ?? false,
        dedupeByContent: true,
      },
      { userAgent, signal, maxConcurrency: 4 },
    );

    let ingested = 0;
    for (const page of report.pages) {
      if (signal.aborted) break;
      if (!page.document) continue;
      await retrieval.ingest({
        url: page.document.url,
        title: page.document.title ?? page.document.url,
        content: page.document.content,
        collection,
        fingerprint: page.document.fingerprint,
        publishedAt: page.document.metadata?.publishedAt,
        metadata: page.document.metadata as Record<string, unknown> | undefined,
      });
      ingested++;
    }
    metrics.inc("worker_crawl_pages", report.pages.length);
    return {
      status: report.status,
      pagesCrawled: report.pages.length,
      pagesIngested: ingested,
      robotsSkipped: report.progress.robotsSkipped,
      duplicatesSkipped: report.progress.duplicatesSkipped,
    };
  });

  // ---- index: fetch one URL, extract, ingest into the corpus ----
  queue.handle("index", async (payload, signal) => {
    const url = String(payload["url"] ?? "");
    const collection = String(payload["collection"] ?? "default");
    if (!/^https?:\/\//i.test(url))
      throw new Error("index job requires an http(s) url");

    const fetched = await fetchUrl(url, {
      timeoutMs: 20_000,
      maxBytes: 5 * 1024 * 1024,
      signal,
    });
    if (fetched.statusCode !== 200) {
      throw new Error(`fetch returned HTTP ${fetched.statusCode}`);
    }
    const document = extractDocument(
      fetched.body,
      fetched.url,
      fetched.statusCode,
    );
    const stored = await retrieval.ingest({
      url: document.url,
      title: document.title ?? document.url,
      content: document.content,
      collection,
      fingerprint: document.fingerprint,
      publishedAt: document.metadata?.publishedAt,
      metadata: document.metadata as Record<string, unknown> | undefined,
    });
    metrics.inc("worker_index_documents");
    return { id: stored.id, url: stored.url, title: stored.title };
  });

  // ---- research: run a bounded research job asynchronously ----
  queue.handle("research", async (payload, signal) => {
    const objective = String(payload["objective"] ?? "");
    if (objective.length < 3)
      throw new Error("research job requires an objective");
    const mode = (payload["mode"] as ResearchMode | undefined) ?? "standard";

    const engine = new ResearchEngine();
    const report = await engine.research(objective, {
      mode,
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
    metrics.inc("worker_research_runs");
    return {
      findings: report.findings,
      evidenceCount: report.evidence.length,
      usage: report.usage,
      termination: report.termination,
    };
  });
}
