/**
 * Content fingerprinting for duplicate detection.
 *
 * Fingerprints are computed over normalized text using rolling character
 * n-grams hashed to 64-bit values, then folded into a fixed set of buckets.
 * This is a MinHash-style sketch: fast, incremental, and stable across
 * minor whitespace or punctuation edits while still discriminating
 * genuinely different documents.
 *
 * Fingerprints themselves do not reveal content; they are structural hashes.
 */

/** Number of buckets in the sketch. Must be a power of two. */
const SKETCH_BUCKETS = 64;

/** Number of low bits used to pick the bucket. */
const BUCKET_MASK = SKETCH_BUCKETS - 1;

/** Character n-gram size. */
const NGRAM_SIZE = 5;

/** 64-bit FNV-1a constants. */
const FNV_OFFSET = 0x811c9dc5n;
const FNV_PRIME = 0x01000193n;
const MASK64 = 0xffffffffn;

/**
 * Normalize text for fingerprinting: collapse whitespace, strip punctuation,
 * lowercase. Preserves alphanumeric content only, so reformatting a document
 * does not change its fingerprint.
 */
export function normalizeForFingerprinting(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** FNV-1a 64-bit hash of a string. Returns a bigint in [0, 2^64). */
function fnv1a64(input: string): bigint {
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK64;
  }
  return hash;
}

/**
 * Compute a sketch fingerprint of text.
 * Each character n-gram is hashed; the minimum hash landing in each bucket
 * is kept. The sketch is serialized as 64 hex chars (one per bucket).
 */
export function fingerprintText(text: string): string {
  const normalized = normalizeForFingerprinting(text);
  const mins = new Array<number>(SKETCH_BUCKETS).fill(Number.POSITIVE_INFINITY);

  if (normalized.length > 0 && normalized.length < NGRAM_SIZE) {
    const h = Number(fnv1a64(normalized) & MASK64);
    mins[h & BUCKET_MASK] = Math.min(mins[h & BUCKET_MASK] ?? Infinity, h);
    return serializeMins(mins);
  }

  for (let i = 0; i + NGRAM_SIZE <= normalized.length; i++) {
    const gram = normalized.slice(i, i + NGRAM_SIZE);
    const h = Number(fnv1a64(gram) & MASK64);
    const bucket = h & BUCKET_MASK;
    if (h < (mins[bucket] ?? Number.POSITIVE_INFINITY)) {
      mins[bucket] = h;
    }
  }

  return serializeMins(mins);
}

function serializeMins(mins: readonly number[]): string {
  // Fold each bucket's minimum into 8 hex digits for compact storage.
  return mins
    .map((m) =>
      Number.isFinite(m) ? m.toString(16).padStart(8, "0") : "ffffffff",
    )
    .join("")
    .slice(0, SKETCH_BUCKETS * 8)
    .padEnd(SKETCH_BUCKETS * 8, "0");
}

/**
 * Estimate similarity of two fingerprints as Jaccard-like ratio in [0, 1].
 * Buckets with no minimum on either side are excluded from the denominator.
 */
export function fingerprintSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length !== b.length || a.length === 0) return 0;

  let matches = 0;
  let comparable = 0;
  const width = 8;

  for (let i = 0; i + width <= a.length; i += width) {
    const x = a.slice(i, i + width);
    const y = b.slice(i, i + width);
    if (x === "ffffffff" && y === "ffffffff") continue;
    comparable++;
    if (x === y) matches++;
  }

  return comparable === 0 ? 0 : matches / comparable;
}

/**
 * Canonical dedupe key for a document: hostname + normalized path.
 * Fragments, query strings (except pagination params) and trailing
 * slashes are ignored.
 */
export function canonicalDedupeKey(url: string): string {
  try {
    const u = new URL(url);
    const keepParams: string[] = [];
    for (const [key, value] of u.searchParams) {
      const k = key.toLowerCase();
      // Preserve pagination identifiers only; strip tracking params.
      if (k === "p" || k === "page" || k === "id") {
        keepParams.push(`${k}=${value}`);
      }
    }
    let path = u.pathname.replace(/\/+$/, "");
    if (path === "") path = "/";
    const query =
      keepParams.length > 0 ? `?${keepParams.sort().join("&")}` : "";
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    return `${host}${path}${query}`;
  } catch {
    return url;
  }
}
