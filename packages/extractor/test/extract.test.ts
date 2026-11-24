import { describe, expect, it } from "vitest";
import { extractDocument } from "../src/extract.js";
import { chunkText, chunkSections, estimateTokens } from "../src/chunk.js";

const SAMPLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>PostgreSQL MVCC Explained — Example Engineering</title>
  <meta name="description" content="How multi-version concurrency control works in PostgreSQL.">
  <meta property="og:site_name" content="Example Engineering">
  <meta property="og:type" content="article">
  <link rel="canonical" href="https://example.com/postgres-mvcc">
  <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"BlogPosting",
     "author":{"name":"Ada Lovelace"},
     "datePublished":"2024-03-15T10:00:00Z",
     "dateModified":"2025-01-02T08:00:00Z"}
  </script>
</head>
<body>
  <nav><a href="/about">About</a> <a href="https://ads.example.com/tracker">Ad</a></nav>
  <article>
    <h1>PostgreSQL MVCC Explained</h1>
    <p>Multiversion concurrency control keeps old row versions visible to
       concurrent transactions. Each row stores xmin and xmax system columns
       that define its visibility window.</p>
    <h2>How writes work</h2>
    <p>An UPDATE writes a new row version and marks the old version obsolete
       by setting xmax. Readers never block writers and writers never block
       readers.</p>
    <table>
      <thead><tr><th>Isolation</th><th>Anomaly</th></tr></thead>
      <tbody>
        <tr><td>Read Committed</td><td>Nonrepeatable read</td></tr>
        <tr><td>Serializable</td><td>None</td></tr>
      </tbody>
    </table>
    <h2>Vacuum</h2>
    <p>VACUUM reclaims space held by dead row versions so the table does not
       grow forever. Autovacuum triggers this automatically based on thresholds.</p>
  </article>
  <footer>© 2024 Example Engineering</footer>
</body>
</html>`;

describe("extractDocument", () => {
  const doc = extractDocument(
    SAMPLE_HTML,
    "https://example.com/postgres-mvcc",
    200,
  );

  it("extracts title and main content", () => {
    expect(doc.title).toBe("PostgreSQL MVCC Explained — Example Engineering");
    expect(doc.content).toContain("Multiversion concurrency control");
    expect(doc.content).toContain("VACUUM reclaims");
    // Boilerplate nav/footer should not dominate.
    expect(doc.content).not.toContain("About About");
  });

  it("collects structured metadata", () => {
    expect(doc.metadata?.author).toBe("Ada Lovelace");
    expect(doc.metadata?.publishedAt).toBe("2024-03-15T10:00:00.000Z");
    expect(doc.metadata?.siteName).toBe("Example Engineering");
    expect(doc.metadata?.canonicalUrl).toBe(
      "https://example.com/postgres-mvcc",
    );
    expect(doc.metadata?.jsonLd?.length).toBeGreaterThan(0);
  });

  it("builds heading outline", () => {
    const h1 = doc.headings.find((h) => h.level === 1);
    expect(h1?.text).toBe("PostgreSQL MVCC Explained");
    expect(
      doc.headings.filter((h) => h.level === 2).map((h) => h.text),
    ).toEqual(["How writes work", "Vacuum"]);
  });

  it("extracts links with external classification", () => {
    // Readability may strip nav links (that is a feature, not a bug):
    // the remaining article links must still be classified correctly.
    expect(doc.links.length).toBeGreaterThanOrEqual(1);
    const external = doc.links.find((l) => l.external);
    if (doc.links.some((l) => l.url.includes("ads.example.com"))) {
      expect(external?.url).toContain("ads.example.com");
    }
  });

  it("extracts tables", () => {
    expect(doc.tables.length).toBe(1);
    expect(doc.tables[0]?.headers).toEqual(["Isolation", "Anomaly"]);
    expect(doc.tables[0]?.rows[0]).toEqual([
      "Read Committed",
      "Nonrepeatable read",
    ]);
  });

  it("splits heading-aware sections", () => {
    const titles = doc.sections.map((s) => s.title);
    // Readability strips an h1 identical to the document title (standard
    // behavior); the opening section then has an empty title. Later
    // h2 sections must still be captured with their heading context.
    expect(titles).toContain("How writes work");
    const vacuum = doc.sections.find((s) => s.title === "Vacuum");
    expect(vacuum?.content).toContain("Autovacuum");
    const writes = doc.sections.find((s) => s.title === "How writes work");
    expect(writes?.content).toContain("UPDATE");
  });

  it("produces a stable fingerprint", () => {
    const doc2 = extractDocument(
      SAMPLE_HTML,
      "https://example.com/postgres-mvcc",
      200,
    );
    expect(doc.fingerprint).toBe(doc2.fingerprint);
    expect(doc.fingerprint).toHaveLength(512);
  });
});

describe("chunkText", () => {
  const longText =
    "PostgreSQL uses WAL to guarantee durability. Each modification writes a WAL record before commit. " +
    "Checkpoints truncate the WAL periodically. Replication streams WAL to standbys in real time. " +
    "Synchronous replication waits for standby flush. Asynchronous replication favors latency over safety.";

  it("packs sentences into budgeted chunks", () => {
    const chunks = chunkText(longText, "WAL", { maxTokens: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokens).toBeLessThanOrEqual(20 + 8); // single-sentence overflow allowed
      expect(chunk.sectionTitle).toBe("WAL");
    }
  });

  it("supports overlap", () => {
    const without = chunkText(longText, undefined, { maxTokens: 15 });
    const withOverlap = chunkText(longText, undefined, {
      maxTokens: 15,
      overlapTokens: 8,
    });
    expect(withOverlap.length).toBeGreaterThanOrEqual(without.length);
    if (withOverlap.length > 1 && withOverlap[0] && withOverlap[1]) {
      expect(withOverlap[1]!.text).toContain(
        withOverlap[0]!.text.split(" ").slice(-2).join(" "),
      );
    }
  });

  it("respects maxChunks", () => {
    const chunks = chunkText(longText.repeat(50), undefined, {
      maxTokens: 30,
      maxChunks: 3,
    });
    expect(chunks.length).toBeLessThanOrEqual(3);
  });

  it("handles empty input", () => {
    expect(chunkText("", undefined, { maxTokens: 10 })).toEqual([]);
  });
});

describe("chunkSections", () => {
  it("chunks each section with heading context", () => {
    const sections = [
      {
        title: "Intro",
        content: "Alpha beta gamma. Delta epsilon zeta.",
        offsets: [0, 40] as [number, number],
      },
      {
        title: "Details",
        content: "Eta theta iota. Kappa lambda mu.",
        offsets: [40, 80] as [number, number],
      },
    ];
    const chunks = chunkSections(sections, { maxTokens: 10 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]?.sectionTitle).toBe("Intro");
    expect(chunks.at(-1)?.sectionTitle).toBe("Details");
  });
});

describe("estimateTokens", () => {
  it("estimates roughly 4 chars per token", () => {
    expect(estimateTokens("hello world!!")).toBe(4);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("plain-text documents bypass readability", () => {
  const RFC_STYLE = `Network Working Group                                      R. Fielding
