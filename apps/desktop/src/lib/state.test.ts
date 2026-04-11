import { describe, expect, it } from 'vitest';

import type { LoadStatePayload } from './types';
import {
  describeBridgeStatus,
  resolveSelectionState,
  runBootstrapTasks,
  shouldReconcileBridgeStatus,
} from './state';

const baseState: LoadStatePayload = {
  settings: {
    watchedRoots: ['/Users/light/Projects'],
    lastFocusedProject: null,
    mcp: {
      enabled: false,
      port: 4855,
      token: '',
    },
  },
  projects: [
    {
      id: null,
      name: 'baryon',
      root: '/Users/light/Projects/baryon',
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

describe('resolveSelectionState', () => {
  it('does not request detail for an auto-selected uninitialized repo', () => {
    const result = resolveSelectionState(baseState);

    expect(result.selectedRoot).toBe('/Users/light/Projects/baryon');
    expect(result.selectedProject?.initialized).toBe(false);
    expect(result.shouldLoadDetail).toBe(false);
  });

  it('requests detail for an initialized selected repo', () => {
    const initializedState: LoadStatePayload = {
      ...baseState,
      projects: [
        {
          ...baseState.projects[0],
          initialized: true,
          status: 'todo',
        },
      ],
    };

    const result = resolveSelectionState(initializedState);
    expect(result.shouldLoadDetail).toBe(true);
  });
});

describe('bridge status helpers', () => {
  it('treats a starting enabled bridge as needing reconciliation', () => {
    expect(
      shouldReconcileBridgeStatus({
        ...baseState,
        settings: {
          ...baseState.settings,
          mcp: {
            ...baseState.settings.mcp,
            enabled: true,
          },
        },
        mcpRuntime: {
          ...baseState.mcpRuntime,
          status: 'starting',
        },
      }),
    ).toBe(true);
  });

  it('describes a running bridge as ready', () => {
    expect(describeBridgeStatus({ ...baseState.mcpRuntime, status: 'running' }, true)).toEqual({
      tone: 'running',
      label: 'Ready',
      detail: 'Accepting local MCP requests on localhost.',
    });
  });
});

describe('runBootstrapTasks', () => {
  it('starts the initial load before listener registration completes', async () => {
    const events: string[] = [];
    let resolveListeners: (() => void) | null = null;

    const bootstrapPromise = runBootstrapTasks(
      () =>
        new Promise<void>((resolve) => {
          events.push('listeners:start');
          resolveListeners = () => {
            events.push('listeners:done');
            resolve();
          };
        }),
      async () => {
        events.push('load:start');
      },
    );

    expect(events).toEqual(['listeners:start', 'load:start']);

    resolveListeners?.();
    await bootstrapPromise;

    expect(events).toEqual(['listeners:start', 'load:start', 'listeners:done']);
  });
});
