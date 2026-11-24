/**
 * Web crawling domain types.
 */

import type { ExtractedDocument } from './extract.js';

/** Strategies for frontier ordering. */
export type CrawlStrategy = 'breadth-first' | 'depth-first' | 'priority';

/** A crawl request. */
export interface CrawlRequest {
  /** Starting URLs. */
  seeds: readonly string[];
  /** Maximum link-follow depth from a seed (0 = seeds only). */
  maxDepth: number;
  /** Maximum total pages to crawl. */
  maxPages: number;
  /** Frontier ordering. */
  strategy?: CrawlStrategy;
  /** Restrict crawling to these domains (defaults to seed domains). */
  allowedDomains?: readonly string[];
  /** Follow sitemap.xml entries in addition to page links. */
  followSitemaps?: boolean;
  /** Respect robots.txt (always strongly recommended). */
  respectRobots?: boolean;
  /** Milliseconds between requests to the same domain. */
  perDomainDelayMs?: number;
  /** Overall wall-clock budget. */
  timeoutMs?: number;
  /** Skip URLs whose content fingerprint was already seen. */
  dedupeByContent?: boolean;
}

/** Lifecycle states of a crawl job. */
export type CrawlStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** One discovered page inside a crawl. */
export interface CrawledPage {
  url: string;
  depth: number;
  statusCode: number;
  /** Extracted document, when the page was successfully processed. */
  document?: ExtractedDocument;
  error?: string;
}

/** Live progress snapshot of a running crawl. */
export interface CrawlProgress {
  /** Pages fetched so far. */
  pagesFetched: number;
  /** Pages remaining in the frontier. */
  pagesQueued: number;
  /** URLs discovered (before filtering). */
  urlsSeen: number;
  /** Current depth reached. */
  maxDepthReached: number;
  /** Pages skipped by robots.txt. */
  robotsSkipped: number;
  /** Pages skipped as content duplicates. */
  duplicatesSkipped: number;
  /** Errors so far. */
  errors: number;
}

/** Final report of a completed crawl. */
export interface CrawlReport {
  status: CrawlStatus;
  pages: readonly CrawledPage[];
  progress: CrawlProgress;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}
