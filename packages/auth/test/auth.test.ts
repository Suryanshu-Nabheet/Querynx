import { describe, expect, it } from 'vitest';
import { ApiKeyStore, hashApiKey } from '../src/index.js';

describe('ApiKeyStore', () => {
  it('issues keys that verify', () => {
    const store = new ApiKeyStore();
    const { key, record } = store.issue('test-key');
    expect(key).toMatch(/^qnx_[A-Za-z0-9_-]+$/);
    expect(store.verify(key)?.hash).toBe(record.hash);
    expect(store.verify(key)?.label).toBe('test-key');
  });

  it('never stores plaintext', () => {
    const store = new ApiKeyStore();
    const { key } = store.issue('x');
    const stored = JSON.stringify(store.list());
    expect(stored).not.toContain(key);
    expect(hashApiKey(key)).toHaveLength(64); // sha-256 hex
  });

  it('rejects unknown and revoked keys', () => {
    const store = new ApiKeyStore();
    expect(store.verify('qnx_bogus')).toBeNull();
    const { key, record } = store.issue('doomed');
    store.revoke(record.hash);
    expect(store.verify(key)).toBeNull();
  });

  it('issues unique keys', () => {
    const store = new ApiKeyStore();
    const a = store.issue('a');
    const b = store.issue('b');
    expect(a.key).not.toBe(b.key);
    expect(a.record.hash).not.toBe(b.record.hash);
  });

  it('verifies against external hashes in constant time', () => {
    const store = new ApiKeyStore();
    const { key, record } = store.issue('ext');
    expect(store.verifyAgainstHash(key, record.hash)).toBe(true);
    expect(store.verifyAgainstHash(key + 'x', record.hash)).toBe(false);
    expect(store.verifyAgainstHash(key, 'deadbeef')).toBe(false);
  });

  it('loads records from persistence and keeps revocations', () => {
    const store = new ApiKeyStore();
    const { key, record } = store.issue('persisted');
    const restored = new ApiKeyStore();
    restored.load([record]);
    expect(restored.verify(key)?.label).toBe('persisted');
    restored.revoke(record.hash);
    expect(restored.verify(key)).toBeNull();
  });

  it('carries per-key rate limits', () => {
    const store = new ApiKeyStore();
    const { record } = store.issue('limited', 10);
    expect(record.rateLimitPerMinute).toBe(10);
  });
});
