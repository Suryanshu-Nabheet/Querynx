/**
 * Content extraction and document-intelligence types.
 */

/** Output formats the extraction pipeline can produce. */
export type ExtractFormat = "markdown" | "html" | "text";

/** A request to extract structured content from one or more URLs. */
export interface ExtractRequest {
  /** Absolute URLs to fetch and extract. */
  urls: readonly string[];
  /** Output format for the main content. */
  format?: ExtractFormat;
  /** Include full-page Markdown structure (headings, lists, tables). */
  includeMarkdown?: boolean;
  /** Include outbound link inventory. */
  includeLinks?: boolean;
  /** Include extracted tables. */
  includeTables?: boolean;
  /** Include JSON-LD and Open Graph metadata. */
  includeMetadata?: boolean;
  /** Maximum content characters to return (protects against bombs). */
  maxContentLength?: number;
  /** Per-URL timeout in milliseconds. */
  timeoutMs?: number;
}

/** One heading in the document outline. */
export interface DocumentHeading {
  /** Heading level, 1-6. */
  level: number;
  /** Heading text. */
  text: string;
  /** Anchor id when present in the source. */
  id?: string;
}

/** One outbound link. */
export interface DocumentLink {
  /** Absolute link target. */
  url: string;
  /** Link text. */
  text: string;
  /** Whether the link targets a different domain than the page. */
  external: boolean;
  /** Whether the link is marked rel="nofollow". */
  nofollow?: boolean;
}

/** One extracted table. */
export interface DocumentTable {
  /** Header row cells. */
  headers: readonly string[];
  /** Data rows. */
  rows: readonly (readonly string[])[];
  /** Table caption when present. */
  caption?: string;
}

/** A semantic section of the document (heading + its content). */
export interface DocumentSection {
  /** Section title derived from the nearest preceding heading. */
  title: string;
  /** Section body text. */
  content: string;
  /** Character offsets [start, end) within the full text. */
  offsets: readonly [number, number];
}

/** Metadata distilled from JSON-LD, Open Graph and meta tags. */
export interface DocumentMetadata {
  /** Canonical URL declared by the page. */
  canonicalUrl?: string;
  /** Site name from OG. */
  siteName?: string;
  /** Document description. */
  description?: string;
  /** Inferred author. */
  author?: string;
  /** Inferred publication date (ISO 8601). */
  publishedAt?: string;
  /** Inferred modification date (ISO 8601). */
  modifiedAt?: string;
  /** Detected BCP-47 language tag. */
  language?: string;
  /** og:type value. */
  ogType?: string;
  /** Open Graph image. */
  ogImage?: string;
  /** Aggregated JSON-LD graph objects, when present. */
  jsonLd?: ReadonlyArray<Record<string, unknown>>;
  /** Open Graph key-value pairs. */
  openGraph?: Readonly<Record<string, string>>;
  /** Any other meta tags worth surfacing. */
  meta?: Readonly<Record<string, string>>;
}

/** A fully extracted document. */
export interface ExtractedDocument {
  /** Final absolute URL after redirects. */
  url: string;
  /** Document title. */
  title?: string;
  /** Main content in the requested format. */
  content: string;
  /** The format actually produced. */
  format: ExtractFormat;
  /** Distilled metadata. */
  metadata?: DocumentMetadata;
  /** Document outline. */
  headings: readonly DocumentHeading[];
  /** Outbound link inventory. */
  links: readonly DocumentLink[];
  /** Extracted tables. */
  tables: readonly DocumentTable[];
  /** Semantic sections. */
  sections: readonly DocumentSection[];
  /** SHA-256 fingerprint of normalized main content. */
  fingerprint: string;
  /** SHA-256 fingerprint of the raw HTML (for change detection). */
  rawFingerprint?: string;
  /** HTTP status of the underlying fetch. */
  statusCode: number;
  /** Retrieval timestamp (ISO 8601). */
  fetchedAt: string;
  /** Number of characters of raw HTML fetched. */
  rawBytes?: number;
  /** Extractor warnings, e.g. truncation notices. */
  warnings: readonly string[];
}

/** Result for a single URL in an extraction batch. */
export interface ExtractResultItem {
  url: string;
  ok: boolean;
  document?: ExtractedDocument;
  error?: string;
}

/** A complete extraction response. */
export interface ExtractResponse {
  results: ExtractResultItem[];
  generatedAt: string;
  requestId?: string;
}
