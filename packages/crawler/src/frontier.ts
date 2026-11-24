/**
 * Crawl frontier: URL discovery, dedupe, depth tracking and strategy-based
 * ordering, with per-domain throttling and a global concurrency budget.
 */

import type { CrawlStrategy } from '@querynx/types';
import { extractDomain, canonicalizeUrl } from '@querynx/shared';

export interface FrontierEntry {
  url: string;
  depth: number;
  /** Priority score for priority strategy; higher = sooner. */
  priority: number;
}

/** Result of frontier.take(): either work, or a cooldown hint. */
export type TakeResult =
  | { kind: 'entry'; entry: FrontierEntry }
  | { kind: 'cooldown'; retryAfterMs: number }
  | { kind: 'empty' };

/**
 * URL frontier with:
 * - canonical dedupe (never enqueues the same URL twice)
 * - depth cap
 * - domain allowlist
 * - strategy ordering (BFS by depth, DFS, priority)
 * - per-domain pacing (earliest next-allowed fetch time)
 */
export class CrawlFrontier {
  private readonly seen = new Set<string>();
  private readonly queue: FrontierEntry[] = [];
  private readonly domainNextAllowed = new Map<string, number>();
  private urlsSeen = 0;

  constructor(
    private readonly maxDepth: number,
    private readonly maxPages: number,
    private readonly allowedDomains: ReadonlySet<string> | null,
    private readonly strategy: CrawlStrategy = 'breadth-first'
  ) {}

  /** Whether any more URLs may be accepted (page budget consumed). */
  get isFull(): boolean {
    return this.seen.size >= this.maxPages;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  get seenCount(): number {
    return this.seen.size;
  }

  /** Add a seed or discovered URL. Returns true when enqueued. */
  add(rawUrl: string, depth: number, priority = 0): boolean {
    if (depth > this.maxDepth) return false;
    if (this.isFull) return false;
    const url = canonicalizeUrl(rawUrl);
    if (!url) return false;

    const domain = extractDomain(url);
    if (this.allowedDomains && !this.allowedDomains.has(domain)) return false;

    const key = url;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.urlsSeen++;

    const entry: FrontierEntry = { url, depth, priority };
    this.insert(entry);
    return true;
  }

  private insert(entry: FrontierEntry): void {
    if (this.strategy === 'depth-first') {
      this.queue.push(entry); // take() pops from the end — DFS
      return;
    }
    if (this.strategy === 'priority') {
      // Sorted insert: highest priority first, then shallowest.
      let index = this.queue.length;
      while (
        index > 0 &&
        (this.queue[index - 1]!.priority < entry.priority ||
          (this.queue[index - 1]!.priority === entry.priority &&
            this.queue[index - 1]!.depth > entry.depth))
      ) {
        index--;
      }
      this.queue.splice(index, 0, entry);
      return;
    }
    // Breadth-first: sorted by depth (ascending), stable within a depth.
    let index = this.queue.length;
    while (index > 0 && this.queue[index - 1]!.depth > entry.depth) {
      index--;
    }
    this.queue.splice(index, 0, entry);
  }

  /**
   * Take the next URL whose domain is within its pacing budget.
   * Returns 'cooldown' when queued entries exist but all their domains
   * are cooling down; 'empty' when nothing remains.
   */
  take(now: number): TakeResult {
    const scanFrom = (start: number, step: number): TakeResult => {
      for (let i = start; step > 0 ? i < this.queue.length : i >= 0; i += step) {
        const entry = this.queue[i]!;
        const domain = extractDomain(entry.url);
        const nextAllowed = this.domainNextAllowed.get(domain) ?? 0;
        if (nextAllowed <= now) {
          this.queue.splice(i, 1);
          return { kind: 'entry', entry };
        }
      }
      if (this.queue.length === 0) return { kind: 'empty' };
      return { kind: 'cooldown', retryAfterMs: this.soonestDomainRetry(now) };
    };

    // DFS scans from the newest end; BFS/priority scan from the front.
    return this.strategy === 'depth-first'
      ? scanFrom(this.queue.length - 1, -1)
      : scanFrom(0, 1);
  }

  private soonestDomainRetry(now: number): number {
    const queuedDomains = new Set(this.queue.map((e) => extractDomain(e.url)));
    let soonest = Number.POSITIVE_INFINITY;
    for (const domain of queuedDomains) {
      const nextAllowed = this.domainNextAllowed.get(domain) ?? 0;
      if (nextAllowed > now) soonest = Math.min(soonest, nextAllowed - now);
    }
    return Number.isFinite(soonest) ? Math.max(soonest, 1) : 100;
  }

  /** Register a fetch for a domain, delaying its next slot. */
  throttle(domain: string, delayMs: number): void {
    const current = this.domainNextAllowed.get(domain) ?? 0;
    const now = Date.now();
    const next = Math.max(current, now) + delayMs;
    this.domainNextAllowed.set(domain, next);
  }

  /** Export state for persistence/resume. */
  serialize(): { seen: string[]; queue: FrontierEntry[] } {
    return { seen: [...this.seen], queue: [...this.queue] };
  }

  /** Restore previously serialized state. */
  static deserialize(
    data: { seen: string[]; queue: FrontierEntry[] },
    maxDepth: number,
    maxPages: number,
    allowedDomains: ReadonlySet<string> | null,
    strategy: CrawlStrategy
  ): CrawlFrontier {
    const frontier = new CrawlFrontier(maxDepth, maxPages, allowedDomains, strategy);
    for (const url of data.seen) frontier.seen.add(url);
    frontier.urlsSeen = data.seen.length;
    for (const entry of data.queue) frontier.queue.push(entry);
    return frontier;
  }
}
