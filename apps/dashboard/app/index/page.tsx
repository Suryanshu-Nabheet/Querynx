"use client";

import { useEffect, useState } from "react";
import ConnectionBar from "../../components/ConnectionBar";
import {
  getStoredConnection,
  apiGet,
  apiPost,
  type IndexStatsView,
  type SemanticResponseView,
} from "../../lib/api";

interface IndexStats {
  documents: number;
  collections: number;
  uniqueTerms: number;
  contentChars: number;
}

interface SemanticHit {
  title: string;
  url: string;
  snippet: string;
  score: number;
  matchedTerms: string[];
  collection: string;
}

export default function IndexPage() {
  const [stats, setStats] = useState<IndexStats | null>(null);
  const [query, setQuery] = useState("");
  const [collection, setCollection] = useState("");
  const [hits, setHits] = useState<SemanticHit[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const loadStats = async () => {
    try {
      const body = await apiGet<IndexStatsView>("/v1/index/stats");
      setStats(body.stats);
    } catch {
      /* optional */
    }
  };

  useEffect(() => {
    void loadStats();
  }, []);

  const search = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError("");
    setHits([]);
    try {
      const body = await apiPost<SemanticResponseView>("/v1/search/semantic", {
        query,
        ...(collection ? { collection } : {}),
        limit: 10,
      });
      setHits(body.results);
    } catch (err) {
      setError(err instanceof Error ? err.message : "semantic search failed");
    }
    setLoading(false);
  };

  return (
    <div>
      <h1>Local index</h1>
      <p className="sub">
        Querynx&apos;s native BM25 corpus — search what you have indexed
      </p>
      <ConnectionBar />

      {stats && (
        <div className="grid">
          <div className="panel stat">
            <div className="label">DOCUMENTS</div>
            <div className="value">{stats.documents}</div>
          </div>
          <div className="panel stat">
            <div className="label">COLLECTIONS</div>
            <div className="value">{stats.collections}</div>
          </div>
          <div className="panel stat">
            <div className="label">UNIQUE TERMS</div>
            <div className="value">{stats.uniqueTerms}</div>
          </div>
          <div className="panel stat">
            <div className="label">CONTENT CHARS</div>
            <div className="value">{stats.contentChars.toLocaleString()}</div>
          </div>
        </div>
      )}

      <h2>Corpus search (BM25)</h2>
      <div className="panel">
        <div style={{ display: "flex", gap: 10 }}>
          <input
            style={{ flex: 1 }}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void search()}
            placeholder="Search the indexed corpus…"
            aria-label="Corpus query"
          />
          <input
            style={{ width: 160 }}
            value={collection}
            onChange={(e) => setCollection(e.target.value)}
            placeholder="collection (optional)"
            aria-label="Collection filter"
          />
          <button
            onClick={() => void search()}
            disabled={loading || !query.trim()}
          >
            {loading ? "Searching…" : "Search"}
          </button>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      {hits.length > 0 && (
        <div className="panel">
          {hits.map((h) => (
            <div className="result" key={h.url}>
              <div className="title">{h.title}</div>
              <a href={h.url} target="_blank" rel="noopener noreferrer">
                {h.url}
              </a>
              <div className="snippet">{h.snippet}</div>
              <span className="score">score {h.score.toFixed(3)}</span>{" "}
              <span className="badge">{h.collection}</span>{" "}
              {h.matchedTerms.length > 0 && (
                <span className="badge ok">
                  matched: {h.matchedTerms.slice(0, 5).join(", ")}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
