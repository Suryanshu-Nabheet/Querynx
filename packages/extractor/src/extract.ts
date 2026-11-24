/**
 * The full-document extraction pipeline: HTML in, ExtractedDocument out.
 */

import type {
  ExtractedDocument,
  DocumentSection,
  ExtractFormat,
} from "@querynx/types";
import { fingerprintText } from "@querynx/shared";
import {
  extractWithReadability,
  htmlToText,
  normalizeIsoDate,
} from "./readability.js";
import {
  extractHeadings,
  extractJsonLd,
  extractLinks,
  extractMetaTags,
  extractTables,
} from "./metadata.js";
import { parseHTML } from "linkedom";

export interface ExtractOptions {
  /** Output format for main content. */
  format?: ExtractFormat;
  /** Cap on returned content characters. */
  maxContentLength?: number;
  /** Include link inventory. */
  includeLinks?: boolean;
  /** Include tables. */
  includeTables?: boolean;
  /** Include metadata. */
  includeMetadata?: boolean;
}

const DEFAULT_MAX_CONTENT = 200_000;

/** Split main-content text into sections at heading boundaries. */
export function splitSections(contentHtml: string): DocumentSection[] {
  const dom = parseHTML(`<html><body>${contentHtml}</body></html>`);
  const body = dom.document.body;
  if (!body) return [];

  const sections: DocumentSection[] = [];
  let currentTitle = "";
  let currentParts: string[] = [];
  let start = 0;
  let cursor = 0;

  const flush = () => {
    const content = currentParts.join(" ").replace(/\s+/g, " ").trim();
    if (content) {
      sections.push({ title: currentTitle, content, offsets: [start, cursor] });
    }
    currentParts = [];
  };

  const walk = (node: ChildNode | null, depth = 0) => {
    if (!node || depth > 60) return;
    if (node.nodeType === 3) {
      const text = node.textContent ?? "";
      currentParts.push(text);
      cursor += text.length;
      // Continue along siblings; a text node never has children.
      walk(node.nextSibling, depth + 1);
      return;
    }
    if (node.nodeType !== 1) {
      walk(node.firstChild, depth + 1);
      walk(node.nextSibling, depth + 1);
      return;
    }
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (/^H[1-6]$/.test(tag)) {
      flush();
      currentTitle = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      start = cursor;
      // Continue past the heading so following content is captured.
      walk(el.nextSibling, depth + 1);
      return;
    }
    walk(el.firstChild, depth + 1);
    walk(el.nextSibling, depth + 1);
  };

  walk(body.firstChild);
  flush();
  return sections;
}

/**
 * Extract a complete document from raw HTML.
 *
 * @param html Raw HTML response body
 * @param url Final absolute URL after redirects
 * @param statusCode HTTP status of the fetch
 */
export function extractDocument(
  html: string,
  url: string,
  statusCode: number,
  options: ExtractOptions = {},
): ExtractedDocument {
  const {
    format = "markdown",
    maxContentLength = DEFAULT_MAX_CONTENT,
    includeLinks = true,
    includeTables = true,
    includeMetadata = true,
  } = options;

  const warnings: string[] = [];
  const dom = parseHTML(html);
  const document = dom.document;

  const readability = extractWithReadability(html, url);

  // Title precedence: Readability > og:title > <title>.
  const meta = includeMetadata ? extractMetaTags(document) : {};
  const title =
    readability?.title ??
    meta["og:title"] ??
    document.querySelector("title")?.textContent?.trim() ??
    undefined;

  // Main content: Readability text, falling back to body text.
  let content = readability?.text ?? htmlToText(html);
  if (!content) {
    content = htmlToText(html);
    warnings.push("readability-extraction-failed");
  }

  if (content.length > maxContentLength) {
    content = content.slice(0, maxContentLength);
    warnings.push(`content-truncated-at-${maxContentLength}-chars`);
  }

  const sections = readability?.content
    ? splitSections(readability.content)
    : [
        {
          title: title ?? "",
          content,
          offsets: [0, content.length] as [number, number],
        },
      ];

  // Metadata assembly from all sources.
  let documentMeta: ExtractedDocument["metadata"];
  if (includeMetadata) {
    const canonical = document
      .querySelector('link[rel="canonical"]')
      ?.getAttribute("href");
    let canonicalUrl: string | undefined;
    if (canonical) {
      try {
        canonicalUrl = new URL(canonical, url).toString();
      } catch {
        canonicalUrl = undefined;
      }
    }
    const jsonLd = extractJsonLd(document);
    const openGraph: Record<string, string> = {};
    for (const [k, v] of Object.entries(meta)) {
      if (k.startsWith("og:")) openGraph[k] = v;
    }
    documentMeta = {
      canonicalUrl,
      siteName: readability?.siteName ?? meta["og:site_name"],
      description: readability?.excerpt ?? meta["description"],
      author: readability?.author ?? meta["author"] ?? jsonLdAuthor(jsonLd),
      publishedAt:
        readability?.publishedTime ??
        normalizeIsoDate(meta["article:published_time"] ?? meta["date"]) ??
        jsonLdDate(jsonLd, "datePublished"),
      modifiedAt:
        normalizeIsoDate(meta["article:modified_time"]) ??
        jsonLdDate(jsonLd, "dateModified"),
      language:
        readability?.lang ??
        document.documentElement?.getAttribute("lang") ??
        undefined,
      ogType: meta["og:type"],
      ogImage: meta["og:image"],
      jsonLd: jsonLd.length > 0 ? jsonLd : undefined,
      openGraph: Object.keys(openGraph).length > 0 ? openGraph : undefined,
      meta,
    };
  }

  return {
    url,
    title,
    content,
    format,
    metadata: documentMeta,
    headings: extractHeadings(document),
    links: includeLinks ? extractLinks(document, url) : [],
    tables: includeTables ? extractTables(document) : [],
    sections,
    fingerprint: fingerprintText(content),
    rawFingerprint: undefined,
    statusCode,
    fetchedAt: new Date().toISOString(),
    rawBytes: html.length,
    warnings,
  };
}

function jsonLdAuthor(
  jsonLd: ReadonlyArray<Record<string, unknown>>,
): string | undefined {
  for (const node of jsonLd) {
    const author = node["author"];
    if (typeof author === "string") return author;
    if (Array.isArray(author) && author.length > 0) {
      const first = author[0];
      if (first && typeof first === "object" && "name" in first) {
        const name = (first as Record<string, unknown>)["name"];
        if (typeof name === "string") return name;
      }
    }
    if (author && typeof author === "object" && "name" in author) {
      const name = (author as Record<string, unknown>)["name"];
      if (typeof name === "string") return name;
    }
  }
  return undefined;
}

function jsonLdDate(
  jsonLd: ReadonlyArray<Record<string, unknown>>,
  key: string,
): string | undefined {
  for (const node of jsonLd) {
    const value = node[key];
    if (typeof value === "string") return normalizeIsoDate(value);
  }
  return undefined;
}
