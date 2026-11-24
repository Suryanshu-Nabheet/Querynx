import { describe, expect, it } from 'vitest';
import {
  canonicalDedupeKey,
  fingerprintSimilarity,
  fingerprintText,
} from '../src/fingerprint.js';

describe('fingerprintText', () => {
  it('is deterministic', () => {
    expect(fingerprintText('Hello world, this is a test document.')).toBe(
      fingerprintText('Hello world, this is a test document.')
    );
  });

  it('ignores case, punctuation and whitespace differences', () => {
    const a = fingerprintText('The quick brown fox jumps over the lazy dog.');
    const b = fingerprintText('the QUICK   brown fox\njumps over the  LAZY dog!');
    expect(fingerprintSimilarity(a, b)).toBe(1);
  });

  it('distinguishes different documents', () => {
    const a = fingerprintText(
      'PostgreSQL uses a multi-version concurrency control model. WAL records changes before commit.'
    );
    const b = fingerprintText(
      'Redis is an in-memory data structure store used as a database cache and message broker.'
    );
    expect(fingerprintSimilarity(a, b)).toBeLessThan(0.5);
  });

  it('handles empty input', () => {
    expect(fingerprintText('')).toHaveLength(512);
  });
});

describe('fingerprintSimilarity', () => {
  it('returns 1 for identical fingerprints', () => {
    const f = fingerprintText('some content here entirely unique');
    expect(fingerprintSimilarity(f, f)).toBe(1);
  });

  it('returns 0 for different lengths', () => {
    expect(fingerprintSimilarity('abc', 'abcd')).toBe(0);
  });
});

describe('canonicalDedupeKey', () => {
  it('strips fragments and tracking params', () => {
    expect(canonicalDedupeKey('https://example.com/a?utm_source=x&p=2#sec')).toBe(
      'example.com/a?p=2'
    );
  });

  it('collapses trailing slashes', () => {
    expect(canonicalDedupeKey('https://www.example.com/a/')).toBe('example.com/a');
  });

  it('lowercases host but preserves case-sensitive path, strips www', () => {
    // Path case is significant on real HTTP servers, so dedupe keys keep it.
    expect(canonicalDedupeKey('HTTPS://EXAMPLE.COM/X')).toBe('example.com/X');
    expect(canonicalDedupeKey('https://www.example.com/x')).toBe('example.com/x');
  });

  it('falls back to raw input for invalid URLs', () => {
    expect(canonicalDedupeKey('not a url')).toBe('not a url');
  });
});
