import { describe, expect, it } from 'vitest';

import { deriveProjectLightState, projectLightLabel } from './project-light';
import type { BoardProjectDetail, ProjectSummary } from './types';

function buildProject(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: 'parallel-1',
    name: 'parallel',
    root: '/Users/light/Projects/parallel',
    kind: 'software',
    owner: 'light',
    tags: [],
    initialized: true,
    status: 'todo',
    stale: false,
    missing: false,
    currentStepId: 'capture-requirements',
    currentStepTitle: 'Capture requirements',
    blockerCount: 0,
    totalStepCount: 1,
    completedStepCount: 0,
    activeSessionCount: 1,
    focusSessionId: 'session-1',
    lastUpdatedAt: '2026-04-18T14:00:00.000Z',
    nextAction: 'Write the initial problem statement and success criteria.',
    activeBranch: 'main',
    pendingProposalCount: 0,
    discoverySource: 'parallel',
    discoveryPath: null,
    ...overrides,
  };
}

function buildBoardProject(overrides: Partial<BoardProjectDetail> = {}): BoardProjectDetail {
  return {
    root: '/Users/light/Projects/parallel',
    sessions: [
      {
        id: 'session-1',
        title: 'Parallel session',
        actor: 'agent-1',
        source: 'agent',
        branch: 'main',
        status: 'active',
        owned_step_id: 'capture-requirements',
        observed_step_ids: ['capture-requirements'],
        started_at: '2026-04-18T13:55:00.000Z',
        last_updated_at: '2026-04-18T14:00:00.000Z',
      },
    ],
    runtimeNextAction: 'Write the initial problem statement and success criteria.',
    blockers: [],
    recentActivity: [],
    activeStepLookup: {
      'capture-requirements': {
        title: 'Capture requirements',
        summary: 'Write the initial problem statement.',
      },
    },
    ...overrides,
  };
}

describe('deriveProjectLightState', () => {
  it('returns uninitialized for projects without workflow metadata', () => {
    expect(deriveProjectLightState(buildProject({ initialized: false, status: 'uninitialized' }))).toBe(
      'uninitialized',
    );
  });

  it('returns resumable when an active session exists without a claimed current step', () => {
    expect(
      deriveProjectLightState(
        buildProject({ status: 'in_progress' }),
        buildBoardProject({
          sessions: [
            {
              ...buildBoardProject().sessions[0],
              owned_step_id: null,
            },
          ],
        }),
      ),
    ).toBe('resumable');
  });

  it('returns live when the current step is owned by an active session', () => {
    expect(deriveProjectLightState(buildProject({ status: 'in_progress' }), buildBoardProject())).toBe(
      'live',
    );
  });

  it('returns blocked when blockers exist', () => {
    expect(
      deriveProjectLightState(
        buildProject({ status: 'in_progress' }),
        buildBoardProject({ blockers: ['Waiting on approval'] }),
      ),
    ).toBe('blocked');
  });

  it('returns live again when blockers clear while ownership remains', () => {
    const project = buildProject({ status: 'in_progress' });
    const blocked = buildBoardProject({ blockers: ['Waiting on approval'] });
    const unblocked = buildBoardProject();

    expect(deriveProjectLightState(project, blocked)).toBe('blocked');
    expect(deriveProjectLightState(project, unblocked)).toBe('live');
  });

  it('returns done for completed workflows without blockers', () => {
    expect(deriveProjectLightState(buildProject({ status: 'done', currentStepId: null }), buildBoardProject())).toBe(
      'done',
    );
  });

  it('does not let stale or missing flags override resumable state', () => {
    expect(
      deriveProjectLightState(
        buildProject({
          stale: true,
          missing: true,
          status: 'todo',
        }),
        buildBoardProject({
          sessions: [
            {
              ...buildBoardProject().sessions[0],
              owned_step_id: null,
            },
          ],
        }),
      ),
    ).toBe('resumable');
  });
});

describe('projectLightLabel', () => {
  it('returns the user-facing label for each light state', () => {
    expect(projectLightLabel('live')).toBe('Live work');
    expect(projectLightLabel('resumable')).toBe('Resumable');
    expect(projectLightLabel('blocked')).toBe('Blocked');
    expect(projectLightLabel('done')).toBe('Done');
    expect(projectLightLabel('uninitialized')).toBe('Uninitialized');
  });
});
