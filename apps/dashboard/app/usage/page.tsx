'use client';

import { useEffect, useState } from 'react';
import ConnectionBar from '../../components/ConnectionBar';
import { apiGet, getStoredConnection } from '../../lib/api';

interface UsageSummary {
  usage: {
    totalRequests: number;
    byRoute: Record<string, number>;
    p95DurationMs: number;
  };
  persistent: boolean;
  error?: string;
}

export default function UsagePage() {
  const [data, setData] = useState<UsageSummary | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      setData(await apiGet<UsageSummary>('/v1/usage'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unreachable');
    }
    setLoading(false);
  };

  useEffect(() => { void load(); }, []);

  const routes = data
    ? Object.entries(data.usage.byRoute).sort((a, b) => b[1] - a[1])
    : [];
  const maxRouteCount = routes.length > 0 ? Math.max(...routes.map(([, c]) => c)) : 1;

  return (
    <div>
      <h1>Usage analytics</h1>
      <p className="sub">Last 24 hours of request accounting (Postgres-backed; zero in memory mode)</p>
      <ConnectionBar />

      {loading && <p>Loading…</p>}
      {error && <p className="error">{error}</p>}

      {data && !error && (
        <>
          <div className="grid">
            <div className="panel stat">
              <div className="label">REQUESTS (24H)</div>
              <div className="value">{data.usage.totalRequests}</div>
            </div>
            <div className="panel stat">
              <div className="label">P95 LATENCY</div>
              <div className="value">{data.usage.p95DurationMs}ms</div>
            </div>
            <div className="panel stat">
              <div className="label">ACCOUNTING</div>
              <div className="value">
                {data.persistent ? (
                  <span className="badge ok">persistent</span>
                ) : (
                  <span className="badge warn">in-memory</span>
                )}
              </div>
              <div className="label">
                {data.persistent ? 'Postgres usage_events' : 'set DATABASE_URL for durable accounting'}
              </div>
            </div>
          </div>

          {data.error && <p className="error">usage query failed: {data.error}</p>}

          <h2>By route</h2>
          <div className="panel">
            {routes.length === 0 ? (
              <p className="sub">No recorded requests in the window.</p>
            ) : (
              <table>
                <thead>
                  <tr><th>Route</th><th>Requests</th><th>Share</th></tr>
                </thead>
                <tbody>
                  {routes.map(([route, count]) => (
                    <tr key={route}>
                      <td>{route}</td>
                      <td>{count}</td>
                      <td>
                        <span style={{ display: 'inline-block', width: `${(count / maxRouteCount) * 100}%`, minWidth: 4, height: 8, background: 'var(--accent)', borderRadius: 2 }} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <p><button className="secondary" onClick={() => void load()}>Refresh</button></p>
        </>
      )}
    </div>
  );
}
