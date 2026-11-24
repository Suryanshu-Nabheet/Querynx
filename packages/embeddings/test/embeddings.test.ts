import { describe, expect, it } from 'vitest';
import {
  HashEmbedder,
  createEmbedder,
  cosineSimilarity,
  embeddingFingerprint,
} from '../src/index.js';

describe('HashEmbedder', () => {
  it('produces deterministic unit-norm vectors', async () => {
    const e = new HashEmbedder(64);
    const a = await e.embed('postgresql database');
    const b = await e.embed('postgresql database');
    expect(a).toEqual(b);
    expect(a).toHaveLength(64);
    const norm = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('gives similar texts higher similarity than different texts', async () => {
    const e = new HashEmbedder(256);
    const q = await e.embed('postgres mvcc concurrency control');
    const near = await e.embed('postgres mvcc concurrency');
    const far = await e.embed('cooking pasta with tomato sauce');
    expect(cosineSimilarity(q, near)).toBeGreaterThan(cosineSimilarity(q, far));
  });

  it('handles empty input as zero vector', async () => {
    const e = new HashEmbedder(32);
    const v = await e.embed('');
    expect(v.every((x) => x === 0)).toBe(true);
  });

  it('rejects invalid dimensions', () => {
    expect(() => new HashEmbedder(4)).toThrow();
    expect(() => new HashEmbedder(384.5)).toThrow();
  });
});

describe('createEmbedder', () => {
  it('returns the hash embedder without configuration', () => {
    const e = createEmbedder({});
    expect(e).toBeInstanceOf(HashEmbedder);
    expect(e.dimensions).toBe(384);
  });

  it('returns the API embedder when configured', () => {
    const e = createEmbedder({
      baseUrl: 'http://localhost:11434',
      model: 'nomic-embed-text',
      dimensions: 768,
    });
    expect(e.dimensions).toBe(768);
    expect(e).not.toBeInstanceOf(HashEmbedder);
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for identical, 0 for orthogonal', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe('embeddingFingerprint', () => {
  it('is stable and compact', async () => {
    const e = new HashEmbedder(16);
    const v = await e.embed('x');
    expect(embeddingFingerprint(v)).toBe(embeddingFingerprint(v));
    expect(embeddingFingerprint(v)).toHaveLength(32);
  });
});
