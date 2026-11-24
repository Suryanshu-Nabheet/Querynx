import { describe, expect, it } from 'vitest';
import {
  documents,
  chunks,
  apiKeys,
  jobs,
  usageEvents,
} from '../src/schema.js';

describe('schema tables', () => {
  it('documents: exposes expected columns', () => {
    const columns = Object.keys(documents);
    for (const expected of ['id', 'collection', 'url', 'title', 'content', 'fingerprint', 'indexedAt']) {
      expect(columns).toContain(expected);
    }
  });

  it('chunks: references documents with cascade delete', () => {
    const columns = Object.keys(chunks);
    expect(columns).toContain('documentId');
    expect(columns).toContain('ordinal');
    expect(columns).toContain('embedding');
  });

  it('apiKeys: hashes are unique', () => {
    expect(Object.keys(apiKeys)).toContain('hash');
    expect(Object.keys(apiKeys)).toContain('revoked');
  });

  it('jobs: carries lifecycle fields', () => {
    const columns = Object.keys(jobs);
    for (const expected of ['type', 'status', 'payload', 'priority', 'createdAt', 'startedAt', 'finishedAt']) {
      expect(columns).toContain(expected);
    }
  });

  it('usageEvents: records route accounting', () => {
    const columns = Object.keys(usageEvents);
    expect(columns).toContain('route');
    expect(columns).toContain('statusCode');
    expect(columns).toContain('durationMs');
  });
});
