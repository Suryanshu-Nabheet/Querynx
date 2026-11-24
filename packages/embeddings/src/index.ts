/**
 * Embedding providers.
 *
 * Two implementations behind one interface:
 *
 *  1. HashEmbedder — deterministic, dependency-free, offline. Uses the
 *     hashing trick over token n-grams (bag-of-words projected by
 *     signed hashing). Not semantically deep, but stable, fast and
 *     enough to activate hybrid retrieval with zero infrastructure.
 *
 *  2. OpenAICompatibleEmbedder — calls an /v1/embeddings endpoint
 *     (OpenAI, Ollama, vLLM, LM Studio, anything speaking the
     * protocol) when the operator configures one.
 */

import { createHash } from 'node:crypto';
import { fetchUrl } from '@querynx/fetcher';

export interface Embedder {
  readonly dimensions: number;
  embed(text: string): Promise<readonly number[]>;
}

/** Tokenize for hashing: lowercase alphanumeric runs. */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/** Signed 32-bit FNV-1a. */
function fnv32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Hashing-trick embedder: each token and bigram increments its hashed
 * bucket with a sign from a second hash. Deterministic across runs and
 * machines; cosine similarity approximates lexical overlap.
 */
export class HashEmbedder implements Embedder {
  readonly dimensions: number;

  constructor(dimensions = 384) {
    if (dimensions < 8 || !Number.isInteger(dimensions)) {
      throw new Error('dimensions must be an integer >= 8');
    }
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<readonly number[]> {
    const vec = new Float64Array(this.dimensions);
    const toks = tokens(text);
    for (const token of toks) {
      this.addFeature(vec, token, 1);
    }
    for (let i = 0; i + 1 < toks.length; i++) {
      this.addFeature(vec, `${toks[i]}_${toks[i + 1]}`, 0.5);
    }
    // L2 normalize so cosine similarity is a dot product.
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < vec.length; i++) {
        vec[i] = (vec[i] ?? 0) / norm;
      }
    }
    return Array.from(vec);
  }

  private addFeature(vec: Float64Array, feature: string, weight: number): void {
    const h1 = fnv32(feature);
    const bucket = h1 % vec.length;
    const sign = (fnv32(`${feature}:sign`) & 1) === 0 ? 1 : -1;
    vec[bucket] = (vec[bucket] ?? 0) + sign * weight;
  }
}

/** OpenAI-compatible /v1/embeddings client. */
export class OpenAICompatibleEmbedder implements Embedder {
  readonly dimensions: number;

  constructor(
    private readonly config: {
      baseUrl: string;
      apiKey?: string;
      model: string;
      dimensions?: number;
      timeoutMs?: number;
    }
  ) {
    this.dimensions = config.dimensions ?? 1536;
  }

  async embed(text: string): Promise<readonly number[]> {
    const response = await fetchUrl(`${this.config.baseUrl}/v1/embeddings`, {
      timeoutMs: this.config.timeoutMs ?? 15_000,
      maxBytes: 1024 * 1024,
      headers: {
        'content-type': 'application/json',
        ...(this.config.apiKey
          ? { authorization: `Bearer ${this.config.apiKey}` }
          : {}),
      },
    });
    if (response.statusCode !== 200) {
      throw new Error(`embeddings API returned HTTP ${response.statusCode}`);
    }
    const parsed = JSON.parse(response.body) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const embedding = parsed.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new Error('embeddings API returned no embedding');
    }
    return embedding;
  }
}

/** Provider selection: API embedder when configured, hash otherwise. */
export function createEmbedder(config: {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  dimensions?: number;
}): Embedder {
  if (config.baseUrl && config.model) {
    return new OpenAICompatibleEmbedder({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      dimensions: config.dimensions,
    });
  }
  return new HashEmbedder(config.dimensions ?? 384);
}

/** Cosine similarity between two vectors. */
export function cosineSimilarity(
  a: readonly number[],
  b: readonly number[]
): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Stable fingerprint helper reused by semantic cache keys. */
export function embeddingFingerprint(vector: readonly number[]): string {
  const joined = vector.map((v) => v.toFixed(6)).join(',');
  return createHash('sha256').update(joined).digest('hex').slice(0, 32);
}
