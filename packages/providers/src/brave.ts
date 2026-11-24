/**
 * Brave Search API provider (official, documented API; requires a key).
 * https://api-dashboard.search.brave.com/
 */

import type { SearchProvider, SearchQuery, SearchResult } from "@querynx/types";
import { fetchUrl } from "@querynx/fetcher";
import { canonicalizeUrl } from "@querynx/shared";

export interface BraveConfig {
  /** Brave Search API subscription key. */
  apiKey: string;
  /** Endpoint base; defaults to the public Brave Search API. */
  baseUrl?: string;
}

interface BraveWebResponse {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
      age?: string;
      date?: string;
      page_age?: string;
    }>;
  };
}

export class BraveProvider implements SearchProvider {
  readonly name = "brave";
  private readonly baseUrl: string;

  constructor(
    private readonly config: BraveConfig,
    private readonly timeoutMs = 10_000,
  ) {
    this.baseUrl = config.baseUrl ?? "https://api.search.brave.com";
  }

  isConfigured(): boolean {
    return (
      typeof this.config.apiKey === "string" && this.config.apiKey.length > 0
    );
  }

  async search(
    query: SearchQuery,
    signal?: AbortSignal,
  ): Promise<SearchResult[]> {
    const url = new URL("/res/v1/web/search", this.baseUrl);
    url.searchParams.set("q", query.query);
    url.searchParams.set("count", String(Math.min(query.maxResults * 2, 20)));
    if (query.language) url.searchParams.set("search_lang", query.language);
    if (query.region) url.searchParams.set("country", query.region);
    if (query.freshness && query.freshness !== "any") {
      const ranges: Record<string, string> = {
        day: "pd",
        week: "pw",
        month: "pm",
        year: "py",
      };
      const f = ranges[query.freshness];
      if (f) url.searchParams.set("freshness", f);
    }

    const response = await fetchUrl(url.toString(), {
      timeoutMs: this.timeoutMs,
      headers: {
        accept: "application/json",
        "x-subscription-token": this.config.apiKey,
      },
      signal,
    });

    if (response.statusCode === 429) {
      throw new Error("Brave rate limit exceeded");
    }
    if (response.statusCode !== 200) {
      throw new Error(`Brave returned HTTP ${response.statusCode}`);
    }

    const parsed = JSON.parse(response.body) as BraveWebResponse;
    const items = parsed.web?.results ?? [];
    const results: SearchResult[] = [];
    for (const item of items) {
      if (!item.url || !item.title) continue;
      const canonical = canonicalizeUrl(item.url);
      if (!canonical) continue;
      const dateStr = item.date ?? item.page_age;
      const publishedAt = dateStr ? new Date(dateStr).toISOString() : undefined;
      results.push({
        title: item.title.trim(),
        url: canonical,
        snippet: stripTags(item.description ?? "").slice(0, 1000),
        score: 0.5,
        provider: this.name,
        publishedAt:
          publishedAt && !Number.isNaN(new Date(publishedAt).getTime())
            ? publishedAt
            : undefined,
      });
    }
    return results;
  }
}

function stripTags(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
