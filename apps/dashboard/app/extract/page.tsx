"use client";

import { useState } from "react";
import ConnectionBar from "../../components/ConnectionBar";
import { apiPost, type ExtractItemView } from "../../lib/api";

interface ExtractItem {
  url: string;
  ok: boolean;
  title?: string;
  content?: string;
  error?: string;
  author?: string;
  publishedAt?: string;
}

export default function ExtractPage() {
  const [urls, setUrls] = useState("");
  const [results, setResults] = useState<ExtractItem[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const run = async () => {
    const list = urls
      .split(/\s+/)
      .map((u) => u.trim())
      .filter(Boolean)
      .slice(0, 10);
    if (list.length === 0) return;
    setLoading(true);
    setError("");
    setResults([]);
    try {
      const response = await apiPost<{ results: ExtractItemView[] }>(
        "/v1/extract",
        { urls: list },
      );
      setResults(
        response.results.map((r) => ({
          url: r.url,
          ok: r.ok,
          title: r.document?.title,
          content: r.document?.content,
          error: r.error,
          author: r.document?.metadata?.author,
          publishedAt: r.document?.metadata?.publishedAt,
        })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "extraction failed");
    }
    setLoading(false);
  };

  return (
    <div>
      <h1>Extraction playground</h1>
      <p className="sub">
        Clean content, metadata, tables and links from any page (max 10 URLs)
      </p>
      <ConnectionBar />

      <div className="panel">
        <textarea
          rows={3}
          value={urls}
          onChange={(e) => setUrls(e.target.value)}
          placeholder="https://example.com/article"
          aria-label="URLs to extract"
        />
        <p>
          <button onClick={() => void run()} disabled={loading || !urls.trim()}>
            {loading ? "Extracting…" : "Extract"}
          </button>
        </p>
      </div>

      {error && <p className="error">{error}</p>}

      {results.map((r) => (
        <div className="panel" key={r.url}>
          {r.ok ? (
            <>
              <div className="title" style={{ fontWeight: 700 }}>
                {r.title ?? r.url}
              </div>
              <a href={r.url} style={{ color: "var(--accent)", fontSize: 12 }}>
                {r.url}
              </a>
              {(r.author || r.publishedAt) && (
                <p className="sub">
                  {r.author ? `by ${r.author} ` : ""}
                  {r.publishedAt ? `· ${r.publishedAt.slice(0, 10)}` : ""}
                </p>
              )}
              <pre className="evidence">{(r.content ?? "").slice(0, 5000)}</pre>
            </>
          ) : (
            <p className="error">
              FAILED {r.url}: {r.error}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
