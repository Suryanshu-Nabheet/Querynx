import { describe, expect, it } from 'vitest';
import { CronExpression, Scheduler } from '../src/index.js';

describe('CronExpression', () => {
  it('parses and matches exact values', () => {
    const cron = new CronExpression('30 2 * * *');
    expect(cron.matches(new Date('2026-11-24T02:30:00Z'))).toBe(true);
    expect(cron.matches(new Date('2026-11-24T02:31:00Z'))).toBe(false);
    expect(cron.matches(new Date('2026-11-24T03:30:00Z'))).toBe(false);
  });

  it('supports wildcards', () => {
    const cron = new CronExpression('* * * * *');
    expect(cron.matches(new Date())).toBe(true);
  });

  it('supports steps', () => {
    const cron = new CronExpression('*/15 * * * *');
    expect(cron.matches(new Date('2026-11-24T10:00:00Z'))).toBe(true);
    expect(cron.matches(new Date('2026-11-24T10:15:00Z'))).toBe(true);
    expect(cron.matches(new Date('2026-11-24T10:20:00Z'))).toBe(false);
  });

  it('supports ranges and lists', () => {
    const cron = new CronExpression('0 9-17 * * 1,3,5');
    const monday = new Date('2026-11-23T09:00:00Z'); // a Monday
    const tuesday = new Date('2026-11-24T09:00:00Z'); // a Tuesday
    expect(cron.matches(monday)).toBe(true);
    expect(cron.matches(tuesday)).toBe(false);
  });

  it('computes the next fire time', () => {
    const cron = new CronExpression('0 6 * * *'); // daily at 06:00
    const after = cron.nextAfter(new Date('2026-11-24T07:00:00Z'))!;
    expect(after.getUTCDate()).toBe(25);
    expect(after.getUTCHours()).toBe(6);
  });

  it('rejects malformed expressions', () => {
    expect(() => new CronExpression('* * *')).toThrow(/5 fields/);
    expect(() => new CronExpression('99 * * * *')).toThrow(/range/);
    expect(() => new CronExpression('* * * * 9')).toThrow(/range/);
    expect(() => new CronExpression('*/0 * * * *')).toThrow(/step/);
  });
});

describe('Scheduler', () => {
  it('polls due schedules', () => {
    const s = new Scheduler();
    s.add({ id: 'daily', cron: '0 12 * * *', jobType: 'crawl', payload: {} });
    const due = s.pollDue(new Date('2026-11-24T12:00:00Z'));
    expect(due.map((d) => d.id)).toEqual(['daily']);
    expect(s.pollDue(new Date('2026-11-24T12:01:00Z'))).toHaveLength(0);
  });

  it('enforces minimum intervals', () => {
    const s = new Scheduler();
    s.add({
      id: 'frequent',
      cron: '* * * * *',
      jobType: 'crawl',
      payload: {},
      minIntervalMs: 60_000,
    });
    const t1 = new Date('2026-11-24T10:00:00Z');
    expect(s.pollDue(t1)).toHaveLength(1);
    s.markFired('frequent', t1);
    // One minute later: cron matches but minInterval blocks.
    expect(s.pollDue(new Date('2026-11-24T10:00:30Z'))).toHaveLength(0);
    expect(s.pollDue(new Date('2026-11-24T10:02:00Z'))).toHaveLength(1);
  });

  it('honors allowed-hours windows', () => {
    const s = new Scheduler();
    s.add({
      id: 'nightly',
      cron: '* * * * *',
      jobType: 'crawl',
      payload: {},
      allowedHours: [22, 23],
    });
    expect(s.pollDue(new Date('2026-11-24T22:30:00Z'))).toHaveLength(1);
    expect(s.pollDue(new Date('2026-11-24T10:30:00Z'))).toHaveLength(0);
  });

  it('add/remove/list round trip', () => {
    const s = new Scheduler();
    s.add({ id: 'a', cron: '0 0 * * *', jobType: 'x', payload: {} });
    s.add({ id: 'b', cron: '0 1 * * *', jobType: 'x', payload: {} });
    expect(s.list()).toHaveLength(2);
    expect(s.remove('a')).toBe(true);
    expect(s.list()).toHaveLength(1);
    expect(s.get('b')?.jobType).toBe('x');
  });

  it('preserves lastRun across schedule replacement', () => {
    const s = new Scheduler();
    s.add({ id: 'x', cron: '* * * * *', jobType: 't', payload: {} });
    s.markFired('x', new Date('2026-11-24T00:00:00Z'));
    s.add({ id: 'x', cron: '0 * * * *', jobType: 't', payload: {} });
    expect(s.list()[0]!.lastRun?.toISOString()).toBe('2026-11-24T00:00:00.000Z');
  });
});
