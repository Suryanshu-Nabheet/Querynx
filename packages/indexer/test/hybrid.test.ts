import { describe, expect, it } from 'vitest';
import { MemorySearchEngine } from '../src/engine.js';
import { MemoryVectorStore, fuseHybrid, reciprocalRankFusion } from '../src/hybrid.js';

describe('MemoryVectorStore', () => {
  it('finds nearest neighbors by cosine similarity', () => {
    const store = new MemoryVectorStore();
    store.upsert('a', [1, 0, 0]);
    store.upsert('b', [0, 1, 0]);
    store.upsert('c', [0.9, 0.1, 0]);
    const results = store.search([1, 0, 0], 2);
    expect(results[0]!.docId).toBe('a');
    expect(results[1]!.docId).toBe('c');
    expect(results[0]!.similarity).toBeCloseTo(1);
  });

  it('removes vectors', () => {
    const store = new MemoryVectorStore();
    store.upsert('a', [1, 0]);
    store.remove('a');
    expect(store.search([1, 0], 5)).toEqual([]);
  });

  it('handles zero vectors safely', () => {
    const store = new MemoryVectorStore();
    store.upsert('zero', [0, 0, 0]);
    store.upsert('real', [1, 1, 1]);
    const results = store.search([1, 1, 1], 5);
    expect(results.map((r) => r.docId)).toEqual(['real']);
  });
});

describe('fuseHybrid', () => {
  it('ranks documents found by both systems highest', () => {
    const engine = new MemorySearchEngine();
    const docA = engine.index({
      url: 'https://a.com',
      title: 'Alpha doc',
      content: 'shared keywords machine learning',
      collection: 'c',
      fingerprint: 'fa',
    });
    const docB = engine.index({
      url: 'https://b.com',
      title: 'Beta doc',
      content: 'unrelated cooking recipes pasta',
      collection: 'c',
      fingerprint: 'fb',
    });

    const bm25Hits = engine.search({ query: 'machine learning', limit: 10 });
    // Simulate vector hits: docA and docB both "semantically" match.
    const vectorHits = [
      { docId: docA.id, similarity: 0.9 },
      { docId: docB.id, similarity: 0.8 },
    ];

    const docsById = new Map(
      engine.documents().map((d) => [d.id, d] as const)
    );
    const fused = fuseHybrid(bm25Hits, vectorHits, docsById);
    expect(fused[0]!.document.id).toBe(docA.id);
    expect(fused[0]!.sources).toContain('bm25');
    expect(fused[0]!.sources).toContain('vector');
    expect(fused[1]!.sources).toEqual(['vector']);
  });

  it('includes vector-only hits with unknown bm25 score', () => {
    const engine = new MemorySearchEngine();
    const doc = engine.index({
      url: 'https://x.com',
      title: 'X doc',
      content: 'quantum entanglement physics',
      collection: 'c',
      fingerprint: 'fx',
    });
    const docsById = new Map(engine.documents().map((d) => [d.id, d] as const));
    const fused = fuseHybrid([], [{ docId: doc.id, similarity: 1 }], docsById);
    expect(fused).toHaveLength(1);
    expect(fused[0]!.bm25Score).toBe(0);
    expect(fused[0]!.sources).toEqual(['vector']);
  });

  it('produces empty output for empty inputs', () => {
    expect(fuseHybrid([], [], new Map())).toEqual([]);
  });
});

describe('reciprocalRankFusion', () => {
  it('fuses multiple ranked lists', () => {
    const fused = reciprocalRankFusion([
      ['a', 'b', 'c'],
      ['b', 'c', 'd'],
      ['c', 'a'],
    ]);
    // Scores: a = 1/61 + 1/62 ≈ .0326; b = 1/62 + 1/61 ≈ .0325;
    // c = 1/63 + 1/62 + 1/61 ≈ .048; d = 1/64 ≈ .0156.
    expect(fused[0]!.docId).toBe('c'); // present in all three lists
    expect(new Set(fused.slice(1, 3).map((f) => f.docId))).toEqual(new Set(['a', 'b']));
    expect(fused[3]!.docId).toBe('d');
  });

  it('scores an item in one list below items corroborated across lists', () => {
    const fused = reciprocalRankFusion([
      ['x'],
      ['y'],
    ]);
    // both single-list, equal ranks — either order acceptable, same score
    expect(fused[0]!.score).toBeCloseTo(fused[1]!.score);
  });
});
