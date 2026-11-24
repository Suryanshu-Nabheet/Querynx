'use client';

import { useState } from 'react';
import ConnectionBar from '../../components/ConnectionBar';

import { apiPost, type SearchResponseView } from '../../lib/api';

export default function SearchPage() {
  const [query, setQuery] = useState('');
  const [maxResults, setMaxResults] = useState(10);
  const [freshness, setFreshness] = useState('any');
  const [response, setResponse] = useState<SearchResponseView | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const run = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError('');
    setResponse(null);
    try {
      const r = await apiPost<SearchResponseView>('/v1/search', {
        query,
        maxResults,
        ...(freshness !== 'any' ? { freshness } : {}),
      });
      setResponse(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'search failed');
    }
    setLoading(false);
  };

  return (
    <div>
      <h1>Search playground</h1>
      <p className="sub">Federated multi-provider search with RRF merge and dedupe</p>
      <ConnectionBar />

      <div className="panel">
        <div style={{ display: 'flex', gap: 10 }}>
          <input
            style={{ flex: 1 }}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void run()}
            placeholder="Search the web…"
            aria-label="Search query"
          />
          <select value={freshness} onChange={(e) => setFreshness(e.target.value)} style={{ width: 120 }} aria-label="Freshness">
            <option value="any">any time</option>
            <option value="day">past day</option>
            <option value="week">past week</option>
            <option value="month">past month</option>
            <option value="year">past year</option>
          </select>
          <input
            type="number"
            min={1}
            max={50}
            value={maxResults}
            onChange={(e) => setMaxResults(Number(e.target.value) || 10)}
            style={{ width: 80 }}
            aria-label="Max results"
          />
          <button onClick={() => void run()} disabled={loading || !query.trim()}>
            {loading ? 'Searching…' : 'Search'}
          </button>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      {response && (
        <>
          <h2>
            {response.results.length} results · {response.diagnostics.providersSucceeded}/
            {response.diagnostics.providersQueried} providers · {response.diagnostics.duplicateCount} dupes removed
          </h2>
          <div className="panel">
            {response.results.map((r) => (
              <div className="result" key={r.url}>
                <div className="title">{r.title}</div>
                <a href={r.url} target="_blank" rel="noopener noreferrer">{r.url}</a>
                <div className="snippet">{r.snippet}</div>
                <span className="score">score {r.score.toFixed(4)}</span>{' '}
                <span className="badge">{r.provider}</span>
                {r.metadata && 'providers' in (r.metadata as Record<string, unknown>) && (
                  <span className="badge ok">corroborated ×{(r.metadata as { providers: string[] }).providers.length}</span>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
