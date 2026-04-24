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

  it('omits session lifecycle events from the display timeline before limiting entries', () => {
    const compact = compactActivityEntries(
      [
        {
          ...activity('Ensured session "Validate Parallel plugin usage"', '2026-04-16T19:59:00Z'),
          type: 'session.ensured',
        },
        activity('Validated the Parallel plugin guidance', '2026-04-16T19:58:00Z'),
      ],
      1,
    );

    expect(compact.entries.map((entry) => entry.summary)).toEqual([
      'Validated the Parallel plugin guidance',
    ]);
    expect(compact.entries.map((entry) => entry.type)).toEqual(['note']);
    expect(compact.hiddenCount).toBe(0);
  });

  it('adds compact relative timestamps for feed rendering', () => {
    const compact = compactActivityEntries([
      {
        ...activity('Started step', '2026-04-16T17:00:00Z'),
        type: 'execution.updated',
        step_id: 'capture-requirements',
        payload: { blockers: ['waiting on review'] },
      },
    ]);

    expect(compact.entries[0]).toMatchObject({
      summary: 'Started step',
      bucket: '3h',
      source: 'agent',
      type: 'execution.updated',
      sessionId: 'session-1',
      stepId: 'capture-requirements',
      blockers: ['waiting on review'],
    });
  });

  it('treats legacy null payload activity as having no blockers', () => {
    const compact = compactActivityEntries([
      {
        ...activity('Legacy note', '2026-04-16T17:00:00Z'),
        payload: null,
      } as unknown as ActivityEvent,
    ]);

    expect(compact.entries[0]).toMatchObject({
      summary: 'Legacy note',
      blockers: [],
    });
  });
});
