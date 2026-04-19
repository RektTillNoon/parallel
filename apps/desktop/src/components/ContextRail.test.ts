import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { compactActivityEntries, formatActivityTime } from './ContextRail';
import type { ActivityEvent } from '../lib/types';

const recentActivity: ActivityEvent[] = [
  {
    timestamp: '2026-04-16T19:23:12.870Z',
    actor: 'agent-a',
    source: 'agent',
    project_id: 'parallel-1',
    session_id: 'session-1',
    step_id: null,
    subtask_id: null,
    type: 'note',
    summary: 'Fourth',
    payload: {},
  },
  {
    timestamp: '2026-04-16T19:20:12.870Z',
    actor: 'agent-a',
    source: 'agent',
    project_id: 'parallel-1',
    session_id: 'session-1',
    step_id: null,
    subtask_id: null,
    type: 'note',
    summary: 'First',
    payload: {},
  },
  {
    timestamp: '2026-04-16T19:22:12.870Z',
    actor: 'agent-a',
    source: 'agent',
    project_id: 'parallel-1',
    session_id: 'session-1',
    step_id: null,
    subtask_id: null,
    type: 'note',
    summary: 'Third',
    payload: {},
  },
  {
    timestamp: '2026-04-16T19:21:12.870Z',
    actor: 'agent-a',
    source: 'agent',
    project_id: 'parallel-1',
    session_id: 'session-1',
    step_id: null,
    subtask_id: null,
    type: 'note',
    summary: 'Second',
    payload: {},
  },
];

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

  it('keeps only the first few recent entries and reports the overflow count', () => {
    const compact = compactActivityEntries([
      activity('First', '2026-04-16T19:59:00Z'),
      activity('Second', '2026-04-16T19:58:00Z'),
      activity('Third', '2026-04-16T19:57:00Z'),
      activity('Fourth', '2026-04-16T19:56:00Z'),
      activity('Fifth', '2026-04-16T19:55:00Z'),
    ]);

    expect(compact.entries.map((entry) => entry.summary)).toEqual(['First', 'Second', 'Third', 'Fourth']);
    expect(compact.hiddenCount).toBe(1);
  });

  it('adds compact relative timestamps for marginalia rendering', () => {
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
