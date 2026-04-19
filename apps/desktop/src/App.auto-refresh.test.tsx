// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BoardProjectDetail, LoadStatePayload, ProjectSummary } from './lib/types';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  addWatchRoot: vi.fn(),
  applyAgentDefaults: vi.fn(),
  getAgentDefaultsStatus: vi.fn(),
  getBridgeClientSnippets: vi.fn(),
  getBridgeStatus: vi.fn(),
  getCliInstallStatus: vi.fn(),
  initProject: vi.fn(),
  installCli: vi.fn(),
  loadState: vi.fn(),
  refreshProjects: vi.fn(),
  regenerateBridgeToken: vi.fn(),
  removeWatchRoot: vi.fn(),
  restartBridge: vi.fn(),
  setBridgeEnabled: vi.fn(),
  setLastFocusedProject: vi.fn(),
}));

const tauriListeners = vi.hoisted(() => new Map<string, Array<(event: { payload: unknown }) => void>>());
const tauriUnlisteners = vi.hoisted(() => [] as Array<ReturnType<typeof vi.fn>>);

vi.mock('./lib/api', () => apiMocks);
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, callback: (event: { payload: unknown }) => void) => {
    const callbacks = tauriListeners.get(event) ?? [];
    callbacks.push(callback);
    tauriListeners.set(event, callbacks);
    const unlisten = vi.fn(() => {
      const current = tauriListeners.get(event) ?? [];
      tauriListeners.set(
        event,
        current.filter((candidate) => candidate !== callback),
      );
    });
    tauriUnlisteners.push(unlisten);
    return unlisten;
  }),
}));

import App from './App';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

const projectRoot = '/Users/light/Projects/parallel';
const secondSessionId = 'session-2';

function buildProjectSummary(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: 'parallel-1',
    name: 'parallel',
    root: projectRoot,
    kind: 'software',
    owner: 'light',
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
    lastUpdatedAt: '2026-04-18T14:00:00.000Z',
    nextAction: 'Write the initial problem statement and success criteria.',
    activeBranch: 'main',
    pendingProposalCount: 0,
    discoverySource: 'parallel',
    discoveryPath: null,
    ...overrides,
  };
}

function buildBoardProject(): BoardProjectDetail {
  return {
    root: projectRoot,
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
      {
        id: secondSessionId,
        title: 'Second session',
        actor: 'agent-2',
        source: 'agent',
        branch: 'main',
        status: 'active',
        owned_step_id: 'draft-outline',
        observed_step_ids: ['draft-outline'],
        started_at: '2026-04-18T13:58:00.000Z',
        last_updated_at: '2026-04-18T14:01:00.000Z',
      },
    ],
    runtimeNextAction: 'Write the initial problem statement and success criteria.',
    blockers: [],
    recentActivity: [
      {
        timestamp: '2026-04-18T14:01:00.000Z',
        actor: 'agent-2',
        source: 'agent',
        project_id: 'parallel-1',
        session_id: secondSessionId,
        step_id: 'draft-outline',
        subtask_id: null,
        type: 'note.added',
        summary: 'Second session note',
        payload: {},
      },
      {
        timestamp: '2026-04-18T14:00:00.000Z',
        actor: 'agent-1',
        source: 'agent',
        project_id: 'parallel-1',
        session_id: 'session-1',
        step_id: 'capture-requirements',
        subtask_id: null,
        type: 'note.added',
        summary: 'Parallel session note',
        payload: {},
      },
    ],
    activeStepLookup: {
      'capture-requirements': {
        title: 'Capture requirements',
        summary: 'Write the initial problem statement.',
      },
      'draft-outline': {
        title: 'Draft outline',
        summary: 'Draft the outline.',
      },
    },
  };
}

function buildLoadState(overrides: Partial<LoadStatePayload> = {}): LoadStatePayload {
  return {
    settings: {
      watchedRoots: ['/Users/light/Projects'],
      lastFocusedProject: projectRoot,
      mcp: {
        enabled: false,
        port: 4855,
        token: '',
      },
    },
    projects: [buildProjectSummary()],
    boardProjects: [buildBoardProject()],
    mcpRuntime: {
      status: 'stopped',
      boundPort: null,
      pid: null,
      startedAt: null,
      lastError: null,
    },
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function emitTauriEvent(name: string, payload?: unknown) {
  await act(async () => {
    for (const callback of tauriListeners.get(name) ?? []) {
      callback({ payload });
    }
  });
}

function setVisibilityState(value: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => value,
  });
}

function queryButtons(container: HTMLElement) {
  return Array.from(container.querySelectorAll('button'));
}

function findButton(container: HTMLElement, label: string) {
  return queryButtons(container).find((button) => button.textContent?.includes(label)) ?? null;
}

