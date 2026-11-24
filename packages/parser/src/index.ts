/**
 * Query understanding: normalization, intent classification, operator
 * extraction, decomposition and deterministic expansion.
 *
 * All model-free. These functions shape raw user text into structured
 * SearchQuery objects and derive additional query variants that
 * improve federated recall.
 */

import type { SearchCategory, Freshness } from "@querynx/types";

/** Normalize raw query text: trim, collapse whitespace, strip control. */
export function normalizeQuery(raw: string): string {
  return (
    raw
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500)
  );
}

export interface QueryClassification {
  /** Best-guess routing category. */
  category: SearchCategory;
  /** Whether the query looks like a natural question. */
  isQuestion: boolean;
  /** Whether the query seeks recent information. */
  wantsFresh: boolean;
  /** Whether the query names a specific site (site: syntax or brand). */
  siteHint?: string;
  /** Confidence heuristics, not ML: matched signal notes. */
  signals: string[];
}

/** Classify a normalized query deterministically. */
export function classifyQuery(query: string): QueryClassification {
  const lower = query.toLowerCase();
  const signals: string[] = [];

  // site: operator extraction.
  const siteMatch = lower.match(/\bsite:([a-z0-9.-]+)/);
  const siteHint = siteMatch?.[1];

  const isQuestion =
    /^(what|who|when|where|why|how|which|is|are|can|does|do|did)\b/.test(
      lower,
    ) || lower.endsWith("?");

  const freshTerms = [
    "latest",
    "news",
    "today",
    "recent",
    "breaking",
    "now",
    "2025",
    "2026",
    "current",
  ];
  const wantsFresh = freshTerms.some((t) => lower.includes(t));
  if (wantsFresh) signals.push("freshness-term");

  let category: SearchCategory = "web";
  if (
    /(arxiv|paper|study|research|journal|publication|doi|conference)/.test(
      lower,
    )
  ) {
    category = "academic";
    signals.push("academic-terms");
  } else if (
    /(github|stackoverflow|code|function|api reference|npm|library|sdk)/.test(
      lower,
    )
  ) {
    category = "code";
    signals.push("code-terms");
  } else if (
    /(docs|documentation|tutorial|guide|manual|reference)/.test(lower)
  ) {
    category = "docs";
    signals.push("docs-terms");
  } else if (wantsFresh && /(news|breaking|announcement)/.test(lower)) {
    category = "news";
    signals.push("news-terms");
  }

  if (isQuestion) signals.push("question-form");

  return { category, isQuestion, wantsFresh, siteHint, signals };
}

/** Extract explicit operators from a query: site:, freshness hints. */
export function extractOperators(query: string): {
  cleaned: string;
  includeDomains?: string[];
  freshness?: Freshness;
} {
  let cleaned = query;
  const includeDomains: string[] = [];

  const siteGlobal = /\bsite:([a-z0-9.-]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = siteGlobal.exec(query)) !== null) {
    includeDomains.push(m[1]!);
    cleaned = cleaned.replace(m[0], " ");
  }
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  let freshness: Freshness | undefined;
  if (/\b(today|last 24 hours?)\b/i.test(cleaned)) freshness = "day";
  else if (/\b(this week|last week)\b/i.test(cleaned)) freshness = "week";
  else if (/\b(this month|last month)\b/i.test(cleaned)) freshness = "month";
  else if (/\b(this year|last year)\b/i.test(cleaned)) freshness = "year";

  return {
    cleaned,
    includeDomains: includeDomains.length > 0 ? includeDomains : undefined,
    freshness,
  };
}

/** Decompose a complex query into focused sub-queries. */
export function decomposeQuery(query: string): string[] {
  const parts = query
    .split(/\s+(?:and|vs\.?|versus|or)\s+|[,;]\s+/i)
    .map((p) => p.trim())
    .filter((p) => p.split(/\s+/).length >= 2);
  // Only decompose when it actually splits into distinct concerns.
  const unique = [...new Set(parts)];
  return unique.length >= 2 ? unique.slice(0, 3) : [query];
}

/** Deterministic query expansion: variants that boost federated recall. */
export function expandQuery(query: string, category: SearchCategory): string[] {
  const variants = new Set<string>([query]);

  // Quote exact phrases when the query looks like a specific reference.
  if (/^[\w.:-]+ [\w.:-]+$/.test(query) && !query.includes('"')) {
    variants.add(`"${query}"`);
  }

  switch (category) {
    case "academic":
      variants.add(`${query} paper`);
      break;
    case "code":
      variants.add(`${query} example`);
      break;
    case "docs":
      variants.add(`${query} documentation`);
      break;
    case "news":
      variants.add(`${query} latest`);
      break;
    default:
      break;
  }

  return [...variants].slice(0, 3);
}

/** Full parse pipeline: raw text -> structured query parts. */
export interface ParsedQuery {
  normalized: string;
  cleaned: string;
  classification: QueryClassification;
  includeDomains?: string[];
  freshness?: Freshness;
  expansions: string[];
  decompositions: string[];
}

export function parseQuery(raw: string): ParsedQuery {
  const normalized = normalizeQuery(raw);
  const { cleaned, includeDomains, freshness } = extractOperators(normalized);
  const classification = classifyQuery(cleaned);
  return {
    normalized,
    cleaned,
    classification,
    includeDomains,
    freshness: freshness ?? (classification.wantsFresh ? "month" : undefined),
    expansions: expandQuery(cleaned, classification.category),
    decompositions: decomposeQuery(cleaned),
  };
}
