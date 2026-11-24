/**
 * Research domain types: objectives, budgets, evidence and reports.
 */

import type { SearchResult } from '@querynx/types';

/** Research depth modes. */
export type ResearchMode =
  | 'fast'
  | 'standard'
  | 'advanced'
  | 'deep'
  | 'academic'
  | 'technical'
  | 'documentation';

/** Hard budgets preventing unbounded research loops. */
export interface ResearchBudget {
  /** Maximum search queries issued (including follow-ups). */
  maxQueries: number;
  /** Maximum pages fetched for content extraction. */
  maxPages: number;
  /** Maximum wall-clock milliseconds. */
  timeMs: number;
  /** Maximum extracted content characters accumulated. */
  maxContentChars: number;
}

/** Default budgets per mode. Tighter modes terminate sooner. */
export const MODE_BUDGETS: Record<ResearchMode, ResearchBudget> = {
  fast: { maxQueries: 2, maxPages: 3, timeMs: 30_000, maxContentChars: 30_000 },
  standard: { maxQueries: 4, maxPages: 6, timeMs: 60_000, maxContentChars: 60_000 },
  advanced: { maxQueries: 6, maxPages: 10, timeMs: 120_000, maxContentChars: 120_000 },
  deep: { maxQueries: 10, maxPages: 20, timeMs: 300_000, maxContentChars: 300_000 },
  academic: { maxQueries: 8, maxPages: 14, timeMs: 180_000, maxContentChars: 200_000 },
  technical: { maxQueries: 6, maxPages: 12, timeMs: 150_000, maxContentChars: 180_000 },
  documentation: { maxQueries: 4, maxPages: 10, timeMs: 90_000, maxContentChars: 150_000 },
};

/** A single issued research query with its rationale. */
export interface ResearchStep {
  /** Query text issued to the search layer. */
  query: string;
  /** Why this query was issued (initial, gap-followup, contradiction). */
  reason: 'initial' | 'gap-followup' | 'contradiction-probe';
  /** Results count contributed. */
  resultCount: number;
  /** Wall-clock duration. */
  durationMs: number;
}

/** A piece of evidence backing or contesting a claim. */
export interface Evidence {
  /** Source URL. */
  url: string;
  /** Source title. */
  title: string;
  /** Relevant passage extracted from the source content. */
  passage: string;
  /** Which research step surfaced this source. */
  stepQuery: string;
  /** Normalized relevance in [0,1]. */
  relevance: number;
  /** Publication date when known. */
  publishedAt?: string;
}

/** An information gap: what the research could not establish. */
export interface InformationGap {
  /** The sub-question that remains unanswered. */
  question: string;
  /** What was tried. */
  attemptedQueries: string[];
}

/** Final research report. */
export interface ResearchReport {
  /** Original objective. */
  objective: string;
  /** Mode used. */
  mode: ResearchMode;
  /** Synthesized findings as structured prose. */
  findings: string;
  /** Evidence supporting the findings. */
  evidence: Evidence[];
  /** Queries executed, in order. */
  steps: ResearchStep[];
  /** Questions the research could not answer. */
  gaps: InformationGap[];
  /** Budget consumption summary. */
  usage: {
    queries: number;
    pagesFetched: number;
    elapsedMs: number;
    contentChars: number;
  };
  /** Why the research terminated. */
  termination: 'budget-exhausted' | 'coverage-reached' | 'no-results' | 'cancelled';
  /** Report timestamp. */
  completedAt: string;
}

/** Streaming events emitted during research execution. */
export type ResearchEvent =
  | { type: 'query-started'; query: string; reason: ResearchStep['reason'] }
  | { type: 'query-completed'; query: string; resultCount: number; durationMs: number }
  | { type: 'page-extracted'; url: string; title: string; contentChars: number }
  | { type: 'gap-detected'; question: string }
  | { type: 'completed'; report: ResearchReport };

/** The contract research uses to search and to synthesize. */
export interface SearchFn {
  (query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]>;
}

/**
 * Model hook for synthesis. When absent, research produces a
 * deterministic extractive summary — infrastructure stays useful
 * without any LLM.
 */
export interface SynthesisFn {
  (objective: string, evidence: readonly Evidence[]): Promise<string>;
}