describe('App auto refresh', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T14:02:00.000Z'));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    tauriListeners.clear();
    tauriUnlisteners.length = 0;
    setVisibilityState('visible');
    for (const mock of Object.values(apiMocks)) {
      mock.mockReset();
    }
    apiMocks.loadState.mockResolvedValue(buildLoadState());
    apiMocks.refreshProjects.mockResolvedValue(buildLoadState());
    apiMocks.getBridgeStatus.mockResolvedValue(null);
    apiMocks.getCliInstallStatus.mockResolvedValue(null);
    apiMocks.getAgentDefaultsStatus.mockResolvedValue([]);
    apiMocks.setBridgeEnabled.mockResolvedValue(buildLoadState());
    apiMocks.restartBridge.mockResolvedValue(buildLoadState());
    apiMocks.regenerateBridgeToken.mockResolvedValue(buildLoadState());
    apiMocks.addWatchRoot.mockResolvedValue(buildLoadState());
    apiMocks.removeWatchRoot.mockResolvedValue(buildLoadState());
    apiMocks.initProject.mockResolvedValue(buildLoadState());
    apiMocks.installCli.mockResolvedValue(null);
    apiMocks.applyAgentDefaults.mockResolvedValue(null);
    apiMocks.getBridgeClientSnippets.mockResolvedValue([]);
    apiMocks.setLastFocusedProject.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  async function renderApp() {
    await act(async () => {
      root.render(<App />);
    });
    await flush();
  }

  it('renders Sync with an auto-refresh affordance', async () => {
    await renderApp();

    const button = findButton(container, 'Sync');

    expect(button).not.toBeNull();
    expect(findButton(container, 'Refresh Repos')).toBeNull();
    expect(button?.getAttribute('title')).toContain('Tracked project state refreshes automatically');
  });

  it('uses loadState for background refresh and not refreshProjects', async () => {
    await renderApp();
    expect(apiMocks.loadState).toHaveBeenCalledTimes(1);
    expect(apiMocks.refreshProjects).not.toHaveBeenCalled();

    await advance(15100);

    expect(apiMocks.loadState).toHaveBeenCalledTimes(2);
    expect(apiMocks.refreshProjects).not.toHaveBeenCalled();
  });

  it('keeps the last visible UI and does not surface errors during a background failure', async () => {
    const nextLoad = deferred<LoadStatePayload>();
    apiMocks.loadState
      .mockResolvedValueOnce(buildLoadState())
      .mockImplementationOnce(() => nextLoad.promise);

    await renderApp();
    expect(container.textContent).toContain('Active sessions');

    await advance(15100);

    expect(apiMocks.loadState).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('Loading state…');
    expect(container.querySelector('.error-banner')).toBeNull();

    nextLoad.reject(new Error('background load failed'));
    await flush();

    expect(container.textContent).toContain('Active sessions');
    expect(container.querySelector('.error-banner')).toBeNull();
  });

  it('uses the longer hidden cadence after visibilitychange', async () => {
    await renderApp();
    expect(apiMocks.loadState).toHaveBeenCalledTimes(1);

    setVisibilityState('hidden');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await advance(45000);
    expect(apiMocks.loadState).toHaveBeenCalledTimes(1);

    await advance(15100);
    expect(apiMocks.loadState).toHaveBeenCalledTimes(2);
  });

  it('refreshes immediately on focus and resets the visible timer window', async () => {
    await renderApp();
    expect(apiMocks.loadState).toHaveBeenCalledTimes(1);

    await advance(10000);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await advance(100);

    expect(apiMocks.loadState).toHaveBeenCalledTimes(2);

    await advance(14900);
    expect(apiMocks.loadState).toHaveBeenCalledTimes(2);

    await advance(5100);
    expect(apiMocks.loadState).toHaveBeenCalledTimes(3);
  });

  it('collapses a watcher event and timer tick into one snapshot reload', async () => {
    await renderApp();
    expect(apiMocks.loadState).toHaveBeenCalledTimes(1);

    await advance(14950);
    await emitTauriEvent('workflow://snapshot-changed');
    await advance(150);

    expect(apiMocks.loadState).toHaveBeenCalledTimes(2);
  });

  it('stops the auto-refresh timer and listeners on unmount', async () => {
    await renderApp();
    expect(apiMocks.loadState).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });

    await advance(60000);
    expect(apiMocks.loadState).toHaveBeenCalledTimes(1);
    expect(tauriUnlisteners).toHaveLength(3);
    expect(tauriUnlisteners.every((unlisten) => unlisten.mock.calls.length === 1)).toBe(true);
  });

  it('does not change the selected session when a background refresh keeps the same pair', async () => {
    apiMocks.loadState
      .mockResolvedValueOnce(buildLoadState())
      .mockResolvedValue(buildLoadState());

    await renderApp();

    const secondSessionButton = findButton(container, 'Second session');
    expect(secondSessionButton).not.toBeNull();

    await act(async () => {
      secondSessionButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(secondSessionButton?.getAttribute('aria-pressed')).toBe('true');

    await advance(15100);

    const refreshedSecondSessionButton = findButton(container, 'Second session');
    expect(refreshedSecondSessionButton?.getAttribute('aria-pressed')).toBe('true');
  });
});
