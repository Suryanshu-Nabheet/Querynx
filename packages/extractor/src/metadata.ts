/**
 * Structured metadata extraction: JSON-LD, Open Graph, meta tags,
 * canonical URLs, links, tables and document outline.
 */

import { parseHTML } from 'linkedom';
import type {
  DocumentHeading,
  DocumentLink,
  DocumentTable,
} from '@querynx/types';
import { extractDomain } from '@querynx/shared';

/** Safe JSON-LD graph objects extracted from the page. */
export function extractJsonLd(dom: Document): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];
  const scripts = dom.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    const raw = script.textContent ?? '';
    if (!raw.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      collectJsonLdNodes(parsed, results, 0);
    } catch {
      // Malformed JSON-LD is common on the web; skip silently.
    }
  }
  return results;
}

function collectJsonLdNodes(
  node: unknown,
  out: Array<Record<string, unknown>>,
  depth: number
): void {
  if (depth > 8) return;
  if (Array.isArray(node)) {
    for (const child of node) collectJsonLdNodes(child, out, depth + 1);
    return;
  }
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    const obj = node as Record<string, unknown>;
    if ('@graph' in obj && Array.isArray(obj['@graph'])) {
      for (const child of obj['@graph']) collectJsonLdNodes(child, out, depth + 1);
    }
    out.push(obj);
  }
}

/** Extract meta-tag-derived metadata (OG, Twitter, standard). */
export function extractMetaTags(dom: Document): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const tag of dom.querySelectorAll('meta')) {
    const name =
      tag.getAttribute('property') ?? tag.getAttribute('name') ?? undefined;
    const content = tag.getAttribute('content');
    if (name && content && !(name in meta)) {
      meta[name] = content.trim();
    }
  }
  const description = dom.querySelector('meta[name="description"]');
  if (description) meta['description'] = description.getAttribute('content')?.trim() ?? '';
  return meta;
}

/** Extract the document outline (h1-h6). */
export function extractHeadings(dom: Document): DocumentHeading[] {
  const headings: DocumentHeading[] = [];
  for (const el of dom.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    const level = Number(el.tagName.slice(1));
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    headings.push({ level, text, id: el.getAttribute('id') ?? undefined });
  }
  return headings;
}

/** Extract the outbound/inbound link inventory. */
export function extractLinks(dom: Document, baseUrl: string): DocumentLink[] {
  const links: DocumentLink[] = [];
  const pageDomain = extractDomain(baseUrl);
  const seen = new Set<string>();
  for (const anchor of dom.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href');
    if (!href) continue;
    let absolute: string;
    try {
      absolute = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    if (!/^https?:/i.test(absolute)) continue;
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    const rel = anchor.getAttribute('rel') ?? '';
    links.push({
      url: absolute,
      text: (anchor.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
      external: extractDomain(absolute) !== pageDomain,
      nofollow: /\bnofollow\b/i.test(rel) || undefined,
    });
  }
  return links;
}

/** Extract HTML tables as structured rows. */
export function extractTables(dom: Document): DocumentTable[] {
  const tables: DocumentTable[] = [];
  for (const table of dom.querySelectorAll('table')) {
    const headers: string[] = [];
    const headerCells = table.querySelectorAll('thead th, tr:first-child th');
    for (const th of headerCells) {
      headers.push((th.textContent ?? '').replace(/\s+/g, ' ').trim());
    }
    const rows: string[][] = [];
    for (const tr of table.querySelectorAll('tbody tr, tr')) {
      const cells: string[] = [];
      for (const cell of tr.querySelectorAll('td, th')) {
        cells.push((cell.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 500));
      }
      if (cells.length > 0 && !(cells.length === headers.length && cells.every((c, i) => c === headers[i]))) {
        rows.push(cells);
      }
    }
    if (rows.length === 0 && headers.length === 0) continue;
    const caption = table.querySelector('caption')?.textContent?.trim() || undefined;
    tables.push({ headers, rows: rows.slice(0, 100), caption });
  }
  return tables.slice(0, 50);
}
