import { describe, expect, it } from 'vitest';

import {
  activeProjectsMetricLabel,
  activeSessionsSubtitle,
  choosePrimaryBoardRow,
  noProjectsInRootsMessage,
  projectDiscoverySubtitle,
  projectInitPrompt,
  projectCollectionSummary,
  projectSectionLabel,
  resolveBoardSelectionFromRow,
  resolveSelectedSessionId,
} from './App';
import type { ProjectSummary } from './lib/types';
import type { SessionBoardData } from './lib/session-board';

const board: SessionBoardData = {
  rows: [
    {
      sessionId: 'session-1',
      sessionTitle: 'Parallel session',
      projectRoot: '/Users/light/Projects/parallel',
      projectName: 'parallel',
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

describe('resolveBoardSelectionFromRow', () => {
  it('keeps project and session selection aligned to the clicked ledger row', () => {
    expect(resolveBoardSelectionFromRow(board.rows[1])).toEqual({
      selectedRoot: '/Users/light/Projects/notes',
      selectedSessionId: 'session-2',
    });
  });
});

describe('project copy helpers', () => {
  it('describes the sidebar collection as projects', () => {
    expect(projectCollectionSummary(2, 5)).toBe('2 roots · 5 projects');
    expect(projectSectionLabel).toBe('Projects');
  });

  it('keeps the remaining desktop copy aligned to project language', () => {
    expect(projectInitPrompt).toBe('Initialize workflow for this project.');
    expect(activeSessionsSubtitle).toBe('Live log of work in motion across watched projects.');
    expect(activeProjectsMetricLabel).toBe('Projects live');
    expect(noProjectsInRootsMessage).toBe('No projects in current roots.');
  });

  it('shows provenance subtitles only for external-tool candidates', () => {
    const codexProject = {
      id: null,
      name: 'foo',
      root: '/Users/light/Projects/foo',
      kind: null,
      owner: null,
      tags: [],
      initialized: false,
      status: 'uninitialized',
      stale: false,
      missing: false,
      currentStepId: null,
      currentStepTitle: null,
      blockerCount: 0,
      totalStepCount: 0,
      completedStepCount: 0,
      activeSessionCount: 0,
      focusSessionId: null,
      lastUpdatedAt: null,
      nextAction: 'Initialize workflow metadata',
      activeBranch: null,
      pendingProposalCount: 0,
      discoverySource: 'codex',
      discoveryPath: '/Users/light/Projects/foo',
    } satisfies ProjectSummary;
    const initializedProject = {
      ...codexProject,
      initialized: true,
      status: 'todo',
      discoverySource: 'parallel',
      discoveryPath: null,
    } satisfies ProjectSummary;

    expect(projectDiscoverySubtitle(codexProject)).toBe('Codex activity');
    expect(projectDiscoverySubtitle({
      ...codexProject,
      discoverySource: 'claude',
    })).toBe('Claude Code activity');
    expect(projectDiscoverySubtitle({
      ...codexProject,
      discoverySource: null,
      discoveryPath: null,
    })).toBeNull();
    expect(projectDiscoverySubtitle(initializedProject)).toBeNull();
  });

});
