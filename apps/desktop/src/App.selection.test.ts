import { describe, expect, it } from 'vitest';

import {
  choosePrimaryBoardRow,
  resolveBoardSelectionFromRow,
  resolveSelectedSessionId,
} from './App';
import type { SessionBoardData } from './lib/session-board';

const board: SessionBoardData = {
  rows: [
    {
      sessionId: 'session-1',
      sessionTitle: 'Parallel session',
      repoRoot: '/Users/light/Projects/parallel',
      repoName: 'parallel',
      stepId: 'capture-requirements',
      stepTitle: 'Capture requirements',
      summary: 'Write the initial problem statement.',
      status: 'active',
      lastUpdatedAt: '2026-04-16T19:24:12.870Z',
    },
    {
      sessionId: 'session-2',
      sessionTitle: 'Notes session',
      repoRoot: '/Users/light/Projects/notes',
      repoName: 'notes',
      stepId: 'draft-outline',
      stepTitle: 'Draft outline',
      summary: 'Draft the outline.',
      status: 'active',
      lastUpdatedAt: '2026-04-16T19:25:12.870Z',
    },
  ],
};

describe('choosePrimaryBoardRow', () => {
  it('retargets stale session selection when the repo root changes', () => {
    const row = choosePrimaryBoardRow(
      board,
      '/Users/light/Projects/notes',
      'session-1',
    );

    expect(row?.sessionId).toBe('session-2');
    expect(row?.repoRoot).toBe('/Users/light/Projects/notes');
  });

  it('does not fall back to another repo when the selected root has no rows', () => {
    const row = choosePrimaryBoardRow(board, '/Users/light/Projects/ghost', 'session-1');

    expect(row).toBeNull();
  });

  it('preserves the selected session when it still belongs to the selected repo', () => {
    const row = choosePrimaryBoardRow(board, '/Users/light/Projects/parallel', 'session-1');

    expect(row?.sessionId).toBe('session-1');
    expect(row?.repoRoot).toBe('/Users/light/Projects/parallel');
  });

  it('syncs the selected session id directly from the chosen board row', () => {
    expect(resolveSelectedSessionId(board.rows[1])).toBe('session-2');
    expect(resolveSelectedSessionId(null)).toBeNull();
  });

  it('clears the selected session id when a selected root has no matching row', () => {
    const row = choosePrimaryBoardRow(board, '/Users/light/Projects/ghost', 'session-1');

    expect(resolveSelectedSessionId(row)).toBeNull();
  });
});

describe('resolveBoardSelectionFromRow', () => {
  it('keeps repo and session selection aligned to the clicked ledger row', () => {
    expect(resolveBoardSelectionFromRow(board.rows[1])).toEqual({
      selectedRoot: '/Users/light/Projects/notes',
      selectedSessionId: 'session-2',
    });
  });
});
