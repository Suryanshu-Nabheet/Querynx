/**
 * The research engine: bounded iterative retrieve -> extract -> rank ->
 * synthesize, streaming progress and tracking evidence provenance.
 *
 * Deterministic synthesis is the default. Every loop iteration checks
 * budgets and the abort signal, so research can never run away.
 */

import type {
  Evidence,
  InformationGap,
  ResearchBudget,
  ResearchEvent,
  ResearchMode,
  ResearchReport,
  ResearchStep,
  SearchFn,
  SynthesisFn,
} from "./types.js";
import { MODE_BUDGETS } from "./types.js";
import {
  detectGaps,
  planFollowUpQuery,
  planInitialQueries,
} from "./planner.js";
import { detectContradictions } from "./contradictions.js";
import {
  fingerprintSimilarity,
  fingerprintText,
  extractDomain,
  mapWithConcurrency,
} from "@querynx/shared";

export interface ResearchEngineOptions {
  mode?: ResearchMode;
  /** Override the mode's default budgets. */
  budgetOverrides?: Partial<ResearchBudget>;
  /** Search execution (orchestrator-backed in production). */
  search: SearchFn;
  /** Deterministic extractive summary when no model is configured. */
  synthesis?: SynthesisFn;
  /** Page-content extraction hook (fetcher-based in production). */
  extractContent: (
    url: string,
    signal?: AbortSignal,
  ) => Promise<{ title: string; content: string; publishedAt?: string } | null>;
  /** Progress streaming. */
  onEvent?: (event: ResearchEvent) => void;
  /** Cooperative cancellation. */
  signal?: AbortSignal;
  /** Cap on simultaneous page fetches. */
  fetchConcurrency?: number;
}

