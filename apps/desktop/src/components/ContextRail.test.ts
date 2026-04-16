import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  formatActivityTime,
  getRecentActivityEntries,
  groupActivityEntries,
} from './ContextRail';
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

describe('getRecentActivityEntries', () => {
  it('returns the recent activity list with the newest entries first, capped at five', () => {
    expect(getRecentActivityEntries(recentActivity).map((event) => event.summary)).toEqual([
      'Fourth',
      'Third',
      'Second',
      'First',
    ]);
  });

  it('pushes malformed timestamps behind valid activity and stops at the cap', () => {
    const broken: ActivityEvent[] = Array.from({ length: 6 }, (_, index) => ({
      ...recentActivity[0],
      timestamp: 'not-a-date',
      summary: `Broken ${index}`,
    }));

    const summaries = getRecentActivityEntries([...recentActivity, ...broken]).map(
      (event) => event.summary,
    );

    expect(summaries.slice(0, 4)).toEqual(['Fourth', 'Third', 'Second', 'First']);
    expect(summaries).toHaveLength(5);
    expect(summaries[4]).toMatch(/^Broken/);
  });
});

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

describe('groupActivityEntries', () => {
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

  it('collapses consecutive entries sharing a time bucket into one marginalia group', () => {
    const groups = groupActivityEntries([
      activity('Connected Codex', '2026-04-16T17:02:00Z'),
      activity('Started step', '2026-04-16T17:01:00Z'),
      activity('Ensured session', '2026-04-16T17:00:00Z'),
      activity('Initialized workflow', '2026-04-11T20:00:00Z'),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0].bucket).toBe('3h');
    expect(groups[0].entries.map((event) => event.summary)).toEqual([
      'Connected Codex',
      'Started step',
      'Ensured session',
    ]);
    expect(groups[1].bucket).toBe('5d');
    expect(groups[1].entries.map((event) => event.summary)).toEqual(['Initialized workflow']);
  });

  it('keeps non-adjacent entries with matching buckets in separate groups', () => {
    const groups = groupActivityEntries([
      activity('Fresh', '2026-04-16T17:00:00Z'),
      activity('Middle', '2026-04-15T20:00:00Z'),
      activity('Old-but-matches', '2026-04-16T17:00:00Z'),
    ]);

    expect(groups.map((group) => group.bucket)).toEqual(['3h', '1d', '3h']);
    expect(groups.map((group) => group.entries.length)).toEqual([1, 1, 1]);
  });
});
