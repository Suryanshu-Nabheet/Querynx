/**
 * Scheduler: recurrence-driven job triggering with cron parsing.
 *
 * A minimal but correct cron expression parser (5 fields: minute,
 * hour, day-of-month, month, day-of-week) plus per-schedule last-run
 * tracking and a `due` check the worker loop polls. No external
 * cron library — the grammar is small and correctness is testable.
 */

export interface Schedule {
  id: string;
  /** Cron expression, 5 fields. */
  cron: string;
  /** What to run; the queue layer attaches handlers. */
  jobType: string;
  payload: Record<string, unknown>;
  /** Restrict execution to a time window per day (hour boundaries). */
  allowedHours?: readonly [number, number];
  /** Minimum gap between runs in ms (jitter guard). */
  minIntervalMs?: number;
  /** Operator note. */
  description?: string;
}

/** Parsed cron with matching functions per field. */
export class CronExpression {
  private readonly matchers: Array<(value: number) => boolean>;

  constructor(readonly expression: string) {
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 5) {
      throw new Error(`cron must have 5 fields, got ${fields.length}: "${expression}"`);
    }
    const ranges = [
      [0, 59], // minute
      [0, 23], // hour
      [1, 31], // day of month
      [1, 12], // month
      [0, 6], // day of week
    ];
    this.matchers = fields.map((field, i) => {
      const range = ranges[i]!;
      const min = range[0]!;
      const max = range[1]!;
      return compileField(field, min, max);
    });
  }

  /** Whether the expression fires at the given time. */
  matches(date: Date): boolean {
    const values = [
      date.getUTCMinutes(),
      date.getUTCHours(),
      date.getUTCDate(),
      date.getUTCMonth() + 1,
      date.getUTCDay(),
    ];
    return this.matchers.every((match, i) => match(values[i]!));
  }

  /** Next fire time strictly after the given date (brute force, bounded). */
  nextAfter(from: Date, maxMinutes = 60 * 24 * 366): Date | null {
    const probe = new Date(from.getTime());
    probe.setUTCSeconds(0, 0);
    probe.setUTCMinutes(probe.getUTCMinutes() + 1);
    for (let i = 0; i < maxMinutes; i++) {
      if (this.matches(probe)) return new Date(probe.getTime());
      probe.setUTCMinutes(probe.getUTCMinutes() + 1);
    }
    return null;
  }
}

function compileField(field: string, min: number, max: number): (v: number) => boolean {
  const allowed = new Set<number>();
  for (const part of field.split(',')) {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${field}"`);
    let lo = min;
    let hi = max;
    if (range && range !== '*') {
      if (range.includes('-')) {
        const parts = range.split('-').map(Number);
        const a = parts[0]!;
        const b = parts[1]!;
        if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error(`bad range "${range}"`);
        lo = a;
        hi = b;
      } else {
        const v = Number(range);
        if (!Number.isInteger(v)) throw new Error(`bad value "${range}"`);
        lo = v;
        hi = stepRaw ? v : v; // "5/3" means start at 5, step to max
        if (stepRaw) hi = max;
      }
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`out of range in "${field}"`);
    for (let v = lo; v <= hi; v += step) allowed.add(v);
  }
  return (value: number) => allowed.has(value);
}

export interface DueCheck {
  schedule: Schedule;
  now: Date;
}

/**
 * In-memory schedule registry. `pollDue` returns schedules whose cron
 * fires now, have not fired within minIntervalMs, and fall within
 * allowedHours.
 */
export class Scheduler {
  private readonly schedules = new Map<string, Schedule & { lastRun: Date | null }>();
  private readonly compiled = new Map<string, CronExpression>();

  /** Register or replace a schedule. Validates the cron expression. */
  add(schedule: Schedule): CronExpression {
    const compiled = new CronExpression(schedule.cron);
    this.compiled.set(schedule.id, compiled);
    const existing = this.schedules.get(schedule.id);
    this.schedules.set(schedule.id, { ...schedule, lastRun: existing?.lastRun ?? null });
    return compiled;
  }

  remove(id: string): boolean {
    this.compiled.delete(id);
    return this.schedules.delete(id);
  }

  get(id: string): Schedule | undefined {
    return this.schedules.get(id);
  }

  list(): Array<Schedule & { lastRun: Date | null }> {
    return [...this.schedules.values()];
  }

  /** Schedules that should fire right now. */
  pollDue(now = new Date()): Array<Schedule & { lastRun: Date | null }> {
    const due: Array<Schedule & { lastRun: Date | null }> = [];
    for (const entry of this.schedules.values()) {
      const cron = this.compiled.get(entry.id);
      if (!cron || !cron.matches(now)) continue;
      if (entry.allowedHours) {
        const [from, to] = entry.allowedHours;
        const hour = now.getUTCHours();
        if (hour < from! || hour > to!) continue;
      }
      if (entry.minIntervalMs && entry.lastRun) {
        if (now.getTime() - entry.lastRun.getTime() < entry.minIntervalMs) continue;
      }
      due.push(entry);
    }
    return due;
  }

  /** Mark a schedule as having fired. */
  markFired(id: string, at = new Date()): void {
    const entry = this.schedules.get(id);
    if (entry) entry.lastRun = at;
  }
}
