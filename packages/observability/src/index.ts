/**
 * Metrics registry with Prometheus text-exposition support.
 *
 * Counters, gauges and latency histograms (with P50/P95/P99) in one
 * dependency-free registry. Services export the text format from
 * their /metrics endpoints.
 */

export type MetricKind = 'counter' | 'gauge' | 'histogram';

export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, number[]>();

  /** Increment a counter. */
  inc(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  /** Set a gauge to an absolute value. */
  setGauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  /** Record a latency/size observation into a histogram. */
  observe(name: string, value: number): void {
    let samples = this.histograms.get(name);
    if (!samples) {
      samples = [];
      this.histograms.set(name, samples);
    }
    samples.push(value);
    // Bound memory: keep the most recent 10k observations.
    if (samples.length > 10_000) samples.splice(0, samples.length - 10_000);
  }

  /** Time a function, observing duration in milliseconds. */
  async timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      this.observe(name, performance.now() - start);
    }
  }

  /** Current counter value. */
  counter(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  /** Current gauge value. */
  gauge(name: string): number | undefined {
    return this.gauges.get(name);
  }

  /** Percentile over a histogram (linear interpolation, like Prometheus). */
  percentile(name: string, p: number): number {
    const samples = this.histograms.get(name);
    if (!samples || samples.length === 0) return 0;
    const sorted = [...samples].sort((a, b) => a - b);
    const rank = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(rank);
    const upper = Math.ceil(rank);
    if (lower === upper) return sorted[lower]!;
    return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (rank - lower);
  }

  /** All registered metric names. */
  names(): string[] {
    return [
      ...this.counters.keys(),
      ...this.gauges.keys(),
      ...this.histograms.keys(),
    ];
  }

  /** Prometheus text exposition format. */
  prometheus(): string {
    const lines: string[] = [];
    for (const [name, value] of this.counters) {
      lines.push(`# TYPE ${name} counter`, `${name} ${value}`);
    }
    for (const [name, value] of this.gauges) {
      lines.push(`# TYPE ${name} gauge`, `${name} ${value}`);
    }
    for (const [name, samples] of this.histograms) {
      const count = samples.length;
      const sum = samples.reduce((s, v) => s + v, 0);
      lines.push(`# TYPE ${name} histogram`);
      lines.push(`${name}_count ${count}`);
      lines.push(`${name}_sum ${sum}`);
      for (const p of [50, 95, 99]) {
        lines.push(`${name}_p${p} ${this.percentile(name, p).toFixed(2)}`);
      }
    }
    return lines.join('\n') + '\n';
  }

  /** Reset everything (test hook). */
  clear(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }
}

/** Shared process-wide registry. */
export const metrics = new MetricsRegistry();
