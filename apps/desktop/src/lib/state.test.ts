import { describe, expect, it } from 'vitest';

import type { CliInstallStatus, LoadStatePayload } from './types';
import {
  describeCliInstallStatus,
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
      discoverySource: null,
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
    setupStale: false,
    staleReasons: [],
    staleClients: [],
  },
};

describe('resolveSelectionState', () => {
  it('auto-selects the first project when nothing is focused', () => {
    const result = resolveSelectionState(baseState);

    expect(result.selectedRoot).toBe('/Users/light/Projects/baryon');
    expect(result.selectedProject?.initialized).toBe(false);
  });

  it('returns the initialized project when the selected project is active', () => {
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
    expect(result.selectedRoot).toBe('/Users/light/Projects/baryon');
    expect(result.selectedProject?.initialized).toBe(true);
  });

  it('keeps the last focused initialized project selected', () => {
    const state = {
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
          status: 'in_progress',
          stale: false,
          missing: false,
          currentStepId: 'draft-outline',
          currentStepTitle: 'Draft outline',
          blockerCount: 0,
          totalStepCount: 1,
          completedStepCount: 0,
          activeSessionCount: 1,
          focusSessionId: 'session-2',
          lastUpdatedAt: '2026-04-16T19:20:00.000Z',
          nextAction: 'Draft the outline.',
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
        setupStale: false,
        staleReasons: [],
        staleClients: [],
      },
    } satisfies LoadStatePayload;

    const result = resolveSelectionState(state);

    expect(result.selectedRoot).toBe('/Users/light/Projects/parallel');
    expect(result.selectedProject?.root).toBe('/Users/light/Projects/parallel');
  });

  it('falls back when the last focused project is no longer loaded', () => {
    const state = {
      ...baseState,
      settings: {
        ...baseState.settings,
        lastFocusedProject: '/Users/light/Projects/missing',
      },
      projects: [
        {
          ...baseState.projects[0],
          root: '/Users/light/Projects/parallel',
          name: 'parallel',
          initialized: true,
          status: 'todo',
          discoverySource: 'parallel',
          discoveryPath: null,
        },
      ],
    } satisfies LoadStatePayload;

    const result = resolveSelectionState(state);

    expect(result.selectedRoot).toBe('/Users/light/Projects/parallel');
    expect(result.selectedProject?.root).toBe('/Users/light/Projects/parallel');
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

describe('cli install status helpers', () => {
  const baseCliStatus: CliInstallStatus = {
    bundledPath: '/Applications/parallel.app/Contents/MacOS/projectctl',
    installPath: '/Users/light/bin/projectctl',
    installed: true,
    installDirOnPath: false,
    shellProfileConfigured: false,
    shellExport: 'export PATH="$HOME/bin:$PATH"',
    shellProfile: '/Users/light/.zshrc',
    persistCommand: 'echo \'export PATH="$HOME/bin:$PATH"\' >> $HOME/.zshrc',
  };

  it('treats shell profile configuration as ready for the next terminal session', () => {
    expect(
      describeCliInstallStatus({
        ...baseCliStatus,
        shellProfileConfigured: true,
      }),
    ).toEqual({
      tone: 'positive',
      label: 'Configured, open a new Terminal',
      detail: 'Your shell profile already adds this directory. Open a new Terminal window or source the profile if projectctl is still not found.',
      needsShellSetup: false,
    });
  });

  it('keeps showing shell setup instructions when no path configuration exists', () => {
    expect(describeCliInstallStatus(baseCliStatus)).toEqual({
      tone: 'caution',
      label: 'Installed, PATH update needed',
      detail: 'Add the install directory to your shell path. Profile: /Users/light/.zshrc',
      needsShellSetup: true,
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
