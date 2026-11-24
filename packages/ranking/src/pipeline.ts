/**
 * Configurable ranking pipeline: applies weighted signals to a set of
 * candidate results and produces a final ordering.
 *
 * Signals are pure functions over (result, context); weights are
 * operator-configurable. This keeps ranking transparent, testable and
 * free of any model dependency — expensive reranking is a separate
 * optional layer.
 */

import type { SearchResult } from '@querynx/types';
import { extractDomain } from '@querynx/shared';

export interface RankingContext {
  /** The user query text. */
  query: string;
  /** Operator domain preferences: domain -> boost in [-1, 1]. */
  domainPreferences?: Readonly<Record<string, number>>;
  /** Domains corroborated by multiple providers rank higher. */
  providerCounts?: ReadonlyMap<string, number>;
  /** Current time for freshness computation. */
  now?: Date;
}

export interface RankingSignal {
  /** Signal name for diagnostics. */
  name: string;
  /** Weight multiplier applied to this signal. */
  weight: number;
  /** Score a single result in [0, 1] (higher = better). */
  score: (result: SearchResult, context: RankingContext) => number;
}

/** Text overlap between query terms and title+snippet (normalized). */
export const textRelevance: RankingSignal = {
  name: 'text-relevance',
  weight: 1.0,
  score: (result, context) => {
    const queryTerms = context.query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
    if (queryTerms.length === 0) return 0;
    const haystack = `${result.title} ${result.snippet}`.toLowerCase();
    let hits = 0;
    for (const term of queryTerms) {
      if (haystack.includes(term)) hits++;
    }
    return hits / queryTerms.length;
  },
};

/** Recency: newer content scores higher, decaying over ~1 year. */
export const freshness: RankingSignal = {
  name: 'freshness',
  weight: 0.5,
  score: (result, context) => {
    if (!result.publishedAt) return 0.5; // unknown age: neutral
    const published = new Date(result.publishedAt).getTime();
    if (Number.isNaN(published)) return 0.5;
    const now = (context.now ?? new Date()).getTime();
    const ageDays = (now - published) / 86_400_000;
    if (ageDays < 0) return 1;
    // Exponential decay with a ~90 day half-life.
    return Math.exp(-ageDays / 130);
  },
};

/** Source diversity: penalize repeated domains deeper in the list. */
export const sourceDiversity: RankingSignal = {
  name: 'source-diversity',
  weight: 0.3,
  score: (result) => {
    // Diversity is positional and applied at pipeline level; per-result
    // base score here is 1 and the pipeline demotes repeats.
    void result;
    return 1;
  },
};

/** Operator domain preferences, clamped to [-1, 1]. */
export const domainBoost: RankingSignal = {
  name: 'domain-boost',
  weight: 0.8,
  score: (result, context) => {
    const prefs = context.domainPreferences;
    if (!prefs) return 0.5;
    const domain = extractDomain(result.url);
    // Find the most specific matching preference.
    let best: number | undefined;
    for (const [pref, boost] of Object.entries(prefs)) {
      if (domain === pref || domain.endsWith(`.${pref}`)) {
        const clamped = Math.max(-1, Math.min(1, boost));
        if (best === undefined || Math.abs(clamped) > Math.abs(best)) best = clamped;
      }
    }
    if (best === undefined) return 0.5;
    return (best + 1) / 2; // map [-1,1] to [0,1]
  },
};

/** Multi-provider corroboration. */
export const corroboration: RankingSignal = {
  name: 'corroboration',
  weight: 0.6,
  score: (result, context) => {
    const counts = context.providerCounts;
    if (!counts) return 0.5;
    const providers = (result.metadata?.providers as string[] | undefined) ?? [];
    let distinct = 0;
    for (const p of providers) {
      if (counts.has(p)) distinct++;
    }
    return Math.min(1, distinct / 3); // 3+ providers = full score
  },
};

export const DEFAULT_SIGNALS: readonly RankingSignal[] = [
  textRelevance,
  freshness,
  sourceDiversity,
  domainBoost,
  corroboration,
];

export interface RankedResult extends SearchResult {
  /** Final fused score. */
  rankScore: number;
  /** Per-signal diagnostic scores. */
  signalScores: Record<string, number>;
}

/**
 * Rank candidates: compute weighted signal sums, then demote repeated
 * domains (diversity) beyond the first occurrence, and sort.
 */
export function rankResults(
  candidates: readonly SearchResult[],
  context: RankingContext,
  signals: readonly RankingSignal[] = DEFAULT_SIGNALS
): RankedResult[] {
  const scored = candidates.map((result) => {
    const signalScores: Record<string, number> = {};
    let total = 0;
    let weightSum = 0;
    for (const signal of signals) {
      const s = signal.score(result, context);
      signalScores[signal.name] = s;
      total += s * signal.weight;
      weightSum += signal.weight;
    }
    const fused = weightSum > 0 ? total / weightSum : 0;
    return { ...result, rankScore: fused, signalScores };
  });

  // Sort by fused score first.
  scored.sort((a, b) => b.rankScore - a.rankScore);

  // Diversity demotion: later results from an already-seen domain get
  // progressively demoted but stay in the list.
  const seenDomains = new Set<string>();
  const output: RankedResult[] = [];
  for (const entry of scored) {
    const domain = extractDomain(entry.url);
    if (seenDomains.has(domain)) {
      entry.rankScore *= 0.75; // demoted but not removed
    } else {
      seenDomains.add(domain);
    }
    output.push(entry);
  }

  // Stable re-sort after demotion.
  return output.sort((a, b) => b.rankScore - a.rankScore);
}