export class ResearchEngine {
  /**
   * Execute a bounded research run over an objective.
   */
  async research(
    objective: string,
    options: ResearchEngineOptions,
  ): Promise<ResearchReport> {
    const mode: ResearchMode = options.mode ?? "standard";
    const budgets: ResearchBudget = {
      ...MODE_BUDGETS[mode],
      ...options.budgetOverrides,
    };
    const fetchConcurrency = options.fetchConcurrency ?? 4;
    const { signal } = options;
    const emit = (event: ResearchEvent) => options.onEvent?.(event);

    const startedAt = Date.now();
    const steps: ResearchStep[] = [];
    const evidence: Evidence[] = [];
    const gaps: InformationGap[] = [];
    const contradictionsFound: Array<{
      question: string;
      probeQuery: string;
      a: string;
      b: string;
    }> = [];
    const seenUrls = new Set<string>();
    const seenFingerprints: string[] = [];
    let contentChars = 0;
    let pagesFetched = 0;
    let queriesIssued = 0;

    const deadline = startedAt + budgets.timeMs;
    const outOfBudget = () =>
      Date.now() >= deadline ||
      queriesIssued >= budgets.maxQueries ||
      pagesFetched >= budgets.maxPages ||
      contentChars >= budgets.maxContentChars;

    // ---- Phase 1: initial queries ------------------------------------
    const plannedQueries = planInitialQueries(objective, mode);
    const searchRound = async (
      query: string,
      reason: ResearchStep["reason"],
    ): Promise<void> => {
      if (outOfBudget()) return;
      queriesIssued++;
      emit({ type: "query-started", query, reason });
      const t0 = Date.now();
      let results = [] as Awaited<ReturnType<SearchFn>>;
      try {
        results = await options.search(query, 8, signal);
      } catch {
        // Search failures degrade: record zero results and continue.
        results = [];
      }
      const durationMs = Date.now() - t0;
      steps.push({
        query,
        reason,
        resultCount: results.length,
        durationMs,
      });
      emit({
        type: "query-completed",
        query,
        resultCount: results.length,
        durationMs,
      });

      // Queue promising results for content extraction.
      for (const result of results) {
        if (pagesFetched >= budgets.maxPages) break;
        if (seenUrls.has(result.url)) continue;
        seenUrls.add(result.url);
        // Skip pages blocked from fetching.
        pendingExtraction.push(result);
      }
    };

    // Indirection so tests can inject search; avoids importing types fn.
    const pendingExtraction: Array<{
      url: string;
      title: string;
      snippet: string;
      score: number;
      publishedAt?: string;
    }> = [];

    const extractPending = async (): Promise<void> => {
      const batch = pendingExtraction.splice(
        0,
        budgets.maxPages - pagesFetched,
      );
      await mapWithConcurrency(
        batch,
        fetchConcurrency,
        async (result) => {
          if (outOfBudget()) return;
          if (signal?.aborted) return;
          try {
            const extracted = await options.extractContent(result.url, signal);
            if (!extracted) return;
            pagesFetched++;

            const fingerprint = fingerprintText(extracted.content);
            // Content-level dedupe across sources.
            if (
              seenFingerprints.some(
                (f) => fingerprintSimilarity(f, fingerprint) > 0.9,
              )
            ) {
              return;
            }
            seenFingerprints.push(fingerprint);
            contentChars += extracted.content.length;
            emit({
              type: "page-extracted",
              url: result.url,
              title: extracted.title,
              contentChars: extracted.content.length,
            });

            evidence.push({
              url: result.url,
              title: extracted.title || result.title,
              passage: selectPassages(extracted.content, 3)
                .join("\n\n")
                .slice(0, 2_000),
              stepQuery: steps.at(-1)?.query ?? "",
              relevance: result.score,
              publishedAt: extracted.publishedAt ?? result.publishedAt,
            });
          } catch {
            // Extraction failure is tolerable; the snippet remains as evidence.
            evidence.push({
              url: result.url,
              title: result.title,
              passage: result.snippet,
              stepQuery: steps.at(-1)?.query ?? "",
              relevance: result.score * 0.5,
              publishedAt: result.publishedAt,
            });
          }
        },
        signal,
      ).catch(() => {});
    };

    for (const query of plannedQueries) {
      await searchRound(query, "initial");
    }
    await extractPending();

    // ---- Phase 2: gap-driven follow-ups ------------------------------
    let followUpRound = 0;
    while (!outOfBudget() && !signal?.aborted && followUpRound < 2) {
      const detected = detectGaps(objective, evidence, 2);
      if (detected.length === 0) break;
      for (const gap of detected) {
        if (outOfBudget()) break;
        gaps.push({ question: gap, attemptedQueries: [gap] });
        emit({ type: "gap-detected", question: gap });
        const followUp = planFollowUpQuery(
          gap,
          steps.map((s) => s.query),
        );
        await searchRound(followUp, "gap-followup");
      }
      await extractPending();
      followUpRound++;
    }

    // ---- Phase 2b: contradiction detection ---------------------------
    // Conflicting numeric/date claims across independent sources are
    // surfaced (and probed once per run) instead of being silently
    // averaged into the synthesis. Probing uses its own budget flag so
    // exhausted gap rounds never suppress it.
    const contradictions = detectContradictions(evidence);
    let contradictionProbes = 0;
    for (const conflict of contradictions.slice(0, 2)) {
      if (outOfBudget()) break;
      contradictionsFound.push(conflict);
      emit({ type: "gap-detected", question: conflict.question });
      if (contradictionProbes < 1) {
        contradictionProbes++;
        await searchRound(conflict.probeQuery, "contradiction-probe");
        await extractPending();
      }
    }

    if (signal?.aborted) {
      return finalize("cancelled");
    }

    // ---- Phase 3: synthesis ------------------------------------------
    const findings = options.synthesis
      ? await options
          .synthesis(objective, evidence)
          .catch(() => deterministicSummary(objective, evidence))
      : deterministicSummary(objective, evidence);

    const termination: ResearchReport["termination"] =
      steps.length === 0 || evidence.length === 0
        ? "no-results"
        : queriesIssued >= budgets.maxQueries ||
            pagesFetched >= budgets.maxPages ||
            Date.now() >= deadline
          ? "budget-exhausted"
          : "coverage-reached";

    return finalize(termination, findings);

    function finalize(
      termination: ResearchReport["termination"],
      findings?: string,
    ): ResearchReport {
      return {
        objective,
        mode,
        findings: findings ?? deterministicSummary(objective, evidence),
        evidence,
        steps,
        gaps,
        contradictions: contradictionsFound.map((c) => ({
          question: c.question,
          sources: [c.a, c.b] as [string, string],
        })),
        usage: {
          queries: queriesIssued,
          pagesFetched,
          elapsedMs: Date.now() - startedAt,
          contentChars,
        },
        termination,
        completedAt: new Date().toISOString(),
      };
    }
  }
}

/** Select the most central sentences as passages (extractive). */
function selectPassages(content: string, count: number): string[] {
  const sentences = content
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .filter((s) => s.length > 40);
  if (sentences.length === 0) return [content.slice(0, 500)];

  // Rank by informativeness: position + length heuristics, no model.
  return sentences
    .map((sentence, index) => ({
      sentence,
      score:
        Math.min(sentence.length, 300) +
        (index < 3 ? 100 : 0) - // early sentences carry topic statements
        (index > 20 ? 50 : 0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map((s) => s.sentence);
}

/** Deterministic extractive summary: best passages joined by provenance. */
function deterministicSummary(
  objective: string,
  evidence: readonly Evidence[],
): string {
  if (evidence.length === 0) {
    return `No evidence was retrieved for the objective "${objective}".`;
  }
  const sections: string[] = [];
  const byDomain = new Map<string, Evidence[]>();
  for (const item of evidence) {
    const domain = extractDomain(item.url) || "unknown";
    const list = byDomain.get(domain) ?? [];
    list.push(item);
    byDomain.set(domain, list);
  }

  sections.push(
    `Findings for "${objective}" are supported by ${evidence.length} source(s) across ${byDomain.size} domain(s).`,
  );
  for (const item of evidence.slice(0, 8)) {
    const passage = item.passage.slice(0, 400);
    sections.push(`According to "${item.title}" (${item.url}): ${passage}`);
  }
  const distinct = [...byDomain.entries()]
    .filter(([, items]) => items.length > 0)
    .map(([domain]) => domain);
  sections.push(`Sources: ${distinct.join(", ")}.`);
  return sections.join("\n\n");
}
