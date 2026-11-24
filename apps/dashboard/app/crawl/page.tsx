"use client";

import { useEffect, useRef, useState } from "react";
import ConnectionBar from "../../components/ConnectionBar";
import { apiGet, apiPost, apiDelete, DashboardApiError } from "../../lib/api";

interface JobView {
  id: string;
  type: string;
  status: string;
  attempts: number;
  error: string | null;
  result?: Record<string, unknown>;
  createdAt: string;
}

interface QueueStats {
  pending: number;
  running: number;
  retryScheduled?: number;
  dead: number;
  total: number;
}

export default function CrawlPage() {
  const [seeds, setSeeds] = useState("");
  const [collection, setCollection] = useState("crawled");
  const [maxPages, setMaxPages] = useState(10);
  const [maxDepth, setMaxDepth] = useState(1);
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [stats, setStats] = useState<QueueStats | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadQueue = async () => {
    try {
      const body = await apiGet<{ stats: QueueStats }>("/v1/jobs");
      setStats(body.stats);
    } catch {
      /* optional */
    }
  };

  useEffect(() => {
    void loadQueue();
    pollRef.current = setInterval(() => void loadQueue(), 5_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const submit = async (type: "crawl" | "index") => {
    setSubmitting(true);
    setError("");
    try {
      const seedList = seeds
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (seedList.length === 0) throw new Error("provide at least one URL");
      const payload =
        type === "crawl"
          ? { seeds: seedList, collection, maxPages, maxDepth }
          : { url: seedList[0]!, collection };
      const body = await apiPost<{ job: JobView }>("/v1/jobs", {
        type,
        payload,
      });
      setJobs((prev) =>
        [{ ...body.job, result: undefined }, ...prev].slice(0, 20),
      );
      void loadQueue();
    } catch (err) {
      setError(err instanceof Error ? err.message : "submission failed");
    }
    setSubmitting(false);
  };

  const cancel = async (id: string) => {
    try {
      await apiDelete(`/v1/jobs/${id}`);
    } catch (err) {
      if (err instanceof DashboardApiError && err.status === 404) {
        // Already terminal — refresh to reflect it.
      } else {
        setError(err instanceof Error ? err.message : "cancel failed");
      }
    }
    void loadQueue();
  };

  return (
    <div>
      <h1>Crawl management</h1>
      <p className="sub">
        Submit crawl and index jobs to the durable queue; robots.txt compliant,
        per-domain throttled, auto-ingested into the corpus.
      </p>
      <ConnectionBar />

      <div className="panel">
        <textarea
          rows={2}
          value={seeds}
          onChange={(e) => setSeeds(e.target.value)}
          placeholder="https://example.com  (one or more seed URLs)"
          aria-label="Seed URLs"
        />
        <div
          style={{
            display: "flex",
            gap: 10,
            marginTop: 10,
            alignItems: "center",
          }}
        >
          <input
            style={{ width: 140 }}
            value={collection}
            onChange={(e) => setCollection(e.target.value)}
            placeholder="collection"
            aria-label="Collection"
          />
          <label htmlFor="maxPages" className="sub" style={{ margin: 0 }}>
            max pages
          </label>
          <input
            id="maxPages"
            type="number"
            min={1}
            max={50}
            style={{ width: 80 }}
            value={maxPages}
            onChange={(e) => setMaxPages(Number(e.target.value) || 10)}
          />
          <label htmlFor="maxDepth" className="sub" style={{ margin: 0 }}>
            depth
          </label>
          <input
            id="maxDepth"
            type="number"
            min={0}
            max={5}
            style={{ width: 70 }}
            value={maxDepth}
            onChange={(e) => setMaxDepth(Number(e.target.value) || 1)}
          />
          <button
            onClick={() => void submit("crawl")}
            disabled={submitting || !seeds.trim()}
          >
            {submitting ? "Submitting…" : "Crawl"}
          </button>
          <button
            className="secondary"
            onClick={() => void submit("index")}
            disabled={
              submitting || !seeds.trim() || seeds.split(/\s+/).length !== 1
            }
            title="Single-URL extraction and ingest"
          >
            Index URL
          </button>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      {stats && (
        <div className="grid">
          <div className="panel stat">
            <div className="label">PENDING</div>
            <div className="value">{stats.pending}</div>
          </div>
          <div className="panel stat">
            <div className="label">RUNNING</div>
            <div className="value">{stats.running}</div>
          </div>
          <div className="panel stat">
            <div className="label">DEAD-LETTERED</div>
            <div className="value">{stats.dead}</div>
          </div>
          <div className="panel stat">
            <div className="label">TOTAL</div>
            <div className="value">{stats.total}</div>
          </div>
        </div>
      )}

      {jobs.length > 0 && (
        <>
          <h2>Submitted this session</h2>
          <div className="panel">
            {jobs.map((j) => (
              <div className="result" key={j.id}>
                <div className="title">
                  {j.type} ·{" "}
                  <span
                    className={`badge ${j.status === "completed" ? "ok" : j.status === "dead" ? "bad" : "warn"}`}
                  >
                    {j.status}
                  </span>
                </div>
                <div className="snippet">{j.id}</div>
                {j.error && <div className="error">{j.error}</div>}
                {j.status !== "completed" && j.status !== "dead" && (
                  <p>
                    <button
                      className="secondary"
                      onClick={() => void cancel(j.id)}
                    >
                      Cancel
                    </button>
                  </p>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
