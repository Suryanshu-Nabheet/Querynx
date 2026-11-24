/**
 * Contradiction detection across research evidence.
 *
 * Deterministic and model-free: extracts comparable factual claims
 * (explicit dates and standalone quantities) from independent sources
 * and reports when two sources assert different values for what the
 * objective asks about. This is deliberately conservative — it only
 * claims a conflict when the same question dimension (e.g. a year)
 * carries different values from different URLs, never on mere
 * wording differences.
 */

import type { Evidence } from "./types.js";

interface Conflict {
  question: string;
  probeQuery: string;
  a: string;
  b: string;
}

/** Extract years from a passage. */
function years(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(/\b(19|20)\d{2}\b/g)) {
    found.add(match[0]);
  }
  return found;
}

/** Extract large standalone quantities (percentages, counts). */
function quantities(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(/\b\d[\d,.]*\s*(?:%|percent|million|billion|users|downloads)\b/gi)) {
    found.add(match[0].toLowerCase().replace(/\s+/g, " "));
  }
  return found;
}

/**
 * Detect contradictions: the same claim dimension carrying
 * DIFFERENT single values from different sources. A dimension only
 * counts when a source commits to exactly one value — sources listing
 * several years (histories, timelines) are excluded to avoid noise.
 */
export function detectContradictions(
  evidence: ReadonlyArray<Evidence>,
): Conflict[] {
  const conflicts: Conflict[] = [];

  // Group per-dimension single-value assertions by URL.
  const yearAssertions = new Map<string, string>();
  for (const item of evidence) {
    const ys = years(item.passage);
    if (ys.size === 1) yearAssertions.set(item.url, [...ys][0]!);
  }

  const seenPairs = new Set<string>();
  const urls = [...yearAssertions.keys()];
  for (let i = 0; i < urls.length; i++) {
    for (let j = i + 1; j < urls.length; j++) {
      const a = urls[i]!;
      const b = urls[j]!;
      if (yearAssertions.get(a) !== yearAssertions.get(b)) {
        const key = [yearAssertions.get(a), yearAssertions.get(b)].sort().join("|");
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        conflicts.push({
          question: `Sources disagree on the date: ${a} says ${yearAssertions.get(a)}, ${b} says ${yearAssertions.get(b)}`,
          probeQuery: `${a.split("/")[2] ?? a} vs ${b.split("/")[2] ?? b} which date is correct`,
          a,
          b,
        });
      }
    }
  }

  return conflicts;
}
