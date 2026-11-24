import { describe, expect, it } from 'vitest';
import { CrawlFrontier } from '../src/frontier.js';

const domains = new Set(['example.com', 'other.org']);

describe('CrawlFrontier', () => {
  it('enqueues unique URLs only once', () => {
    const f = new CrawlFrontier(2, 10, domains, 'breadth-first');
    expect(f.add('https://example.com/a', 0)).toBe(true);
    expect(f.add('https://example.com/a', 1)).toBe(false); // duplicate
    expect(f.add('https://example.com/a?utm_source=x', 1)).toBe(false); // canonical dup
    expect(f.seenCount).toBe(1);
  });

  it('rejects out-of-scope domains', () => {
    const f = new CrawlFrontier(2, 10, domains, 'breadth-first');
    expect(f.add('https://evil.com/x', 0)).toBe(false);
    expect(f.add('https://example.com/x', 0)).toBe(true);
  });

  it('rejects beyond maxDepth', () => {
    const f = new CrawlFrontier(1, 10, null, 'breadth-first');
    expect(f.add('https://example.com/', 2)).toBe(false);
    expect(f.add('https://example.com/', 1)).toBe(true);
  });

  it('respects maxPages budget', () => {
    const f = new CrawlFrontier(5, 3, null, 'breadth-first');
    f.add('https://example.com/1', 0);
    f.add('https://example.com/2', 0);
    f.add('https://example.com/3', 0);
    expect(f.isFull).toBe(true);
    expect(f.add('https://example.com/4', 0)).toBe(false);
  });

  it('BFS takes shallower entries first', () => {
    const f = new CrawlFrontier(3, 20, null, 'breadth-first');
    f.add('https://example.com/deep', 3, 0);
    f.add('https://example.com/shallow', 0, 0);
    const take = f.take(0)!;
    expect(take.kind).toBe('entry');
    if (take.kind === 'entry') expect(take.entry.url).toContain('shallow');
  });

  it('DFS takes newest entries first', () => {
    const f = new CrawlFrontier(3, 20, null, 'depth-first');
    f.add('https://example.com/first', 0, 0);
    f.add('https://example.com/second', 1, 0);
    const take = f.take(0)!;
    expect(take.kind).toBe('entry');
    if (take.kind === 'entry') expect(take.entry.url).toContain('second');
  });

  it('priority strategy takes highest priority first', () => {
    const f = new CrawlFrontier(3, 20, null, 'priority');
    f.add('https://example.com/low', 0, 1);
    f.add('https://example.com/high', 0, 10);
    f.add('https://example.com/mid', 0, 5);
    const first = f.take(0)!;
    expect(first.kind).toBe('entry');
    if (first.kind === 'entry') expect(first.entry.url).toContain('high');
    const second = f.take(0)!;
    expect(second.kind).toBe('entry');
    if (second.kind === 'entry') expect(second.entry.url).toContain('mid');
    const third = f.take(0)!;
    expect(third.kind).toBe('entry');
    if (third.kind === 'entry') expect(third.entry.url).toContain('low');
  });

  it('throttles domains and reports retry delay', () => {
    const f = new CrawlFrontier(3, 20, null, 'breadth-first');
    f.add('https://example.com/a', 0);
    const first = f.take(0)!;
    expect(first.kind).toBe('entry');
    f.throttle('example.com', 500);
    f.add('https://example.com/b', 0);
    const second = f.take(Date.now())!;
    expect(second.kind).toBe('cooldown');
    if (second.kind === 'cooldown') {
      expect(second.retryAfterMs).toBeGreaterThan(0);
      expect(second.retryAfterMs).toBeLessThanOrEqual(500);
    }
  });

  it('serializes and restores state', () => {
    const f = new CrawlFrontier(3, 20, null, 'breadth-first');
    f.add('https://example.com/a', 0);
    f.add('https://example.com/b', 1);
    f.take(0); // consume 'a'
    const state = f.serialize();

    const restored = CrawlFrontier.deserialize(state, 3, 20, null, 'breadth-first');
    expect(restored.seenCount).toBe(2);
    const take = restored.take(0)!;
    expect(take.kind).toBe('entry');
    if (take.kind === 'entry') expect(take.entry.url).toContain('/b');
    // 'a' must not be re-enqueueable after resume.
    expect(restored.add('https://example.com/a', 0)).toBe(false);
  });
});
