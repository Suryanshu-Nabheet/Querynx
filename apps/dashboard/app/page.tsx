"use client";

import { useEffect, useState } from "react";
import ConnectionBar from "../components/ConnectionBar";
import {
  apiGet,
  type ProvidersResponseView,
  type IndexStatsView,
  getStoredConnection,
} from "../lib/api";

interface Overview {
  health: { status: string; version: string };
  providers: ProvidersResponseView["providers"];
  cache: {
    size: number;
    hits: number;
    misses: number;
    stampedesPrevented: number;
    hitRate: number;
  };
  indexStats?: IndexStatsView["stats"];
  error?: string;
}

export default function OverviewPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const next: Overview = {
      health: { status: "unknown", version: "" },
      providers: [],
      cache: { size: 0, hits: 0, misses: 0, stampedesPrevented: 0, hitRate: 0 },
    };
    try {
      next.health = await apiGet<Overview["health"]>("/health");
    } catch (err) {
      next.error = err instanceof Error ? err.message : "unreachable";
      setData(next);
      setLoading(false);
      return;
    }
    try {
      const p = await apiGet<ProvidersResponseView>("/v1/providers");
      next.providers = p.providers;
    } catch {
      /* optional on partial deploys */
    }
    try {
      const ready = await apiGet<{ cache?: Overview["cache"] }>("/ready");
      if (ready.cache) next.cache = ready.cache;
    } catch {
      /* optional */
    }
    try {
      const stats = await apiGet<IndexStatsView>("/v1/index/stats");
      next.indexStats = stats.stats;
    } catch {
      /* optional */
    }
    setData(next);
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <div>
      <h1>Querynx Console</h1>
      <p className="sub">Self-hosted web intelligence — overview</p>
      <ConnectionBar />

      {loading && <p>Loading…</p>}
      {data?.error && <p className="error">API unreachable: {data.error}</p>}

      {data && !data.error && (
        <>
          <div className="grid">
            <div className="panel stat">
              <div className="label">API STATUS</div>
              <div className="value">
                {data.health.status === "ok" ? (
                  <span className="badge ok">healthy</span>
                ) : (
                  <span className="badge bad">{data.health.status}</span>
                )}
              </div>
              <div className="label">v{data.health.version || "?"}</div>
            </div>
            <div className="panel stat">
              <div className="label">PROVIDERS</div>
              <div className="value">
                {data.providers.filter((p) => p.configured).length}/
                {data.providers.length}
              </div>
              <div className="label">configured</div>
            </div>
            <div className="panel stat">
              <div className="label">CACHE HIT RATE</div>
              <div className="value">
                {(data.cache.hitRate * 100).toFixed(0)}%
              </div>
              <div className="label">
                {data.cache.size} entries · {data.cache.stampedesPrevented}{" "}
                coalesced
              </div>
            </div>
            <div className="panel stat">
              <div className="label">INDEXED DOCUMENTS</div>
              <div className="value">{data.indexStats?.documents ?? "—"}</div>
              <div className="label">
                {data.indexStats?.collections ?? 0} collections
              </div>
            </div>
          </div>

          <h2>Provider health</h2>
          <div className="panel">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>State</th>
                  <th>Configured</th>
                  <th>Success</th>
                  <th>P50 latency</th>
                </tr>
              </thead>
              <tbody>
                {data.providers.map((p) => (
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
        </>
      )}
    </div>
  );
}
