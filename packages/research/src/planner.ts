/**
 * Research planner: decomposes an objective into initial queries and
 * generates follow-ups from detected gaps.
 *
 * Deliberately deterministic and model-free: query decomposition uses
 * heuristic extraction of the objective's key terms. A model hook can
 * replace or augment this via the API layer later.
 */

import { tokenize } from '@querynx/indexer';

/**
 * Split an objective into 1-3 initial queries. Long objectives get
 * decomposed at clause boundaries; short ones pass through.
 */
export function planInitialQueries(objective: string, mode: string): string[] {
  const trimmed = objective.trim();
  if (!trimmed) return [];

  // Academic mode biases toward scholarly phrasing.
  const academic = mode === 'academic';

  // Split on clause punctuation for multi-part objectives.
  const clauses = trimmed
    .split(/[,;:]\s+|\s+(?:and|vs\.?|versus)\s+/i)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  const queries = new Set<string>();
  if (clauses.length >= 2) {
    for (const clause of clauses) {
      if (clause.split(/\s+/).length >= 2) queries.add(clause);
    }
  }
  // Always include the full objective as one query.
  queries.add(trimmed);

  if (academic && queries.size < 3) {
    const terms = tokenize(trimmed);
    if (terms.length > 0) {
      queries.add(`${trimmed} study survey`);
    }
  }

  return [...queries].slice(0, 3);
}

/**
 * Derive a follow-up query from an information gap. Keeps the original
 * topic terms and adds differentiators that target the missing aspect.
 */
export function planFollowUpQuery(gapQuestion: string, tried: readonly string[]): string {
  const terms = tokenize(gapQuestion);
  const fresh = terms.filter((t) => !tried.some((q) => q.toLowerCase().includes(t)));
  const core = fresh.length > 0 ? fresh.slice(0, 5).join(' ') : terms.slice(0, 5).join(' ');
  return `${core} explained details`;
}

/**
 * Detect information gaps: sub-questions raised by the objective that
 * the evidence set does not cover. Heuristic: significant objective
 * terms absent from all evidence passages.
 */
export function detectGaps(
  objective: string,
  evidence: ReadonlyArray<{ passage: string; title: string }>,
  maxGaps: number
): string[] {
  const objectiveTerms = new Set(tokenize(objective));
  if (objectiveTerms.size === 0) return [];

  const corpus = evidence
    .map((e) => `${e.title} ${e.passage}`)
    .join(' ')
    .toLowerCase();
  const covered = tokenize(corpus);

  const missing: string[] = [];
  for (const term of objectiveTerms) {
    if (!covered.includes(term)) missing.push(term);
  }

  if (missing.length === 0) return [];
  const question = `What is meant by "${missing.slice(0, 4).join('", "')}" in the context of ${objective}?`;
  return missing.length >= 1 ? [question].slice(0, maxGaps) : [];
}
