import { describe, expect, it } from 'vitest';

import type { CliInstallStatus, LoadStatePayload } from './types';
import {
  describeAgentDefaultsStatus,
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

describe('agent defaults status helpers', () => {
  it('surfaces stale agent defaults as update-needed', () => {
    expect(
      describeAgentDefaultsStatus({
        kind: 'claudeDesktop',
        label: 'Claude Desktop',
        status: 'stale',
        reasons: ['stable_projectctl_not_installed'],
        global: null,
        repo: null,
        changedPaths: [],
      }),
    ).toEqual({
      tone: 'caution',
      label: 'Update needed',
      detail:
        'Install the projectctl CLI first so Claude Desktop can use a stable command path.',
      canInstall: false,
      canUpdate: true,
      canReinstall: true,
    });
  });

  it('describes stale endpoint tracking without blaming config shape', () => {
    expect(
      describeAgentDefaultsStatus({
        kind: 'codex',
        label: 'Codex',
        status: 'stale',
        reasons: ['bridge_endpoint_outdated'],
        global: null,
        repo: null,
        changedPaths: [],
      }),
    ).toEqual({
      tone: 'caution',
      label: 'Update needed',
      detail: 'This agent points at an older Parallel bridge endpoint.',
      canInstall: false,
      canUpdate: true,
      canReinstall: true,
    });
  });

  it('describes missing agent defaults as an unconfigured Parallel entry', () => {
    expect(
      describeAgentDefaultsStatus({
        kind: 'claudeDesktop',
        label: 'Claude Desktop',
        status: 'missing',
        reasons: [],
        global: null,
        repo: null,
        changedPaths: [],
      }),
    ).toEqual({
      tone: 'caution',
      label: 'Parallel not configured',
      detail: 'No Parallel entry is configured for this agent.',
      canInstall: true,
      canUpdate: false,
      canReinstall: true,
    });
  });

  it('treats installed repo-managed guidance as healthy', () => {
    expect(
      describeAgentDefaultsStatus({
        kind: 'codex',
        label: 'Codex',
        status: 'installed',
        reasons: ['repo_manages_parallel_guidance'],
        global: null,
        repo: null,
        changedPaths: [],
      }),
    ).toEqual({
      tone: 'positive',
      label: 'Installed',
      detail: 'This repo already carries its own Parallel guidance.',
      canInstall: false,
      canUpdate: false,
      canReinstall: true,
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
