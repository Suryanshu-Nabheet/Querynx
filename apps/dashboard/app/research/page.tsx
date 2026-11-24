'use client';

import { useState } from 'react';
import ConnectionBar from '../../components/ConnectionBar';
import { apiPost, type ResearchReportView } from '../../lib/api';

interface ReportView {
  findings: string;
  evidence: Array<{ url: string; title: string; passage: string; relevance: number }>;
  gaps: Array<{ question: string }>;
  usage: { queries: number; pagesFetched: number; elapsedMs: number };
  termination: string;
}

const MODES = ['fast', 'standard', 'advanced', 'deep', 'academic', 'technical', 'documentation'] as const;

export default function ResearchPage() {
  const [objective, setObjective] = useState('');
  const [mode, setMode] = useState<string>('standard');
  const [report, setReport] = useState<ReportView | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const run = async () => {
    if (objective.trim().length < 3) return;
    setLoading(true);
    setError('');
    setReport(null);
    try {
      const { report: r } = await apiPost<ResearchReportView>('/v1/research', {
        objective,
        mode,
      });
      setReport({
        findings: r.findings,
        evidence: r.evidence.map((e) => ({
          url: e.url, title: e.title, passage: e.passage, relevance: e.relevance,
        })),
        gaps: r.gaps.map((g) => ({ question: g.question })),
        usage: r.usage,
        termination: r.termination,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'research failed');
    }
    setLoading(false);
  };

  return (
    <div>
      <h1>Research playground</h1>
      <p className="sub">Bounded autonomous research with budgets, evidence tracking and gap detection</p>
      <ConnectionBar />

      <div className="panel">
        <textarea
          rows={3}
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          placeholder="Research objective — e.g. compare MVCC implementations across databases"
          aria-label="Research objective"
        />
        <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
          <select value={mode} onChange={(e) => setMode(e.target.value)} style={{ width: 180 }} aria-label="Mode">
            {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <button onClick={() => void run()} disabled={loading || objective.trim().length < 3}>
            {loading ? 'Researching…' : 'Run research'}
          </button>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      {report && (
        <>
          <h2>
            Findings · {report.usage.queries} queries · {report.usage.pagesFetched} pages ·{' '}
            {report.usage.elapsedMs}ms · <span className="badge">{report.termination}</span>
          </h2>
          <div className="panel">
            <pre className="evidence">{report.findings}</pre>
          </div>

          <h2>Evidence ({report.evidence.length})</h2>
          <div className="panel">
            {report.evidence.map((e, i) => (
              <div className="result" key={`${e.url}-${i}`}>
                <div className="title">{e.title || e.url}</div>
                <a href={e.url} target="_blank" rel="noopener noreferrer">{e.url}</a>
                <div className="snippet">{e.passage.slice(0, 240)}</div>
                <span className="score">relevance {e.relevance.toFixed(3)}</span>
              </div>
            ))}
          </div>

          {report.gaps.length > 0 && (
            <>
              <h2>Unresolved questions</h2>
              <div className="panel">
                {report.gaps.map((g, i) => (
                  <div className="result" key={i}>? {g.question}</div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
