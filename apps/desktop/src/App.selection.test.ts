import { describe, expect, it } from 'vitest';

import {
  buildVisibleProjects,
  choosePrimaryBoardRow,
  emptySelectionMessage,
  noProjectsInRootsMessage,
  projectInitPrompt,
  resolveSelectedSessionId,
} from './App';
import type { SessionBoardData } from './lib/session-board';
import type { LoadStatePayload } from './lib/types';

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
      'session-2',
    );

    expect(row?.sessionId).toBe('session-2');
    expect(row?.projectRoot).toBe('/Users/light/Projects/notes');
  });

  it('does not fall back to another project when the selected root has no rows', () => {
    const row = choosePrimaryBoardRow(board, '/Users/light/Projects/ghost', 'session-1', null);

    expect(row).toBeNull();
  });

  it('preserves the selected session when it still belongs to the selected project', () => {
    const row = choosePrimaryBoardRow(board, '/Users/light/Projects/parallel', 'session-1', 'session-2');

    expect(row?.sessionId).toBe('session-1');
    expect(row?.projectRoot).toBe('/Users/light/Projects/parallel');
  });

  it('syncs the selected session id directly from the chosen board row', () => {
    expect(resolveSelectedSessionId(board.rows[1])).toBe('session-2');
    expect(resolveSelectedSessionId(null)).toBeNull();
  });

  it('clears the selected session id when a selected root has no matching row', () => {
    const row = choosePrimaryBoardRow(board, '/Users/light/Projects/ghost', 'session-1', null);

    expect(resolveSelectedSessionId(row)).toBeNull();
  });

  it('falls back to the focus session when no explicit session matches the selected project', () => {
    const row = choosePrimaryBoardRow(
      board,
      '/Users/light/Projects/notes',
      null,
      'session-2',
    );

    expect(row?.sessionId).toBe('session-2');
    expect(row?.projectRoot).toBe('/Users/light/Projects/notes');
  });
});

describe('app copy', () => {
  it('keeps the focus-oriented copy trimmed to initialization and empty states', () => {
    expect(projectInitPrompt).toBe('Initialize workflow for this project.');
    expect(noProjectsInRootsMessage).toBe('No projects in current roots.');
    expect(emptySelectionMessage).toBe('Pick a project to see what you left off with.');
  });
});

