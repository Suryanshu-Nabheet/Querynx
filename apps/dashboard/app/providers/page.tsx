"use client";

import { useEffect, useState } from "react";
import ConnectionBar from "../../components/ConnectionBar";
import { apiGet, type ProvidersResponseView } from "../../lib/api";

export default function ProvidersPage() {
  const [providers, setProviders] = useState<
    Array<{
      name: string;
      state: string;
      configured: boolean;
      successRate: number;
      medianLatencyMs: number;
    }>
  >([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const { providers } =
        await apiGet<ProvidersResponseView>("/v1/providers");
      setProviders(
        providers.map((p) => ({
          name: p.name,
          state: p.state,
          configured: p.configured,
          successRate: p.successRate,
          medianLatencyMs: p.medianLatencyMs,
        })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "unreachable");
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <div>
      <h1>Providers</h1>
      <p className="sub">
        Search backend health: circuit-breaker state, success rate and latency
      </p>
      <ConnectionBar />

      {error && <p className="error">{error}</p>}
      {loading && <p>Loading…</p>}

      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>State</th>
              <th>Configured</th>
              <th>Success rate</th>
              <th>P50 latency</th>
            </tr>
          </thead>
          <tbody>
            {providers.map((p) => (
              <tr key={p.name}>
                <td>{p.name}</td>
                <td>
                  <span
                    className={`badge ${p.state === "closed" ? "ok" : p.state === "open" ? "bad" : "warn"}`}
                  >
                    {p.state}
                  </span>
                </td>
                <td>{p.configured ? "yes" : "no"}</td>
                <td>{(p.successRate * 100).toFixed(0)}%</td>
                <td>{p.medianLatencyMs}ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        <button className="secondary" onClick={() => void load()}>
          Refresh
        </button>
      </p>
    </div>
  );
}
