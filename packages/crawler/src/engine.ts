/**
 * The crawl engine: drives the frontier with robots compliance,
 * per-domain throttling, bounded concurrency and progress reporting.
 */

import type {
  CrawlRequest,
  CrawlReport,
  CrawlProgress,
  CrawledPage,
} from "@querynx/types";
import { fetchUrl } from "@querynx/fetcher";
import { extractDocument } from "@querynx/extractor";
import {
  extractDomain,
  fingerprintText,
  mapWithConcurrency,
  sleep,
} from "@querynx/shared";
import { getRobotsFor, type RobotsFile } from "./robots.js";
import { CrawlFrontier } from "./frontier.js";
import { fetchSitemapUrls } from "./sitemap.js";

export interface CrawlEngineOptions {
  userAgent?: string;
  /** Hard cap on simultaneous fetches across all domains. */
  maxConcurrency?: number;
  /** Default delay between requests to the same domain. */
  defaultPerDomainDelayMs?: number;
  /** Wall-clock budget. */
  timeoutMs?: number;
  /** Callback per crawled page (for streaming progress). */
  onPage?: (page: CrawledPage) => void;
  /** Cooperative cancellation. */
  signal?: AbortSignal;
}

const DEFAULT_UA =
  "QuerynxBot/0.1 (+https://github.com/Suryanshu-Nabheet/Querynx)";

export class CrawlEngine {
  async crawl(
    request: CrawlRequest,
    options: CrawlEngineOptions = {},
  ): Promise<CrawlReport> {
    const {
      userAgent = DEFAULT_UA,
      maxConcurrency = 4,
      defaultPerDomainDelayMs = 1_000,
      timeoutMs = 5 * 60_000,
      onPage,
      signal,
    } = options;

    const startedAt = new Date().toISOString();
    const deadline = Date.now() + timeoutMs;

    // Allowed domains: explicit list or seed domains.
    const allowedDomains = new Set<string>();
    if (request.allowedDomains && request.allowedDomains.length > 0) {
      for (const d of request.allowedDomains)
        allowedDomains.add(extractDomain(`https://${d}`));
    } else {
      for (const seed of request.seeds) {
        const domain = extractDomain(seed);
        if (domain) allowedDomains.add(domain);
      }
    }

    const frontier = new CrawlFrontier(
      request.maxDepth,
      request.maxPages,
      allowedDomains,
      request.strategy ?? "breadth-first",
    );

    const progress: CrawlProgress = {
      pagesFetched: 0,
      pagesQueued: 0,
      urlsSeen: 0,
      maxDepthReached: 0,
      robotsSkipped: 0,
      duplicatesSkipped: 0,
      errors: 0,
    };

    const pages: CrawledPage[] = [];
    const contentFingerprints = new Set<string>();

    // Seed the frontier.
    for (const seed of request.seeds) frontier.add(seed, 0);

    // Optional sitemap discovery.
    if (request.followSitemaps) {
      const seedDomain = extractDomain(request.seeds[0] ?? "");
      if (seedDomain) {
        try {
          const sitemapUrls = await fetchSitemapUrls(
            `https://${seedDomain}/sitemap.xml`,
            userAgent,
          );
          for (const url of sitemapUrls) {
            if (frontier.isFull) break;
            frontier.add(url, 0);
          }
        } catch {
          // Sitemaps are best-effort.
        }
      }
    }

    const respectRobots = request.respectRobots ?? true;
    const robotsByDomain = new Map<string, Promise<RobotsFile>>();

    const fetchPage = async (): Promise<void> => {
      while (!signal?.aborted && Date.now() < deadline && !frontier.isFull) {
        const take = frontier.take(Date.now());
        if (take.kind === "empty") return;

        // Domain cooling down: sleep and retry.
        if (take.kind === "cooldown") {
          await sleep(Math.min(take.retryAfterMs, 500), signal).catch(() => {});
          continue;
        }

        const { entry } = take;
        const domain = extractDomain(entry.url);
        progress.maxDepthReached = Math.max(
          progress.maxDepthReached,
          entry.depth,
        );

        // robots.txt compliance.
        if (respectRobots) {
          let robotsPromise = robotsByDomain.get(domain);
          if (!robotsPromise) {
            robotsPromise = getRobotsFor(entry.url, userAgent);
            robotsByDomain.set(domain, robotsPromise);
          }
          const robots = await robotsPromise;
          if (!robots.isAllowed(entry.url, userAgent)) {
            progress.robotsSkipped++;
            continue;
          }
          const delay = robots.crawlDelayMs(userAgent);
          if (delay && delay > 0) {
            frontier.throttle(domain, Math.max(delay, defaultPerDomainDelayMs));
          } else {
            frontier.throttle(
              domain,
              request.perDomainDelayMs ?? defaultPerDomainDelayMs,
            );
          }
        } else {
          frontier.throttle(
            domain,
            request.perDomainDelayMs ?? defaultPerDomainDelayMs,
          );
        }

        // Fetch and extract.
        try {
          const fetched = await fetchUrl(entry.url, {
            timeoutMs: 15_000,
            maxBytes: 5 * 1024 * 1024,
            userAgent,
            signal,
          });

          let document: CrawledPage["document"] | undefined;
          if (fetched.statusCode === 200 && !fetched.truncated) {
            const extracted = extractDocument(
              fetched.body,
              fetched.url,
              fetched.statusCode,
            );
            if (request.dedupeByContent !== false) {
              if (contentFingerprints.has(extracted.fingerprint)) {
                progress.duplicatesSkipped++;
                progress.pagesFetched++;
                continue;
              }
              contentFingerprints.add(extracted.fingerprint);
            }
            document = extracted;

            // Discover links for the next depth level.
            if (entry.depth < request.maxDepth) {
              for (const link of extracted.links) {
                if (frontier.isFull) break;
                frontier.add(link.url, entry.depth + 1);
              }
            }
          }

          const page: CrawledPage = {
            url: fetched.url,
            depth: entry.depth,
            statusCode: fetched.statusCode,
            document,
          };
          pages.push(page);
          progress.pagesFetched++;
          onPage?.(page);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const page: CrawledPage = {
            url: entry.url,
            depth: entry.depth,
            statusCode: 0,
            error: message,
          };
          pages.push(page);
          progress.errors++;
          onPage?.(page);
        }
      }
    };

    try {
      const workers = Array.from({ length: maxConcurrency }, () => fetchPage());
      await Promise.all(workers);
    } catch (err) {
      return {
        status: signal?.aborted ? "cancelled" : "failed",
        pages,
        progress: {
          ...progress,
          pagesQueued: frontier.queuedCount,
          urlsSeen: frontier.seenCount,
        },
        startedAt,
        finishedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const cancelled = signal?.aborted === true;
    const timedOut = Date.now() >= deadline;
    const complete = frontier.queuedCount === 0 && !frontier.isFull;

    return {
      status: cancelled
        ? "cancelled"
        : timedOut && !complete
          ? "failed"
          : complete
            ? "completed"
            : "completed",
      pages,
      progress: {
        ...progress,
        pagesQueued: frontier.queuedCount,
        urlsSeen: frontier.seenCount,
      },
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
}