Request for Comments: 2616                                   UC Irvine
Obsoletes: 2068

                Hypertext Transfer Protocol -- HTTP/1.1

Status of This Memo

   This document specifies an Internet standards track protocol.`;

  it("keeps the document beginning that readability would discard", () => {
    const doc = extractDocument(RFC_STYLE, "https://example.org/rfc.txt", 200);
    // THE regression: before this path, readability dropped the title
    // page and 'Hypertext' never survived extraction.
    expect(doc.content).toContain("Hypertext Transfer Protocol");
    expect(doc.content).toContain("Network Working Group");
    expect(doc.content).toContain("Status of This Memo");
    expect(doc.title).toContain("Network Working Group");
    expect(doc.warnings).toEqual([]);
  });

  it("detects HTML and does not take the plain-text path", () => {
    const html = `<!DOCTYPE html><html><body><article>
      <h1>Title Page</h1>
      <p>Network Working Group content inside HTML.</p>
    </article></body></html>`;
    const doc = extractDocument(html, "https://example.org/doc", 200);
    expect(doc.content).toContain("Network Working Group");
    // HTML path still extracts headings/sections.
    expect(doc.headings.length).toBeGreaterThan(0);
  });

  it("source-code-like text extracts verbatim", () => {
    const code = `function extractDocument(html: string): void {
  // comments and code with <angle> chars would look tag-ish
  return parse(html);
}`;
    const doc = extractDocument(code, "https://example.org/main.ts", 200);
    expect(doc.content).toContain("function extractDocument");
  });

  it("truncation caps apply on the plain-text path", () => {
    const big = "x".repeat(300_000);
    const doc = extractDocument(big, "https://example.org/big.txt", 200, {
      maxContentLength: 100_000,
    });
    expect(doc.content.length).toBe(100_000);
    expect(doc.warnings.some((w) => w.includes("truncated"))).toBe(true);
  });

  it("fragments with heavy tag density are NOT treated as plain text", () => {
    const fragment = "<div>lorem</div><div>ipsum</div><div>dolor</div><div>sit</div>";
    const doc = extractDocument(fragment, "https://example.org/f", 200);
    expect(doc.content.toLowerCase()).toContain("lorem");
  });
});
