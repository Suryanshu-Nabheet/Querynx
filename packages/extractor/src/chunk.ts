/**
 * Semantic, heading-aware document chunking for indexing and RAG.
 *
 * Documents are split into passages that respect heading boundaries,
 * then packed to a token budget with a sliding overlap. Chunking is
 * deterministic and needs no model.
 */

import type { DocumentSection } from '@querynx/types';

/** Rough token estimate: ~4 characters per token for English text. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface Chunk {
  /** Chunk text. */
  text: string;
  /** Estimated token count. */
  tokens: number;
  /** Section title the chunk belongs to. */
  sectionTitle?: string;
  /** Character offsets [start, end) in the source document text. */
  offsets: readonly [number, number];
}

export interface ChunkOptions {
  /** Maximum tokens per chunk. */
  maxTokens: number;
  /** Token overlap between consecutive chunks. */
  overlapTokens?: number;
  /** Maximum number of chunks per document (protects the indexer). */
  maxChunks?: number;
}

const DEFAULT_MAX_CHUNKS = 500;

/**
 * Split text into sentence-ish segments without heavy NLP: split on
 * sentence terminators followed by whitespace, falling back to
 * paragraph and word boundaries.
 */
function splitSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const sentences = normalized.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/);
  return sentences.filter((s) => s.length > 0);
}

/**
 * Chunk a document by packing sentences up to the token budget,
 * keeping heading context in each chunk's metadata.
 */
export function chunkText(
  text: string,
  sectionTitle: string | undefined,
  options: ChunkOptions
): Chunk[] {
  const { maxTokens, overlapTokens = 0, maxChunks = DEFAULT_MAX_CHUNKS } = options;
  const sentences = splitSentences(text);
  const chunks: Chunk[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  let start = 0;

  const flush = (endOffset: number) => {
    if (current.length === 0) return;
    const chunkTextJoined = current.join(' ');
    chunks.push({
      text: chunkTextJoined,
      tokens: currentTokens,
      sectionTitle,
      offsets: [start, endOffset],
    });
    if (chunks.length >= maxChunks) return;
    // Overlap: keep trailing sentences up to overlapTokens.
    if (overlapTokens > 0) {
      const overlap: string[] = [];
      let overlapTok = 0;
      for (let i = current.length - 1; i >= 0; i--) {
        const s = current[i]!;
        const t = estimateTokens(s);
        if (overlapTok + t > overlapTokens && overlap.length > 0) break;
        overlap.unshift(s);
        overlapTok += t;
      }
      current = overlap;
      currentTokens = overlapTok;
      start = endOffset - overlap.join(' ').length;
    } else {
      current = [];
      currentTokens = 0;
      start = endOffset;
    }
  };

  let cursor = 0;
  for (const sentence of sentences) {
    const tokens = estimateTokens(sentence);
    if (currentTokens + tokens > maxTokens && current.length > 0) {
      cursor += current.join(' ').length + 1;
      flush(cursor - 1);
      if (chunks.length >= maxChunks) return chunks;
    }
    if (current.length === 0) start = cursor;
    current.push(sentence);
    currentTokens += tokens;
    cursor += sentence.length + 1;
    // A single sentence larger than the budget is emitted as its own chunk.
    if (tokens >= maxTokens) {
      flush(cursor);
      if (chunks.length >= maxChunks) return chunks;
    }
  }
  flush(cursor);
  return chunks;
}

/**
 * Heading-aware chunking: chunk each section independently so every
 * chunk carries its heading context for retrieval.
 */
export function chunkSections(
  sections: readonly DocumentSection[],
  options: ChunkOptions
): Chunk[] {
  const all: Chunk[] = [];
  for (const section of sections) {
    if (!section.content.trim()) continue;
    const chunks = chunkText(section.content, section.title, options);
    for (const chunk of chunks) {
      if (all.length >= (options.maxChunks ?? DEFAULT_MAX_CHUNKS)) return all;
      all.push(chunk);
    }
  }
  return all;
}
