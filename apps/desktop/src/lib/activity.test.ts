import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { compactActivityEntries, formatActivityTime } from './activity';
import type { ActivityEvent } from './types';

describe('formatActivityTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-16T20:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders sub-minute activity as "now"', () => {
    expect(formatActivityTime('2026-04-16T19:59:45Z')).toBe('now');
  });

  it('renders fresh activity in compact minute form', () => {
    expect(formatActivityTime('2026-04-16T19:45:00Z')).toBe('15m');
  });

  it('renders same-day activity in compact hour form', () => {
    expect(formatActivityTime('2026-04-16T17:00:00Z')).toBe('3h');
  });

  it('renders older activity as an abbreviated absolute date', () => {
    expect(formatActivityTime('2026-04-01T12:00:00Z')).toMatch(/apr 1/);
  });

  it('returns a dash for malformed timestamps', () => {
    expect(formatActivityTime('not-a-date')).toBe('—');
  });
});

describe('compactActivityEntries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-16T20:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function activity(summary: string, timestamp: string, source: ActivityEvent['source'] = 'agent') {
    return {
      timestamp,
      actor: 'agent-a',
      source,
      project_id: 'parallel-1',
      session_id: 'session-1',
      step_id: null,
      subtask_id: null,
      type: 'note',
      summary,
      payload: {},
    } satisfies ActivityEvent;
  }

  it('keeps the first eight recent entries and reports the overflow count', () => {
    const entries = Array.from({ length: 10 }, (_, index) =>
      activity(`Entry ${index + 1}`, `2026-04-16T19:${String(59 - index).padStart(2, '0')}:00Z`),
    );

    const compact = compactActivityEntries(entries);

    expect(compact.entries.map((entry) => entry.summary)).toEqual(
      ['Entry 1', 'Entry 2', 'Entry 3', 'Entry 4', 'Entry 5', 'Entry 6', 'Entry 7', 'Entry 8'],
    );
    expect(compact.hiddenCount).toBe(2);
  });

  it('adds compact relative timestamps for feed rendering', () => {
    const compact = compactActivityEntries([
      activity('Started step', '2026-04-16T17:00:00Z'),
    ]);

    expect(compact.entries[0]).toMatchObject({
      summary: 'Started step',
      bucket: '3h',
      source: 'agent',
    });
  });
});
