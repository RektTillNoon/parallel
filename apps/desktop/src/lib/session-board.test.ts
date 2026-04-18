import { describe, expect, it } from 'vitest';

import type { BoardProjectDetail, LoadStatePayload } from './types';
import { buildSessionBoard, chooseBoardSelection } from './session-board';

const loadState: LoadStatePayload = {
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
    {
      id: 'notes-1',
      name: 'notes',
      root: '/Users/light/Projects/notes',
      kind: 'software',
      owner: 'desktop-user',
      tags: [],
      initialized: true,
      status: 'todo',
      stale: false,
      missing: false,
      currentStepId: 'draft-outline',
      currentStepTitle: 'Draft outline',
      blockerCount: 1,
      totalStepCount: 1,
      completedStepCount: 0,
      activeSessionCount: 2,
      focusSessionId: 'session-3',
      lastUpdatedAt: '2026-04-16T19:20:00.000Z',
      nextAction: 'Resolve the blocker before drafting the outline.',
      activeBranch: 'main',
      pendingProposalCount: 0,
      discoverySource: 'parallel',
      discoveryPath: null,
    },
  ],
  boardProjects: [],
  mcpRuntime: {
    status: 'stopped',
    boundPort: null,
    pid: null,
    startedAt: null,
    lastError: null,
  },
};

const boardProjects: BoardProjectDetail[] = [
  {
    root: '/Users/light/Projects/parallel',
    sessions: [
        {
          id: 'session-1',
          title: 'Validate agent bridge from Codex',
          actor: 'codex',
          source: 'agent',
          branch: 'main',
          status: 'active',
          owned_step_id: 'capture-requirements',
          observed_step_ids: [],
          started_at: '2026-04-16T19:24:12.854Z',
          last_updated_at: '2026-04-16T19:24:12.870Z',
        },
        {
          id: 'session-2',
          title: 'Inactive session',
          actor: 'codex',
          source: 'agent',
          branch: 'main',
          status: 'done',
          owned_step_id: null,
          observed_step_ids: [],
          started_at: '2026-04-16T18:24:12.854Z',
          last_updated_at: '2026-04-16T18:24:12.870Z',
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
  {
    root: '/Users/light/Projects/notes',
    sessions: [
        {
          id: 'session-3',
          title: 'Draft planning notes',
          actor: 'codex',
          source: 'agent',
          branch: 'main',
          status: 'active',
          owned_step_id: 'draft-outline',
          observed_step_ids: [],
          started_at: '2026-04-16T19:10:00.000Z',
          last_updated_at: '2026-04-16T19:10:00.000Z',
        },
        {
          id: 'session-4',
          title: 'Follow-up session',
          actor: 'codex',
          source: 'agent',
          branch: 'main',
          status: 'active',
          owned_step_id: null,
          observed_step_ids: [],
          started_at: '2026-04-16T19:15:00.000Z',
          last_updated_at: '2026-04-16T19:15:00.000Z',
        },
    ],
    runtimeNextAction: 'Resolve the blocker before drafting the outline.',
    blockers: ['Waiting on approval'],
    recentActivity: [],
    activeStepLookup: {
      'draft-outline': {
        title: 'Draft outline',
        summary: 'Resolve the blocker before drafting the outline.',
      },
    },
  },
  {
    root: '/Users/light/Projects/ghost',
    sessions: [
        {
          id: 'ghost-session',
          title: 'Ghost session',
          actor: 'codex',
          source: 'agent',
          branch: 'main',
          status: 'active',
          owned_step_id: 'ghost-step',
          observed_step_ids: [],
          started_at: '2026-04-16T19:00:00.000Z',
          last_updated_at: '2026-04-16T19:00:00.000Z',
        },
    ],
    runtimeNextAction: 'Should be ignored because the project is not loaded.',
    blockers: [],
    recentActivity: [],
    activeStepLookup: {
      'ghost-step': {
        title: 'Ghost step',
        summary: 'Should be ignored because the project is not loaded.',
      },
    },
  },
];

const loadStateWithBoardProjects: LoadStatePayload = {
  ...loadState,
  boardProjects,
};

describe('buildSessionBoard', () => {
  it('builds active session rows from board projects', () => {
    const board = buildSessionBoard(loadStateWithBoardProjects);

    expect(board.rows).toHaveLength(3);
    expect(board.rows[0]).toMatchObject({
      sessionId: 'session-1',
      sessionTitle: 'Validate agent bridge from Codex',
      projectName: 'parallel',
      stepId: 'capture-requirements',
      stepTitle: 'Capture requirements',
      summary: 'Write the initial problem statement and success criteria.',
      status: 'active',
    });
    expect(board.rows[1]).toMatchObject({
      sessionId: 'session-4',
      projectName: 'notes',
      stepId: null,
      stepTitle: 'No owned step',
      summary: 'Resolve the blocker before drafting the outline.',
      status: 'blocked',
    });
    expect(board.rows[2]).toMatchObject({
      sessionId: 'session-3',
      projectName: 'notes',
      status: 'blocked',
    });
  });

  it('excludes inactive sessions and ignores board projects not present in loaded projects', () => {
    const board = buildSessionBoard(loadStateWithBoardProjects);

    expect(board.rows.some((row) => row.sessionId === 'session-2')).toBe(false);
    expect(board.rows.some((row) => row.sessionId === 'ghost-session')).toBe(false);
  });

  it('sorts malformed timestamps after valid ones', () => {
    const malformedProjects: BoardProjectDetail[] = boardProjects.map((project) =>
      project.root === '/Users/light/Projects/parallel'
        ? {
            ...project,
            sessions: [
        {
          id: 'broken-session',
          title: 'Broken timestamp session',
          actor: 'codex',
          source: 'agent',
          branch: 'main',
          status: 'active',
          owned_step_id: 'capture-requirements',
          observed_step_ids: [],
          started_at: '2026-04-16T19:25:00.000Z',
          last_updated_at: 'not-a-timestamp',
        },
        {
          ...project.sessions[0],
          last_updated_at: '2026-04-16T19:26:00.000Z',
        },
      ],
          }
        : project,
    );

    const singleProjectState: LoadStatePayload = {
      ...loadStateWithBoardProjects,
      projects: [loadStateWithBoardProjects.projects[0]],
      boardProjects: malformedProjects,
    };

    const board = buildSessionBoard(singleProjectState);

    expect(board.rows.map((row) => row.sessionId)).toEqual(['session-1', 'broken-session']);
  });
});

describe('chooseBoardSelection', () => {
  it('prefers the explicit selected session id', () => {
    const board = buildSessionBoard(loadStateWithBoardProjects);

    expect(chooseBoardSelection(board, 'session-4')?.sessionId).toBe('session-4');
  });

  it('falls back to the first row and then null', () => {
    const board = buildSessionBoard(loadStateWithBoardProjects);

    expect(chooseBoardSelection(board, null)?.sessionId).toBe('session-1');
    expect(chooseBoardSelection({ rows: [] }, null)).toBeNull();
  });
});
