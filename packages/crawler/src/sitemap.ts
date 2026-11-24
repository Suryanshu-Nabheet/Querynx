/**
 * Sitemap.xml parsing for seed discovery.
 */

import { fetchUrl } from '@querynx/fetcher';

/** Extract all page URLs from a sitemap or sitemap index XML. */
export function parseSitemap(xml: string): { urls: string[]; sitemapIndexes: string[] } {
  const urls: string[] = [];
  const sitemapIndexes: string[] = [];

  // Lightweight regex parsing avoids a full DOM for this simple format;
  // sitemap XML has no mixed content or entities needing structure.
  const locRegex = /<(?:\w+:)?loc>\s*([^<]+?)\s*<\/(?:\w+:)?loc>/g;
  const scopeRegex = /<urlset[\s>]/i;
  const indexRegex = /<sitemapindex[\s>]/i;

  const isIndex = indexRegex.test(xml);
  const isUrlset = scopeRegex.test(xml);
  if (!isIndex && !isUrlset) return { urls, sitemapIndexes };

  let match: RegExpExecArray | null;
  while ((match = locRegex.exec(xml)) !== null) {
    const loc = match[1]!;
    if (!/^https?:\/\//i.test(loc)) continue;
    if (isIndex) sitemapIndexes.push(loc);
    else urls.push(loc);
  }
  return { urls, sitemapIndexes };
}

/** Cap on URLs harvested from one sitemap tree. */
const MAX_SITEMAP_URLS = 5_000;

/**
 * Fetch a sitemap (or index, recursively) and return discovered page
 * URLs, bounded by MAX_SITEMAP_URLS.
 */
export async function fetchSitemapUrls(
  sitemapUrl: string,
  userAgent: string,
  visited = new Set<string>()
): Promise<string[]> {
  if (visited.has(sitemapUrl) || visited.size > 50) return [];
  visited.add(sitemapUrl);

  const found: string[] = [];
  let xml: string;
  try {
    const response = await fetchUrl(sitemapUrl, {
      timeoutMs: 15_000,
      maxBytes: 5 * 1024 * 1024,
      userAgent,
    });
    if (response.statusCode !== 200) return [];
    xml = response.body;
  } catch {
    return [];
  }

  const { urls, sitemapIndexes } = parseSitemap(xml);
  found.push(...urls);

  for (const child of sitemapIndexes) {
    if (found.length >= MAX_SITEMAP_URLS) break;
    const childUrls = await fetchSitemapUrls(child, userAgent, visited);
    found.push(...childUrls);
  }

  return found.slice(0, MAX_SITEMAP_URLS);
}
