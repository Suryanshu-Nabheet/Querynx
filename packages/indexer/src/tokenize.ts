/**
 * Text tokenization for full-text indexing.
 *
 * Simple, deterministic, dependency-free: lowercase, strip punctuation,
 * split on non-alphanumeric runs, drop stopwords and 1-character tokens.
 * Stemming is deliberately skipped — BM25 tolerates morphological
 * variants well enough and the simpler pipeline stays debuggable.
 */

/** Minimal English stopword set. Kept small: aggressive stopword lists
 * harm technical queries ("c", "r", "go" are real terms). */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for',
  'if', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'that',
  'the', 'their', 'then', 'there', 'these', 'this', 'to', 'was',
  'were', 'will', 'with', 'what', 'when', 'where', 'who', 'why', 'how',
]);

/** Split text into indexable tokens. */
export function tokenize(text: string): string[] {
  const normalized = text
    .toLowerCase()
    // Underscores are identifier characters (foo_bar); all other
    // punctuation splits tokens.
    .replace(/[^\p{L}\p{N}_\s]/gu, ' ')
    .replace(/[_\s]+/g, (match) => (match.includes(' ') ? ' ' : '_'))
    .trim();

  if (!normalized) return [];

  return normalized
    .split(' ')
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

/** Build a term-frequency map from a token list. */
export function termFrequencies(tokens: readonly string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }
  return tf;
}
