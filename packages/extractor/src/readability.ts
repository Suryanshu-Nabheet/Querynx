/**
 * Main-content extraction built on Mozilla Readability.
 *
 * linkedom provides a lightweight DOM implementation for server-side
 * parsing without a full browser. Content from the web is untrusted:
 * the extractor never evaluates scripts and treats all text as data.
 */

import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

export interface ReadabilityResult {
  /** Extracted main-content HTML. */
  content: string;
  /** Document title. */
  title: string | undefined;
  /** Extracted plain text of main content. */
  text: string;
  /** Inferred author. */
  author: string | undefined;
  /** Site name. */
  siteName: string | undefined;
  /** Published time, ISO 8601 when parseable. */
  publishedTime: string | undefined;
  /** Excerpt. */
  excerpt: string | undefined;
  /** Detected language. */
  lang: string | undefined;
}

/**
 * Run Readability over an HTML document.
 * Returns null when no main content could be identified.
 */
export function extractWithReadability(html: string, url: string): ReadabilityResult | null {
  const dom = parseHTML(html);
  const document = dom.document;

  // Readability mutates the DOM; clone defensively.
  const article = new Readability(document.cloneNode(true) as Document, {
    // Keep charThreshold low so short technical notes still extract.
    charThreshold: 140,
  }).parse();

  if (!article || !article.content) return null;

  const text = htmlToText(article.content);

  return {
    content: article.content,
    title: article.title ?? undefined,
    text,
    author: article.byline ?? undefined,
    siteName: article.siteName ?? undefined,
    publishedTime: normalizeIsoDate(article.publishedTime),
    excerpt: article.excerpt ?? undefined,
    lang: document.documentElement?.getAttribute('lang') ?? undefined,
    ...(url ? {} : {}),
  };
}

/** Strip tags and collapse whitespace. */
export function htmlToText(html: string): string {
  const dom = parseHTML(html);
  const text = dom.document.documentElement?.textContent ?? '';
  return text.replace(/\s+/g, ' ').trim();
}

/** Coerce assorted date formats to ISO 8601 or undefined. */
export function normalizeIsoDate(input: string | undefined | null): string | undefined {
  if (!input) return undefined;
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}
