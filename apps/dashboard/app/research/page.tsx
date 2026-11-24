'use client';

import { useRef, useState } from 'react';
import ConnectionBar from '../../components/ConnectionBar';
import { getStoredConnection, DashboardApiError } from '../../lib/api';

interface ReportView {
  findings: string;
  evidence: Array<{ url: string; title: string; passage: string; relevance: number }>;
  gaps: Array<{ question: string }>;
  usage: { queries: number; pagesFetched: number; elapsedMs: number };
  termination: string;
}

type StreamEvent =
  | { type: 'start'; requestId?: string; objective?: string }
  | { type: 'query-started'; query: string; reason: string }
  | { type: 'query-completed'; query: string; resultCount: number; durationMs: number }
  | { type: 'page-extracted'; url: string; title: string; contentChars: number }
  | { type: 'gap-detected'; question: string }
  | { type: 'completed'; report: ReportView }
  | { type: 'error'; message: string };

const MODES = ['fast', 'standard', 'advanced', 'deep', 'academic', 'technical', 'documentation'] as const;

export default function ResearchPage() {
  const [objective, setObjective] = useState('');
  const [mode, setMode] = useState<string>('standard');
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [report, setReport] = useState<ReportView | null>(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const run = async () => {
    if (objective.trim().length < 3) return;
    setRunning(true);
    setError('');
    setEvents([]);
    setReport(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const { url, apiKey } = getStoredConnection();
      const response = await fetch(`${url}/v1/research/stream`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { 'x-api-key': apiKey } : {}),
        },
        body: JSON.stringify({ objective, mode }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Parse complete SSE frames.
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const eventLine = frame.split('\n').find((l) => l.startsWith('event: '));
          const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!eventLine || !dataLine) continue;
          const type = eventLine.slice('event: '.length);
          const data = JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>;
          const event = { type, ...data } as StreamEvent;
          setEvents((prev) => [...prev, event]);
          if (type === 'completed') {
            setReport((event as { report: ReportView }).report);
          }
          if (type === 'error') {
            setError((event as { message: string }).message);
          }
        }
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setError(err instanceof DashboardApiError ? err.message : 'research failed');
      }
    }
    setRunning(false);
  };

  const stop = () => {
    abortRef.current?.abort();
    setRunning(false);
  };

  return (
    <div>
      <h1>Research playground</h1>
      <p className="sub">
        Bounded autonomous research — live progress streams over SSE as queries
        execute and pages extract.
      </p>
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
          {running ? (
            <button className="secondary" onClick={stop}>Stop</button>
          ) : (
            <button onClick={() => void run()} disabled={objective.trim().length < 3}>
              Run research
            </button>
          )}
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      {events.length > 0 && (
        <>
          <h2>Live progress</h2>
          <div className="panel">
            {events.map((event, i) => {
              switch (event.type) {
                case 'query-started':
                  return (
                    <div className="result" key={i}>
                      <span className="badge warn">{event.reason}</span>{' '}
                      <strong>{event.query}</strong>
                    </div>
                  );
                case 'query-completed':
                  return (
                    <div className="result" key={i}>
                      <span className="badge ok">+{event.resultCount} results</span>{' '}
                      {event.query} <span className="score">({event.durationMs}ms)</span>
                    </div>
                  );
                case 'page-extracted':
                  return (
                    <div className="result" key={i}>
                      <span className="badge">extracted</span>{' '}
                      {event.title || event.url}{' '}
                      <span className="score">{event.contentChars} chars</span>
                    </div>
                  );
                case 'gap-detected':
                  return (
                    <div className="result" key={i}>
                      <span className="badge warn">gap</span> {event.question}
                    </div>
                  );
                default:
                  return null;
              }
            })}
          </div>
        </>
      )}

      {report && (
        <>
          <h2>
            Findings · {report.usage.queries} queries · {report.usage.pagesFetched} pages ·{' '}
            <span className="badge">{report.termination}</span>
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
