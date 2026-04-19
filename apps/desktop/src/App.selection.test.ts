import { describe, expect, it } from 'vitest';

import {
  choosePrimaryBoardRow,
  emptySelectionMessage,
  noProjectsInRootsMessage,
  projectInitPrompt,
  resolveSelectedSessionId,
} from './App';
import type { SessionBoardData } from './lib/session-board';

const board: SessionBoardData = {
  rows: [
    {
      sessionId: 'session-1',
      sessionTitle: 'Parallel session',
      projectRoot: '/Users/light/Projects/parallel',
      projectName: 'parallel',
      branch: 'main',
      source: 'agent',
      stepId: 'capture-requirements',
      stepTitle: 'Capture requirements',
      summary: 'Write the initial problem statement.',
      status: 'active',
      displayState: 'active',
      displayLabel: 'active',
      stepState: 'owned',
      lastUpdatedAt: '2026-04-16T19:24:12.870Z',
    },
    {
      sessionId: 'session-2',
      sessionTitle: 'Notes session',
      projectRoot: '/Users/light/Projects/notes',
      projectName: 'notes',
      branch: 'main',
      source: 'agent',
      stepId: 'draft-outline',
      stepTitle: 'Draft outline',
      summary: 'Draft the outline.',
      status: 'active',
      displayState: 'active',
      displayLabel: 'active',
      stepState: 'owned',
      lastUpdatedAt: '2026-04-16T19:25:12.870Z',
    },
  ],
};

describe('choosePrimaryBoardRow', () => {
  it('retargets stale session selection when the project root changes', () => {
    const row = choosePrimaryBoardRow(
      board,
      '/Users/light/Projects/notes',
      'session-1',
    );

    expect(row?.sessionId).toBe('session-2');
    expect(row?.projectRoot).toBe('/Users/light/Projects/notes');
  });

  it('does not fall back to another project when the selected root has no rows', () => {
    const row = choosePrimaryBoardRow(board, '/Users/light/Projects/ghost', 'session-1');

    expect(row).toBeNull();
  });

  it('preserves the selected session when it still belongs to the selected project', () => {
    const row = choosePrimaryBoardRow(board, '/Users/light/Projects/parallel', 'session-1');

    expect(row?.sessionId).toBe('session-1');
    expect(row?.projectRoot).toBe('/Users/light/Projects/parallel');
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

describe('app copy', () => {
  it('keeps the focus-oriented copy trimmed to initialization and empty states', () => {
    expect(projectInitPrompt).toBe('Initialize workflow for this project.');
    expect(noProjectsInRootsMessage).toBe('No projects in current roots.');
    expect(emptySelectionMessage).toBe('Pick a project to see what you left off with.');
  });
});
