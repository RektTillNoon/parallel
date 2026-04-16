import { describe, expect, it } from 'vitest';

import type { LoadStatePayload, ProjectDetail } from './types';
import {
  buildSessionBoard,
  chooseBoardSelection,
  type BoardProjectDetailMap,
} from './session-board';

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
    },
  ],
  mcpRuntime: {
    status: 'stopped',
    boundPort: null,
    pid: null,
    startedAt: null,
    lastError: null,
    setupStale: false,
    staleReasons: [],
    staleClients: [],
  },
};

const detailMap: BoardProjectDetailMap = new Map<string, ProjectDetail>([
  [
    '/Users/light/Projects/parallel',
    {
      manifest: {
        id: 'parallel-1',
        name: 'parallel',
        root: '/Users/light/Projects/parallel',
        kind: 'software',
        owner: 'desktop-user',
        tags: [],
        created_at: '2026-04-11T18:06:10.128Z',
      },
      plan: {
        phases: [
          {
            id: 'define',
            title: 'Define',
            steps: [
              {
                id: 'capture-requirements',
                title: 'Capture requirements',
                summary: 'Write the initial problem statement and success criteria.',
                status: 'in_progress',
                depends_on: [],
                details: ['Write the initial problem statement and success criteria.'],
                subtasks: [],
                owner_session_id: 'session-1',
                completed_at: null,
                completed_by: null,
              },
            ],
          },
        ],
      },
      runtime: {
        current_phase_id: 'define',
        current_step_id: 'capture-requirements',
        focus_session_id: 'session-1',
        next_action: 'Write the initial problem statement and success criteria.',
        status: 'in_progress',
        blockers: [],
        last_updated_at: '2026-04-16T19:24:12.870Z',
        active_branch: 'main',
        active_session_ids: ['session-1'],
      },
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
      recentActivity: [],
      blockers: [],
      pendingProposals: [],
      handoff: '',
      decisions: [],
    },
  ],
  [
    '/Users/light/Projects/notes',
    {
      manifest: {
        id: 'notes-1',
        name: 'notes',
        root: '/Users/light/Projects/notes',
        kind: 'software',
        owner: 'desktop-user',
        tags: [],
        created_at: '2026-04-11T18:06:10.128Z',
      },
      plan: {
        phases: [
          {
            id: 'draft',
            title: 'Draft',
            steps: [
              {
                id: 'draft-outline',
                title: 'Draft outline',
                summary: 'Resolve the blocker before drafting the outline.',
                status: 'blocked',
                depends_on: [],
                details: ['Resolve the blocker before drafting the outline.'],
                subtasks: [],
                owner_session_id: 'session-3',
                completed_at: null,
                completed_by: null,
              },
            ],
          },
        ],
      },
      runtime: {
        current_phase_id: 'draft',
        current_step_id: 'draft-outline',
        focus_session_id: 'session-3',
        next_action: 'Resolve the blocker before drafting the outline.',
        status: 'blocked',
        blockers: ['Waiting on approval'],
        last_updated_at: '2026-04-16T19:20:00.000Z',
        active_branch: 'main',
        active_session_ids: ['session-3', 'session-4'],
      },
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
      recentActivity: [],
      blockers: ['Waiting on approval'],
      pendingProposals: [],
      handoff: '',
      decisions: [],
    },
  ],
  [
    '/Users/light/Projects/ghost',
    {
      manifest: {
        id: 'ghost-1',
        name: 'ghost',
        root: '/Users/light/Projects/ghost',
        kind: 'software',
        owner: 'desktop-user',
        tags: [],
        created_at: '2026-04-11T18:06:10.128Z',
      },
      plan: {
        phases: [
          {
            id: 'ghost',
            title: 'Ghost',
            steps: [
              {
                id: 'ghost-step',
                title: 'Ghost step',
                summary: 'Should be ignored because the project is not loaded.',
                status: 'todo',
                depends_on: [],
                details: ['Should be ignored because the project is not loaded.'],
                subtasks: [],
                owner_session_id: 'ghost-session',
                completed_at: null,
                completed_by: null,
              },
            ],
          },
        ],
      },
      runtime: {
        current_phase_id: 'ghost',
        current_step_id: 'ghost-step',
        focus_session_id: 'ghost-session',
        next_action: 'Should be ignored because the project is not loaded.',
        status: 'todo',
        blockers: [],
        last_updated_at: '2026-04-16T19:00:00.000Z',
        active_branch: 'main',
        active_session_ids: ['ghost-session'],
      },
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
      recentActivity: [],
      blockers: [],
      pendingProposals: [],
      handoff: '',
      decisions: [],
    },
  ],
]);

describe('buildSessionBoard', () => {
  it('builds active session rows from loaded project details', () => {
    const board = buildSessionBoard(loadState, detailMap);

    expect(board.rows).toHaveLength(3);
    expect(board.rows[0]).toMatchObject({
      sessionId: 'session-1',
      sessionTitle: 'Validate agent bridge from Codex',
      repoName: 'parallel',
      stepId: 'capture-requirements',
      stepTitle: 'Capture requirements',
      summary: 'Write the initial problem statement and success criteria.',
      status: 'active',
    });
    expect(board.rows[1]).toMatchObject({
      sessionId: 'session-4',
      repoName: 'notes',
      stepId: null,
      stepTitle: 'No owned step',
      summary: 'Resolve the blocker before drafting the outline.',
      status: 'blocked',
    });
    expect(board.rows[2]).toMatchObject({
      sessionId: 'session-3',
      repoName: 'notes',
      status: 'blocked',
    });
  });

  it('excludes inactive sessions and ignores details not present in loaded projects', () => {
    const board = buildSessionBoard(loadState, detailMap);

    expect(board.rows.some((row) => row.sessionId === 'session-2')).toBe(false);
    expect(board.rows.some((row) => row.sessionId === 'ghost-session')).toBe(false);
  });

  it('sorts malformed timestamps after valid ones', () => {
    const malformedMap = new Map(detailMap);
    const parallelDetail = malformedMap.get('/Users/light/Projects/parallel');

    if (!parallelDetail) {
      throw new Error('expected parallel detail');
    }

    malformedMap.set('/Users/light/Projects/parallel', {
      ...parallelDetail,
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
          ...parallelDetail.sessions[0],
          last_updated_at: '2026-04-16T19:26:00.000Z',
        },
      ],
    });

    const singleProjectState: LoadStatePayload = {
      ...loadState,
      projects: [loadState.projects[0]],
    };

    const board = buildSessionBoard(singleProjectState, malformedMap);

    expect(board.rows.map((row) => row.sessionId)).toEqual(['session-1', 'broken-session']);
  });
});

describe('chooseBoardSelection', () => {
  it('prefers the explicit selected session id', () => {
    const board = buildSessionBoard(loadState, detailMap);

    expect(chooseBoardSelection(board, 'session-4')?.sessionId).toBe('session-4');
  });

  it('falls back to the first row and then null', () => {
    const board = buildSessionBoard(loadState, detailMap);

    expect(chooseBoardSelection(board, null)?.sessionId).toBe('session-1');
    expect(chooseBoardSelection({ rows: [] }, null)).toBeNull();
  });
});
