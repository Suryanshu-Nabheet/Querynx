/**
 * robots.txt compliance.
 *
 * Parses the Robots Exclusion Protocol (REP) — user-agent groups,
 * Disallow/Allow paths, crawl-delay — with longest-match-wins path rules
 * per the Google/Bing interpretation.
 *
 * Group selection follows REP: the most specific matching user-agent
 * token wins exclusively (exact > prefix > `*`), and an agent-matched
 * group fully replaces the wildcard group. When two groups match with
 * equal specificity, the first encountered in file order applies.
 * Unreachable or unparseable robots files mean "no rules" (allow all).
 */

import { fetchUrl } from "@querynx/fetcher";

export interface RobotsRule {
  path: string;
  allow: boolean;
}

export interface RobotsGroup {
  /** User-agent tokens this group applies to (lowercased). */
  agents: Set<string>;
  rules: RobotsRule[];
  crawlDelayMs?: number;
  /** File-order position for tie-breaking. */
  order: number;
}

export class RobotsFile {
  private readonly groups: RobotsGroup[] = [];
  /** Sitemap URLs declared in the file. */
  readonly sitemaps: string[] = [];

  constructor(raw: string) {
    this.parse(raw);
  }

  private parse(raw: string): void {
    let current: RobotsGroup | null = null;
    let lastWasAgent = false;
    let order = 0;

    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.split("#")[0]!.trim();
      if (!line) continue;

      const colon = line.indexOf(":");
      if (colon === -1) continue;
      const field = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();

      if (field === "user-agent") {
        if (!current || !lastWasAgent) {
          current = { agents: new Set(), rules: [], order: order++ };
          this.groups.push(current);
        }
        current.agents.add(value.toLowerCase());
        lastWasAgent = true;
        continue;
      }

      if (!current) continue;
      lastWasAgent = false;

      switch (field) {
        case "disallow":
          if (value) current.rules.push({ path: value, allow: false });
          break;
        case "allow":
          if (value) current.rules.push({ path: value, allow: true });
          break;
        case "crawl-delay": {
          const seconds = Number.parseFloat(value);
          if (Number.isFinite(seconds) && seconds >= 0) {
            current.crawlDelayMs = Math.round(seconds * 1000);
          }
          break;
        }
        case "sitemap":
          if (/^https?:\/\//i.test(value)) this.sitemaps.push(value);
          break;
        default:
          // Unknown directives (noindex, clean-param, host) are ignored.
          break;
      }
    }
  }

  /**
   * Pick the single most specific matching group for a user-agent.
   * Exact token match scores highest; prefix match (e.g. "googlebot"
   * matching group token "google") next; `*` lowest. Ties resolve by
   * file order. A specific match excludes `*` groups entirely.
   */
  private matchGroup(userAgent: string): RobotsGroup | null {
    const ua = userAgent.toLowerCase();
    let best: RobotsGroup | null = null;
    let bestScore = -1;

    for (const group of this.groups) {
      for (const agent of group.agents) {
        let score = -1;
        if (agent === ua) score = 1000;
        else if (ua.startsWith(agent) && agent.length >= 3)
          score = agent.length;
        else if (agent === "*") score = 1;

        // Earlier file order wins ties.
        if (
          score > bestScore ||
          (score === bestScore && best && group.order < best.order)
        ) {
          bestScore = score;
          best = group;
        }
      }
    }
    return best;
  }

  /** Whether fetching a path is permitted for the given user-agent. */
  isAllowed(url: string, userAgent: string): boolean {
    let path: string;
    try {
      const u = new URL(url);
      path = u.pathname + u.search;
    } catch {
      return false;
    }

    const group = this.matchGroup(userAgent);
    if (!group || group.rules.length === 0) return true;

    // Longest-match wins; ties go to Allow.
    let best: RobotsRule | null = null;
    for (const rule of group.rules) {
      if (matchesPath(path, rule.path)) {
        if (!best || rule.path.length > best.path.length) best = rule;
      }
    }
    if (!best) return true;
    return best.allow;
  }

  /** Declared crawl-delay for the user agent, in milliseconds. */
  crawlDelayMs(userAgent: string): number | undefined {
    return this.matchGroup(userAgent)?.crawlDelayMs;
  }
}

/**
 * REP pattern matching: `*` matches any run, `$` anchors to the end.
 * A rule with no wildcard must be a path prefix.
 */
export function matchesPath(path: string, pattern: string): boolean {
  if (pattern === "") return true;

  if (!pattern.includes("*") && !pattern.endsWith("$")) {
    return path.startsWith(pattern);
  }

  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const segments = body.split("*");

  let position = 0;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (segment === "") continue;
    const index = path.indexOf(segment, position);
    if (index === -1) return false;
    // First segment must match at position 0 (prefix semantics).
    if (i === 0 && index !== 0) return false;
    position = index + segment.length;
  }
  if (anchored) {
    return position === path.length;
  }
  return true;
}

const robotsCache = new Map<string, RobotsFile>();

/**
 * Fetch and cache the robots.txt for a URL's origin. Unreachable or
 * unparseable robots files yield a permissive RobotsFile (allowed all).
 */
export async function getRobotsFor(
  url: string,
  userAgent: string,
  forceRefetch = false,
): Promise<RobotsFile> {
  const origin = new URL(url).origin;
  const cacheKey = `${origin}|${userAgent}`;
  if (!forceRefetch) {
    const cached = robotsCache.get(cacheKey);
    if (cached) return cached;
  }

  let robots: RobotsFile;
  try {
    const response = await fetchUrl(`${origin}/robots.txt`, {
      timeoutMs: 8_000,
      maxBytes: 512 * 1024,
      userAgent,
    });
    if (response.statusCode >= 500) {
      robots = new RobotsFile("");
    } else {
      robots = new RobotsFile(response.body);
    }
  } catch {
    robots = new RobotsFile("");
  }
  robotsCache.set(cacheKey, robots);
  return robots;
}

/** Test hook: clear the robots cache. */
export function clearRobotsCache(): void {
  robotsCache.clear();
}
