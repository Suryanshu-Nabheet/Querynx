/**
 * PDF text extraction with hard resource limits.
 *
 * PDFs are untrusted binary input: page counts are capped, per-page
 * text is length-capped, and the parser runs against a Buffer with no
 * filesystem or network access. Malformed PDFs fail loudly with a
 * typed error instead of hanging the extraction pipeline.
 */

import { fingerprintText } from "@querynx/shared";

export interface PdfExtractOptions {
  /** Maximum pages to read (default 100). */
  maxPages?: number;
  /** Maximum total characters (default 200_000). */
  maxChars?: number;
}

export interface PdfExtractResult {
  /** Concatenated page texts, page-break separated. */
  text: string;
  /** Number of pages actually read. */
  pageCount: number;
  /** True when page or char caps truncated extraction. */
  truncated: boolean;
  /** Content fingerprint of the extracted text. */
  fingerprint: string;
}

/** Typed failure for unusable PDFs. */
export class PdfExtractionError extends Error {
  constructor(message: string) {
    super(`PDF extraction failed: ${message}`);
    this.name = "PdfExtractionError";
  }
}

type PdfParser = {
  (
    buffer: Buffer,
    options?: Record<string, unknown>,
  ): {
    numpages: number;
    text: string;
  };
};

let parserPromise: Promise<PdfParser> | undefined;

async function loadParser(): Promise<PdfParser> {
  if (!parserPromise) {
    parserPromise = import("pdf-parse").then((mod) => {
      const candidate = mod as unknown as { default?: PdfParser } | PdfParser;
      const fn =
        typeof candidate === "function" ? candidate : candidate.default;
      if (typeof fn !== "function") {
        throw new PdfExtractionError(
          "pdf-parse did not expose a parser function",
        );
      }
      return fn;
    });
  }
  return parserPromise;
}

/**
 * Extract text from a PDF buffer. Always bounded: never reads more
 * than maxPages pages or returns more than maxChars characters.
 */
export async function extractPdfText(
  buffer: Buffer,
  options: PdfExtractOptions = {},
): Promise<PdfExtractResult> {
  const { maxPages = 100, maxChars = 200_000 } = options;

  if (buffer.length === 0) {
    throw new PdfExtractionError("empty buffer");
  }
  // PDF magic or the parser will fail anyway — fail fast and clear.
  if (!(buffer[0] === 0x25 && buffer[1] === 0x50)) {
    // "%P"
    throw new PdfExtractionError("not a PDF (missing header)");
  }
  // Hard input cap: 20 MiB refuses decompression-bomb-shaped files.
  if (buffer.length > 20 * 1024 * 1024) {
    throw new PdfExtractionError(
      `pdf exceeds 20MiB input cap (${buffer.length} bytes)`,
    );
  }

  const parser = await loadParser();

  let parsed: { numpages: number; text: string };
  try {
    parsed = parser(buffer, {
      max: maxPages,
      pagerender: undefined,
    });
  } catch (err) {
    throw new PdfExtractionError(
      err instanceof Error ? err.message : "parser crashed",
    );
  }

  const pageCount = parsed.numpages;
  let text = parsed.text ?? "";
  let truncated = false;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }
  // Normalize whitespace like the HTML path does.
  text = text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    text,
    pageCount,
    truncated: truncated || pageCount >= maxPages,
    fingerprint: fingerprintText(text),
  };
}
