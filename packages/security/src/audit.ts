/**
 * Audit logging: structured, bounded, redaction-safe records of
 * security-relevant events (key use, denials, blocked URLs).
 */

import { redactSecrets } from './redact.js';

export interface AuditEvent {
  timestamp: string;
  type: string;
  actor: string;
  outcome: 'allowed' | 'denied' | 'error';
  details: Record<string, unknown>;
}

export interface AuditLogOptions {
  /** Cap on retained events (default 1000). */
  maxEvents?: number;
  /** Optional sink for external transport (logger, DB, stdout). */
  sink?: (event: AuditEvent) => void;
}

export class AuditLog {
  private events: AuditEvent[] = [];

  constructor(private readonly options: AuditLogOptions = {}) {}

  record(
    type: string,
    actor: string,
    outcome: AuditEvent['outcome'],
    details: Record<string, unknown> = {}
  ): void {
    const event: AuditEvent = {
      timestamp: new Date().toISOString(),
      type,
      actor,
      outcome,
      details: redactSecrets(details),
    };
    this.events.push(event);
    const cap = this.options.maxEvents ?? 1000;
    if (this.events.length > cap) this.events.shift();
    this.options.sink?.(event);
  }

  /** Recent events, newest last. */
  recent(limit = 100): readonly AuditEvent[] {
    return this.events.slice(-limit);
  }

  /** Events filtered by outcome. */
  byOutcome(outcome: AuditEvent['outcome']): readonly AuditEvent[] {
    return this.events.filter((e) => e.outcome === outcome);
  }

  /** Total recorded count. */
  get size(): number {
    return this.events.length;
  }
}
