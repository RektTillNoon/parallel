import { describe, expect, it } from 'vitest';

import { getRecentActivityEntries } from './ContextRail';
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
  it('returns the newest activity entries first', () => {
    expect(getRecentActivityEntries(recentActivity).map((event) => event.summary)).toEqual([
      'Fourth',
      'Third',
      'Second',
    ]);
  });

  it('pushes malformed timestamps behind valid activity', () => {
    expect(
      getRecentActivityEntries([
        ...recentActivity,
        {
          ...recentActivity[0],
          timestamp: 'not-a-date',
          summary: 'Broken timestamp',
        },
      ]).map((event) => event.summary),
    ).toEqual(['Fourth', 'Third', 'Second']);
  });
});