describe('buildVisibleProjects', () => {
  it('keeps ensure_session resumable and flips to live when the current step is claimed', () => {
    const resumableState: LoadStatePayload = {
      settings: {
        watchedRoots: ['/Users/light/Projects'],
        lastFocusedProject: '/Users/light/Projects/parallel',
        mcp: { enabled: false, port: 4855, token: '' },
      },
      projects: [
        {
          id: 'parallel-1',
          name: 'parallel',
          root: '/Users/light/Projects/parallel',
          kind: 'software',
          owner: 'desktop-user',
          tags: [],
          initialized: true,
          status: 'in_progress',
          stale: false,
          missing: false,
          currentStepId: 'capture-requirements',
          currentStepTitle: 'Capture requirements',
          blockerCount: 0,
          totalStepCount: 1,
          completedStepCount: 0,
          activeSessionCount: 1,
          focusSessionId: 'session-1',
          lastUpdatedAt: '2026-04-16T19:24:12.870Z',
          nextAction: 'Write the initial problem statement and success criteria.',
          activeBranch: 'main',
          pendingProposalCount: 0,
          discoverySource: 'parallel',
          discoveryPath: null,
        },
      ],
      boardProjects: [
        {
          root: '/Users/light/Projects/parallel',
          sessions: [
            {
              id: 'session-1',
              title: 'Parallel session',
              actor: 'codex',
              source: 'agent',
              branch: 'main',
              status: 'active',
              owned_step_id: null,
              observed_step_ids: [],
              started_at: '2026-04-16T19:24:12.854Z',
              last_updated_at: '2026-04-16T19:24:12.870Z',
            },
          ],
          runtimeNextAction: 'Write the initial problem statement and success criteria.',
          blockers: [],
          recentActivity: [],
          activeStepLookup: {
            'capture-requirements': {
              title: 'Capture requirements',
              summary: 'Write the initial problem statement and success criteria.',
            },
          },
        },
      ],
      mcpRuntime: {
        status: 'stopped',
        boundPort: null,
        pid: null,
        startedAt: null,
        lastError: null,
      },
    };

    const liveState: LoadStatePayload = {
      ...resumableState,
      boardProjects: [
        {
          ...resumableState.boardProjects[0],
          sessions: [
            {
              ...resumableState.boardProjects[0].sessions[0],
              owned_step_id: 'capture-requirements',
            },
          ],
        },
      ],
    };

    expect(buildVisibleProjects(resumableState)[0]).toMatchObject({
      root: '/Users/light/Projects/parallel',
      lightState: 'resumable',
      lightLabel: 'Resumable',
    });
    expect(buildVisibleProjects(liveState)[0]).toMatchObject({
      root: '/Users/light/Projects/parallel',
      lightState: 'live',
      lightLabel: 'Live work',
    });
  });

  it('treats any owned step as live even when it is not the project current step', () => {
    const state: LoadStatePayload = {
      settings: {
        watchedRoots: ['/Users/light/Projects'],
        lastFocusedProject: '/Users/light/Projects/parallel',
        mcp: { enabled: false, port: 4855, token: '' },
      },
      projects: [
        {
          id: 'parallel-1',
          name: 'parallel',
          root: '/Users/light/Projects/parallel',
          kind: 'software',
          owner: 'desktop-user',
          tags: [],
          initialized: true,
          status: 'in_progress',
          stale: false,
          missing: false,
          currentStepId: 'capture-requirements',
          currentStepTitle: 'Capture requirements',
          blockerCount: 0,
          totalStepCount: 2,
          completedStepCount: 0,
          activeSessionCount: 2,
          focusSessionId: 'session-1',
          lastUpdatedAt: '2026-04-16T19:24:12.870Z',
          nextAction: 'Write the initial problem statement and success criteria.',
          activeBranch: 'main',
          pendingProposalCount: 0,
          discoverySource: 'parallel',
          discoveryPath: null,
        },
      ],
      boardProjects: [
        {
          root: '/Users/light/Projects/parallel',
          sessions: [
            {
              id: 'session-1',
              title: 'Parallel session',
              actor: 'codex',
              source: 'agent',
              branch: 'main',
              status: 'active',
              owned_step_id: null,
              observed_step_ids: [],
              started_at: '2026-04-16T19:24:12.854Z',
              last_updated_at: '2026-04-16T19:24:12.870Z',
            },
            {
              id: 'session-2',
              title: 'Outline session',
              actor: 'codex',
              source: 'agent',
              branch: 'main',
              status: 'active',
              owned_step_id: 'draft-outline',
              observed_step_ids: [],
              started_at: '2026-04-16T19:25:12.854Z',
              last_updated_at: '2026-04-16T19:25:12.870Z',
            },
          ],
          runtimeNextAction: 'Write the initial problem statement and success criteria.',
          blockers: [],
          recentActivity: [],
          activeStepLookup: {
            'capture-requirements': {
              title: 'Capture requirements',
              summary: 'Write the initial problem statement and success criteria.',
            },
            'draft-outline': {
              title: 'Draft outline',
              summary: 'Draft the outline.',
            },
          },
        },
      ],
      mcpRuntime: {
        status: 'stopped',
        boundPort: null,
        pid: null,
        startedAt: null,
        lastError: null,
      },
    };

    expect(buildVisibleProjects(state)[0]).toMatchObject({
      root: '/Users/light/Projects/parallel',
      lightState: 'live',
      lightLabel: 'Live work',
    });
  });
});
