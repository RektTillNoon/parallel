import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  Suspense,
  lazy,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  addWatchRoot,
  applyAgentDefaults,
  getCliInstallStatus,
  getAgentDefaultsStatus,
  getBridgeClientSnippets,
  getBridgeDoctor,
  getBridgeStatus,
  hideMenuBarPopover,
  initProject,
  installCli,
  loadState,
  openDashboard,
  refreshProjects,
  regenerateBridgeToken,
  removeWatchRoot,
  restartBridge,
  setBridgeEnabled,
  setLastFocusedProject,
} from './lib/api';
import {
  describeBridgeStatus,
  resolveSelectionState,
  runBootstrapTasks,
  shouldReconcileBridgeStatus,
} from './lib/state';
import {
  buildSessionBoard,
  chooseBoardSelection,
  type SessionBoardData,
  type SessionBoardRow,
} from './lib/session-board';
import {
  deriveProjectLightState,
  projectLightLabel,
  type ProjectSummaryWithLight,
} from './lib/project-light';
import FocusView, { resolveLastTouchedPhrase } from './components/FocusView';
import ProjectSwitcher, { hideNestedProjects, sortProjectsByRecency } from './components/ProjectSwitcher';
import ShaderBackdrop from './components/ShaderBackdrop';
import type {
  AgentInstallAction,
  AgentTargetStatus,
  BoardProjectDetail,
  BridgeStateEvent,
  BridgeDoctorReport,
  CliInstallStatus,
  LoadStatePayload,
  ProjectSummary,
} from './lib/types';

const emptyLoadState: LoadStatePayload = {
  settings: {
    watchedRoots: [],
    lastFocusedProject: null,
    mcp: {
      enabled: false,
      port: 4855,
      token: '',
    },
  },
  projects: [],
  boardProjects: [],
  mcpRuntime: {
    status: 'stopped',
    boundPort: null,
    pid: null,
    startedAt: null,
    lastError: null,
  },
};

const LazySettingsModal = lazy(() => import('./components/SettingsModal'));
const AUTO_REFRESH_INTERVAL_MS = 15_000;
const HIDDEN_AUTO_REFRESH_INTERVAL_MS = 60_000;
const AUTO_REFRESH_COALESCE_MS = 100;
const MOTION_REDUCE_QUERY = '(prefers-reduced-motion: reduce)';

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void | Promise<void>) => {
    finished: Promise<void>;
  };
};

export function choosePrimaryBoardRow(
  board: SessionBoardData,
  selectedRoot: string | null,
  selectedSessionId: string | null,
  focusSessionId: string | null,
): SessionBoardRow | null {
  if (selectedRoot) {
    return (
      board.rows.find(
        (row) => row.projectRoot === selectedRoot && row.sessionId === selectedSessionId,
      ) ??
      board.rows.find(
        (row) => row.projectRoot === selectedRoot && row.sessionId === focusSessionId,
      ) ??
      board.rows.find((row) => row.projectRoot === selectedRoot) ??
      null
    );
  }

  return chooseBoardSelection(board, selectedSessionId);
}

export function resolveSelectedSessionId(selectedBoardRow: SessionBoardRow | null) {
  return selectedBoardRow?.sessionId ?? null;
}

export function buildVisibleProjects(state: LoadStatePayload | null): ProjectSummaryWithLight[] {
  const boardProjectLookup = new Map(
    (state?.boardProjects ?? []).map((project) => [project.root, project] as const),
  );
  return sortProjectsByRecency(hideNestedProjects(state?.projects ?? [])).map((project) => {
    const lightState = deriveProjectLightState(project, boardProjectLookup.get(project.root));
    return {
      ...project,
      lightState,
      lightLabel: projectLightLabel(lightState),
    };
  });
}

export const projectInitPrompt = 'Initialize workflow for this project.';
export const noProjectsInRootsMessage = 'No projects in current roots.';
export const emptySelectionMessage = 'Pick a project to see what you left off with.';

export type EmptyStateCopy = {
  title: string;
  detail: string | null;
  actionLabel: string | null;
};

export type DesktopSurface = 'dashboard' | 'menubar';

export function resolveDesktopSurface(search: string): DesktopSurface {
  return new URLSearchParams(search).get('surface') === 'menubar' ? 'menubar' : 'dashboard';
}

export function buildMenubarStats(board: SessionBoardData) {
  return {
    activeCount: board.rows.length,
    blockedCount: board.rows.filter((row) => row.displayState === 'blocked').length,
    unclaimedCount: board.rows.filter((row) => row.displayState === 'needs-step').length,
  };
}

type MenubarProjectOption = Pick<ProjectSummary, 'name' | 'root'>;

export function chooseMenubarProject<T extends MenubarProjectOption>(
  projects: T[],
  selectedRoot: string | null,
): T | null {
  if (projects.length === 0) {
    return null;
  }
  return projects.find((project) => project.root === selectedRoot) ?? projects[0];
}

export function chooseAdjacentMenubarProjectRoot<T extends MenubarProjectOption>(
  projects: T[],
  selectedRoot: string | null,
  direction: -1 | 1,
): string | null {
  if (projects.length === 0) {
    return null;
  }

  const currentIndex = Math.max(
    0,
    projects.findIndex((project) => project.root === selectedRoot),
  );
  const nextIndex = (currentIndex + direction + projects.length) % projects.length;
  return projects[nextIndex].root;
}

export function resolveMenubarProjectKeyDirection(key: string): -1 | 1 | null {
  if (key === 'ArrowLeft') {
    return -1;
  }
  if (key === 'ArrowRight') {
    return 1;
  }
  return null;
}

export function buildMenubarProjectPosition<T extends MenubarProjectOption>(
  projects: T[],
  selectedRoot: string | null,
) {
  const selectedIndex = projects.findIndex((project) => project.root === selectedRoot);
  if (selectedIndex < 0 || projects.length === 0) {
    return null;
  }
  return `${selectedIndex + 1} of ${projects.length}`;
}

export function buildMenubarFreshnessLabel(value: string | null | undefined) {
  const phrase = resolveLastTouchedPhrase(value);
  return phrase === 'Never touched' ? phrase : `Updated ${phrase}`;
}

export function buildEmptyState(
  noProjectsDiscovered: boolean,
  context: { hasState: boolean; watchedRootCount: number },
): EmptyStateCopy {
  if (context.hasState && context.watchedRootCount === 0) {
    return {
      title: 'Add a project root to start.',
      detail: 'Parallel watches folders where Codex or Claude Code work happens.',
      actionLabel: 'Open setup',
    };
  }

  if (noProjectsDiscovered) {
    return {
      title: noProjectsInRootsMessage,
      detail: 'Use Sync after adding or initializing a workflow in one of the watched folders.',
      actionLabel: null,
    };
  }

  return {
    title: emptySelectionMessage,
    detail: null,
    actionLabel: null,
  };
}

function startViewTransition(update: () => void) {
  const nextDocument = document as ViewTransitionDocument;
  if (
    nextDocument.startViewTransition &&
    !window.matchMedia(MOTION_REDUCE_QUERY).matches
  ) {
    nextDocument.startViewTransition(update);
    return;
  }

  update();
}

type MenubarPopoverProps = {
  projects: ProjectSummaryWithLight[];
  project: ProjectSummaryWithLight | null;
  detail: BoardProjectDetail | null;
  session: SessionBoardRow | null;
  summary: string;
  stats: ReturnType<typeof buildMenubarStats>;
  loading: boolean;
  error: string | null;
  onSync: () => void;
  onSelectProject: (project: ProjectSummaryWithLight) => void;
  onCycleProject: (direction: -1 | 1) => void;
  onOpenDashboard: () => void;
  onHide: () => void;
};

export function MenubarPopover({
  projects,
  project,
  detail,
  session,
  summary,
  stats,
  loading,
  error,
  onSync,
  onSelectProject,
  onCycleProject,
  onOpenDashboard,
  onHide,
}: MenubarPopoverProps) {
  const selectedDotRef = useRef<HTMLButtonElement | null>(null);
  const selectedPosition = buildMenubarProjectPosition(projects, project?.root ?? null);
  const freshnessLabel = buildMenubarFreshnessLabel(session?.lastUpdatedAt ?? project?.lastUpdatedAt);
  const nextAction = summary.trim();
  const showNextAction = Boolean(nextAction) && session?.stepState !== 'owned';

  useEffect(() => {
    selectedDotRef.current?.scrollIntoView({
      block: 'nearest',
      inline: 'center',
    });
  }, [project?.root]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const direction = resolveMenubarProjectKeyDirection(event.key);
      if (direction === null) {
        return;
      }
      event.preventDefault();
      onCycleProject(direction);
    },
    [onCycleProject],
  );

  return (
    <div
      className="menubar-popover"
      onKeyDown={handleKeyDown}
      tabIndex={0}
      aria-label="Parallel menu"
    >
      <header className="menubar-head">
        <div>
          <p className="menubar-kicker">parallel</p>
          <p className="menubar-global-status">{stats.activeCount} active</p>
        </div>
        <div className="menubar-actions">
          <button type="button" onClick={onSync} aria-label="Refresh tracked projects">
            ↻
          </button>
          <button type="button" onClick={onHide} aria-label="Hide Parallel">
            ×
          </button>
        </div>
      </header>

      <nav className="menubar-project-rail" aria-label="Projects">
        <button
          type="button"
          className="menubar-rail-button"
          onClick={() => onCycleProject(-1)}
          disabled={projects.length < 2}
          aria-label="Previous project"
        >
          ‹
        </button>
        <div className="menubar-project-track">
          <div className="menubar-project-dots">
            {projects.map((candidate) => (
              <button
                type="button"
                className={`menubar-project-dot ${candidate.root === project?.root ? 'is-selected' : ''}`.trim()}
                data-status={candidate.lightState}
                key={candidate.root}
                ref={candidate.root === project?.root ? selectedDotRef : null}
                onClick={() => onSelectProject(candidate)}
                aria-label={candidate.name}
                aria-current={candidate.root === project?.root ? 'page' : undefined}
                title={candidate.name}
              />
            ))}
          </div>
        </div>
        <button
          type="button"
          className="menubar-rail-button"
          onClick={() => onCycleProject(1)}
          disabled={projects.length < 2}
          aria-label="Next project"
        >
          ›
        </button>
      </nav>

      {project ? (
        <section className="menubar-project-identity" aria-label="Selected project">
          <div className="menubar-project-identity-head">
            <div className="menubar-project-title-block">
              <p className="menubar-project-label">Viewing project</p>
              <h2 className="menubar-project-name">{project.name}</h2>
            </div>
            <div className="menubar-project-state">
              <span className="menubar-project-state-dot" data-status={project.lightState} />
              <span>{project.lightLabel}</span>
            </div>
          </div>
          <div className="menubar-project-meta-row">
            {project.activeBranch ? (
              <span className="menubar-project-branch">{project.activeBranch}</span>
            ) : null}
            {selectedPosition ? (
              <span className="menubar-project-position">{selectedPosition}</span>
            ) : null}
            <span className="menubar-project-freshness">{freshnessLabel}</span>
          </div>
          {showNextAction ? (
            <div className="menubar-next-action">
              <span>Next</span>
              <p>{nextAction}</p>
            </div>
          ) : null}
        </section>
      ) : null}

      <div className="menubar-scroll">
        {loading ? <div className="menubar-empty">Loading…</div> : null}
        {error ? <div className="menubar-error">{error}</div> : null}

        {!loading && project ? (
          <div className="menubar-dashboard">
            <FocusView project={project} detail={detail} session={session} summary={summary} />
          </div>
        ) : null}

        {!loading && !project ? (
          <div className="menubar-empty">No projects in current roots.</div>
        ) : null}
      </div>

      <footer className="menubar-foot">
        <button type="button" onClick={onOpenDashboard}>
          Open dashboard
        </button>
      </footer>
    </div>
  );
}

export default function App() {
  const surface = resolveDesktopSurface(window.location.search);
  const [state, setState] = useState<LoadStatePayload | null>(null);
  const [selectedRoot, setSelectedRoot] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [initPending, setInitPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [watchRootInput, setWatchRootInput] = useState('');
  const [watchRootError, setWatchRootError] = useState<string | null>(null);
  const [watchRootPending, setWatchRootPending] = useState(false);
  const [initName, setInitName] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rootsOpen, setRootsOpen] = useState(false);
  const [bridgeOpen, setBridgeOpen] = useState(true);
  const [agentDefaultsOpen, setAgentDefaultsOpen] = useState(true);
  const [cliStatus, setCliStatus] = useState<CliInstallStatus | null>(null);
  const [agentStatuses, setAgentStatuses] = useState<AgentTargetStatus[] | null>(null);
  const [bridgeDoctor, setBridgeDoctor] = useState<BridgeDoctorReport | null>(null);
  const [bridgeDoctorPending, setBridgeDoctorPending] = useState(false);
  const [agentPendingKind, setAgentPendingKind] = useState<string | null>(null);
  const [cliPending, setCliPending] = useState(false);
  const reloadInFlight = useRef(false);
  const reloadQueued = useRef<
    | {
        selectRoot?: string | null;
        mode: 'foreground' | 'background';
      }
    | undefined
  >(undefined);
  const selectedRootRef = useRef<string | null>(null);
  const lastAutoRefreshAtRef = useRef<number | null>(null);
  const autoRefreshTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    selectedRootRef.current = selectedRoot;
  }, [selectedRoot]);

  const applyLoadState = useCallback(
    (nextState: LoadStatePayload, options?: { selectRoot?: string | null }) => {
      setState(nextState);
      const selection = resolveSelectionState(nextState, options?.selectRoot ?? selectedRootRef.current);
      setSelectedRoot(selection.selectedRoot);
    },
    [],
  );

  const reloadState = useCallback(
    async (
      selectRoot?: string | null,
      options?: {
        mode?: 'foreground' | 'background';
      },
    ) => {
      const mode = options?.mode ?? 'foreground';
      if (reloadInFlight.current) {
        reloadQueued.current = { selectRoot, mode };
        return;
      }

      reloadInFlight.current = true;
      if (mode === 'foreground') {
        setLoading(true);
        setError(null);
      }
      try {
        const nextState = await loadState();
        if (!nextState) {
          throw new Error('load_state returned no payload');
        }
        await applyLoadState(nextState, { selectRoot });
      } catch (loadError) {
        if (mode === 'foreground') {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      } finally {
        reloadInFlight.current = false;
        if (mode === 'foreground') {
          setLoading(false);
        }
        if (reloadQueued.current !== undefined) {
          const queued = reloadQueued.current;
          reloadQueued.current = undefined;
          void reloadState(queued.selectRoot, { mode: queued.mode });
        }
      }
    },
    [applyLoadState],
  );

  const scheduleAutoRefresh = useCallback(() => {
    if (!isTauri()) {
      return;
    }
    if (autoRefreshTimeoutRef.current !== null) {
      return;
    }
    autoRefreshTimeoutRef.current = window.setTimeout(() => {
      autoRefreshTimeoutRef.current = null;
      lastAutoRefreshAtRef.current = Date.now();
      void reloadState(selectedRootRef.current, { mode: 'background' });
    }, AUTO_REFRESH_COALESCE_MS);
  }, [reloadState]);

  const reconcileBridgeState = useCallback(async () => {
    try {
      const snapshot = await getBridgeStatus();
      if (!snapshot) {
        return;
      }

      setState((current) =>
        current
          ? {
              ...current,
              settings: {
                ...current.settings,
                mcp: snapshot.mcp,
              },
              mcpRuntime: snapshot.mcpRuntime,
            }
          : current,
      );
    } catch {
      // Keep the last visible bridge snapshot if a background reconcile misses.
    }
  }, []);

  const handleRunBridgeDoctor = useCallback(async () => {
    setBridgeDoctorPending(true);
    try {
      const report = await getBridgeDoctor();
      setBridgeDoctor(report);
      return report;
    } catch (doctorError) {
      setError(doctorError instanceof Error ? doctorError.message : String(doctorError));
      return null;
    } finally {
      setBridgeDoctorPending(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const unlisteners: Array<() => void> = [];

    void runBootstrapTasks(
      async () => {
        if (!isTauri()) {
          return;
        }

        const unlistenSnapshot = await listen('workflow://snapshot-changed', () => {
          scheduleAutoRefresh();
        });
        if (!active) {
          unlistenSnapshot();
          return;
        }
        unlisteners.push(unlistenSnapshot);

        const unlistenTopology = await listen('workflow://topology-changed', () => {
          void (async () => {
            try {
              const nextState = await refreshProjects();
              await applyLoadState(nextState, { selectRoot: selectedRootRef.current });
            } catch {
              void reloadState(selectedRootRef.current);
            }
          })();
        });
        if (!active) {
          unlistenTopology();
          return;
        }
        unlisteners.push(unlistenTopology);

        const unlistenBridge = await listen<BridgeStateEvent>('bridge://state-changed', (event) => {
          setState((current) =>
            current
              ? {
                  ...current,
                  settings: {
                    ...current.settings,
                    mcp: event.payload.mcp,
                  },
                  mcpRuntime: event.payload.mcpRuntime,
                }
              : current,
          );
        });
        if (!active) {
          unlistenBridge();
          return;
        }
        unlisteners.push(unlistenBridge);
      },
      async () => {
        if (active) {
          await reloadState(undefined, { mode: 'foreground' });
          lastAutoRefreshAtRef.current = Date.now();
        }
      },
    );

    return () => {
      active = false;
      if (autoRefreshTimeoutRef.current !== null) {
        window.clearTimeout(autoRefreshTimeoutRef.current);
        autoRefreshTimeoutRef.current = null;
      }
      for (const unlisten of unlisteners) {
        unlisten();
      }
    };
  }, [applyLoadState, reloadState, scheduleAutoRefresh]);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }

    const shouldAutoRefreshNow = () => {
      const now = Date.now();
      const minimumInterval =
        document.visibilityState === 'hidden'
          ? HIDDEN_AUTO_REFRESH_INTERVAL_MS
          : AUTO_REFRESH_INTERVAL_MS;
      const lastAutoRefreshAt = lastAutoRefreshAtRef.current;
      return lastAutoRefreshAt === null || now - lastAutoRefreshAt >= minimumInterval;
    };

    const maybeRefresh = () => {
      if (!shouldAutoRefreshNow()) {
        return;
      }
      scheduleAutoRefresh();
    };

    const handleFocus = () => {
      if (document.visibilityState !== 'visible') {
        return;
      }
      scheduleAutoRefresh();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        return;
      }
      scheduleAutoRefresh();
    };

    const interval = window.setInterval(maybeRefresh, AUTO_REFRESH_INTERVAL_MS);
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [scheduleAutoRefresh]);

  useEffect(() => {
    if (!settingsOpen || !bridgeOpen || !shouldReconcileBridgeStatus(state)) {
      return;
    }

    void reconcileBridgeState();
    const interval = window.setInterval(() => {
      void reconcileBridgeState();
    }, 1500);

    return () => window.clearInterval(interval);
  }, [
    bridgeOpen,
    reconcileBridgeState,
    settingsOpen,
    state,
  ]);

  useEffect(() => {
    if (!settingsOpen || !isTauri()) {
      return;
    }

    let active = true;
    void (async () => {
      const [cliResult, agentResult, doctorResult] = await Promise.allSettled([
        getCliInstallStatus(),
        getAgentDefaultsStatus(),
        getBridgeDoctor(),
      ]);
      if (!active) {
        return;
      }

      if (cliResult.status === 'fulfilled' && agentResult.status === 'fulfilled') {
        setCliStatus(cliResult.value);
        setAgentStatuses(agentResult.value);
      } else {
        const setupError =
          cliResult.status === 'rejected'
            ? cliResult.reason
            : agentResult.status === 'rejected'
              ? agentResult.reason
              : null;
        setError(setupError instanceof Error ? setupError.message : String(setupError));
      }

      if (doctorResult.status === 'fulfilled') {
        setBridgeDoctor(doctorResult.value);
      } else {
        setError(
          doctorResult.reason instanceof Error
            ? doctorResult.reason.message
            : String(doctorResult.reason),
        );
      }
    })();

    return () => {
      active = false;
    };
  }, [
    settingsOpen,
    state?.mcpRuntime.boundPort,
    state?.settings.mcp.port,
    state?.settings.mcp.token,
  ]);

  const selectedSummary = useMemo(() => {
    return state?.projects.find((project) => project.root === selectedRoot) ?? null;
  }, [selectedRoot, state?.projects]);

  const board = useMemo(() => {
    return buildSessionBoard(state ?? emptyLoadState);
  }, [state]);

  const selectedBoardRow = useMemo(() => {
    return choosePrimaryBoardRow(
      board,
      selectedRoot,
      selectedSessionId,
      selectedSummary?.focusSessionId ?? null,
    );
  }, [board, selectedRoot, selectedSessionId, selectedSummary?.focusSessionId]);

  useEffect(() => {
    setSelectedSessionId(resolveSelectedSessionId(selectedBoardRow));
  }, [selectedBoardRow]);

  const selectedBoardProject = useMemo<BoardProjectDetail | null>(() => {
    return state?.boardProjects.find((project) => project.root === selectedRoot) ?? null;
  }, [selectedRoot, state?.boardProjects]);

  const visibleProjects = useMemo<ProjectSummaryWithLight[]>(() => {
    return buildVisibleProjects(state ?? emptyLoadState);
  }, [state?.boardProjects, state?.projects]);

  const currentStepSummary = useMemo(() => {
    if (selectedBoardRow?.summary) {
      return selectedBoardRow.summary;
    }
    if (selectedSummary?.currentStepId) {
      const activeStep = selectedBoardProject?.activeStepLookup[selectedSummary.currentStepId];
      if (activeStep?.summary) {
        return activeStep.summary;
      }
    }
    return (
      selectedBoardProject?.runtimeNextAction ??
      selectedSummary?.nextAction ??
      'Nothing claimed yet.'
    );
  }, [selectedBoardProject, selectedBoardRow?.summary, selectedSummary]);

  const menubarProject = useMemo(() => {
    return chooseMenubarProject(visibleProjects, selectedRoot);
  }, [selectedRoot, visibleProjects]);

  const menubarBoardRow = useMemo(() => {
    return choosePrimaryBoardRow(
      board,
      menubarProject?.root ?? null,
      selectedSessionId,
      menubarProject?.focusSessionId ?? null,
    );
  }, [board, menubarProject?.focusSessionId, menubarProject?.root, selectedSessionId]);

  const menubarBoardProject = useMemo<BoardProjectDetail | null>(() => {
    return state?.boardProjects.find((candidate) => candidate.root === menubarProject?.root) ?? null;
  }, [menubarProject?.root, state?.boardProjects]);

  const menubarStepSummary = useMemo(() => {
    if (menubarBoardRow?.summary) {
      return menubarBoardRow.summary;
    }
    if (menubarProject?.currentStepId) {
      const activeStep = menubarBoardProject?.activeStepLookup[menubarProject.currentStepId];
      if (activeStep?.summary) {
        return activeStep.summary;
      }
    }
    return (
      menubarBoardProject?.runtimeNextAction ??
      menubarProject?.nextAction ??
      'Nothing claimed yet.'
    );
  }, [menubarBoardProject, menubarBoardRow?.summary, menubarProject]);

  const menubarStats = useMemo(() => buildMenubarStats(board), [board]);

  const noProjectsDiscovered =
    !loading && Boolean(state) && state.settings.watchedRoots.length > 0 && state.projects.length === 0;
  const emptyStateCopy = buildEmptyState(noProjectsDiscovered, {
    hasState: Boolean(state),
    watchedRootCount: state?.settings.watchedRoots.length ?? 0,
  });

  useEffect(() => {
    if (!settingsOpen) {
      return;
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setSettingsOpen(false);
      }
    }

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [settingsOpen]);

  const selectProject = useCallback(async (project: ProjectSummary) => {
    startViewTransition(() => {
      setSelectedRoot(project.root);
      if (!project.initialized) {
        setInitName(project.name);
      }
    });
    void setLastFocusedProject(project.root).catch((selectionError) => {
      setError(selectionError instanceof Error ? selectionError.message : String(selectionError));
    });
  }, []);

  const handleAddWatchRoot = useCallback(async () => {
    const candidate = watchRootInput.trim();
    if (!candidate) {
      return;
    }

    setError(null);
    setWatchRootError(null);
    setWatchRootPending(true);
    try {
      const nextState = await addWatchRoot(candidate);
      setWatchRootInput('');
      await applyLoadState(nextState);
    } catch (mutationError) {
      const message = mutationError instanceof Error ? mutationError.message : String(mutationError);
      setError(message);
      setWatchRootError(message);
    } finally {
      setWatchRootPending(false);
    }
  }, [applyLoadState, watchRootInput]);

  const handleRemoveWatchRoot = useCallback(
    async (root: string) => {
      setError(null);
      try {
        const nextState = await removeWatchRoot(root);
        await applyLoadState(nextState);
      } catch (mutationError) {
        setError(mutationError instanceof Error ? mutationError.message : String(mutationError));
      }
    },
    [applyLoadState],
  );

  const handleBridgeToggle = useCallback(
    async (enabled: boolean) => {
      setError(null);
      try {
        const nextState = await setBridgeEnabled(enabled);
        await applyLoadState(nextState);
      } catch (mutationError) {
        setError(mutationError instanceof Error ? mutationError.message : String(mutationError));
      }
    },
    [applyLoadState],
  );

  const handleRestartBridge = useCallback(async () => {
    setError(null);
    try {
      const nextState = await restartBridge();
      await applyLoadState(nextState);
      void handleRunBridgeDoctor();
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : String(mutationError));
    }
  }, [applyLoadState, handleRunBridgeDoctor]);

  const handleRegenerateBridgeToken = useCallback(async () => {
    setError(null);
    try {
      const nextState = await regenerateBridgeToken();
      await applyLoadState(nextState);
      void handleRunBridgeDoctor();
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : String(mutationError));
    }
  }, [applyLoadState, handleRunBridgeDoctor]);

  const handleInitProject = useCallback(async () => {
    if (!selectedSummary) {
      return;
    }

    setError(null);
    setInitPending(true);
    try {
      const nextState = await initProject(selectedSummary.root, initName || selectedSummary.name);
      await applyLoadState(nextState, { selectRoot: selectedSummary.root });
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : String(mutationError));
    } finally {
      setInitPending(false);
    }
  }, [applyLoadState, initName, selectedSummary]);

  const handleCopyBridgeSnippet = useCallback(async (kind: string) => {
    setError(null);
    try {
      const snippets = await getBridgeClientSnippets(kind);
      const [snippet] = snippets;
      if (!snippet) {
        throw new Error(`No snippet returned for ${kind}`);
      }

      await navigator.clipboard.writeText(snippet.content);
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : String(mutationError));
    }
  }, []);

  const handleCopyCodexTokenExport = useCallback(async () => {
    setError(null);
    try {
      const snippets = await getBridgeClientSnippets('codex');
      const exportLine = snippets[0]?.content.split('\n')[0]?.trim();
      if (!exportLine) {
        throw new Error('No Codex token export available');
      }

      await navigator.clipboard.writeText(exportLine);
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : String(copyError));
    }
  }, []);

  const handleApplyAgentDefaults = useCallback(
    async (kind: string, action: AgentInstallAction) => {
      setError(null);
      setAgentPendingKind(kind);
      try {
        await applyAgentDefaults(kind, action);
        const nextStatuses = await getAgentDefaultsStatus();
        setAgentStatuses(nextStatuses);
      } catch (mutationError) {
        setError(mutationError instanceof Error ? mutationError.message : String(mutationError));
      } finally {
        setAgentPendingKind(null);
      }
    },
    [],
  );

  const handleInstallCli = useCallback(async () => {
    setError(null);
    setCliPending(true);
    try {
      const status = await installCli();
      setCliStatus(status);
    } catch (installError) {
      setError(installError instanceof Error ? installError.message : String(installError));
    } finally {
      setCliPending(false);
    }
  }, []);

  const handleCopyCliSetup = useCallback(async () => {
    if (!cliStatus) {
      return;
    }

    setError(null);
    try {
      await navigator.clipboard.writeText(cliStatus.persistCommand);
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : String(copyError));
    }
  }, [cliStatus]);

  const handleSync = useCallback(() => {
    void (async () => {
      setError(null);
      try {
        const nextState = await refreshProjects();
        await applyLoadState(nextState, { selectRoot: selectedRootRef.current });
        lastAutoRefreshAtRef.current = Date.now();
      } catch (mutationError) {
        setError(mutationError instanceof Error ? mutationError.message : String(mutationError));
      }
    })();
  }, [applyLoadState]);

  const handleOpenDashboard = useCallback(() => {
    void openDashboard().catch((openError) => {
      setError(openError instanceof Error ? openError.message : String(openError));
    });
  }, []);

  const handleHidePopover = useCallback(() => {
    void hideMenuBarPopover().catch(() => {});
  }, []);

  const handleToggleSettings = useCallback(
    () => startViewTransition(() => setSettingsOpen((open) => !open)),
    [],
  );
  const handleOpenSetup = useCallback(
    () =>
      startViewTransition(() => {
        setSettingsOpen(true);
        setRootsOpen(true);
        setBridgeOpen(true);
      }),
    [],
  );
  const handleCloseSettings = useCallback(() => startViewTransition(() => setSettingsOpen(false)), []);
  const handleToggleRoots = useCallback(() => setRootsOpen((open) => !open), []);
  const handleToggleBridge = useCallback(() => setBridgeOpen((open) => !open), []);
  const handleToggleAgentDefaults = useCallback(() => setAgentDefaultsOpen((open) => !open), []);
  const handleWatchRootInputChange = useCallback((value: string) => setWatchRootInput(value), []);
  const handleProjectSelection = useCallback(
    (project: ProjectSummary) => {
      void selectProject(project);
    },
    [selectProject],
  );
  const handleCycleMenubarProject = useCallback(
    (direction: -1 | 1) => {
      const nextRoot = chooseAdjacentMenubarProjectRoot(
        visibleProjects,
        menubarProject?.root ?? selectedRoot,
        direction,
      );
      const nextProject = visibleProjects.find((project) => project.root === nextRoot);
      if (nextProject) {
        void selectProject(nextProject);
      }
    },
    [menubarProject?.root, selectProject, selectedRoot, visibleProjects],
  );

  const bridgePort = state?.mcpRuntime.boundPort ?? state?.settings.mcp.port ?? null;
  const bridgeUrl = bridgePort ? `http://127.0.0.1:${bridgePort}/mcp` : 'Not configured';
  const maskedToken = state?.settings.mcp.token
    ? `${state.settings.mcp.token.slice(0, 6)}••••${state.settings.mcp.token.slice(-4)}`
    : 'Not generated';
  const bridgeStatus = describeBridgeStatus(
    state?.mcpRuntime ?? {
      status: 'stopped',
      boundPort: null,
      pid: null,
      startedAt: null,
      lastError: null,
    },
    Boolean(state?.settings.mcp.enabled),
  );

  if (surface === 'menubar') {
    return (
      <MenubarPopover
        projects={visibleProjects}
        project={menubarProject}
        detail={menubarBoardProject}
        session={menubarBoardRow}
        summary={menubarStepSummary}
        stats={menubarStats}
        loading={loading}
        error={error}
        onSync={handleSync}
        onSelectProject={handleProjectSelection}
        onCycleProject={handleCycleMenubarProject}
        onOpenDashboard={handleOpenDashboard}
        onHide={handleHidePopover}
      />
    );
  }

  return (
    <div className="shell">
      <ShaderBackdrop />
      <ProjectSwitcher
        projects={visibleProjects}
        selectedRoot={selectedRoot}
        onSelectProject={handleProjectSelection}
        onOpenSettings={handleToggleSettings}
        settingsOpen={settingsOpen}
      />

      <main className="stage">
        <button
          type="button"
          className="stage-sync"
          onClick={handleSync}
          title="Refresh tracked projects"
          aria-label="Refresh tracked projects"
        >
          <span aria-hidden="true">↻</span>
          <span className="stage-sync-label">Sync</span>
        </button>

        {loading ? <div className="empty-state">Loading…</div> : null}
        {error ? <div className="error-banner">{error}</div> : null}

        {!loading && selectedSummary && !selectedSummary.initialized ? (
          <section className="init-panel">
            <h2>{selectedSummary.name}</h2>
            <p className="muted">{selectedSummary.root}</p>
            <p>{projectInitPrompt}</p>
            <form
              className="inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                void handleInitProject();
              }}
            >
              <input
                value={initName}
                onChange={(event) => setInitName(event.target.value)}
                placeholder="Project name"
              />
              <button type="submit">{initPending ? 'Initializing…' : 'Initialize workflow'}</button>
            </form>
          </section>
        ) : null}

        {!loading && selectedSummary?.initialized ? (
          <FocusView
            project={selectedSummary}
            detail={selectedBoardProject}
            session={selectedBoardRow}
            summary={currentStepSummary}
          />
        ) : null}

        {!loading && !selectedSummary ? (
          <div className="empty-state">
            <h2>{emptyStateCopy.title}</h2>
            {emptyStateCopy.detail ? <p>{emptyStateCopy.detail}</p> : null}
            {emptyStateCopy.actionLabel ? (
              <button type="button" onClick={handleOpenSetup}>
                {emptyStateCopy.actionLabel}
              </button>
            ) : null}
          </div>
        ) : null}
      </main>

      {settingsOpen ? (
        <Suspense fallback={null}>
          <LazySettingsModal
            settingsOpen={settingsOpen}
            onClose={handleCloseSettings}
            watchedRoots={state?.settings.watchedRoots ?? []}
            rootsOpen={rootsOpen}
            onToggleRoots={handleToggleRoots}
            watchRootInput={watchRootInput}
            watchRootError={watchRootError}
            watchRootPending={watchRootPending}
            onWatchRootInputChange={handleWatchRootInputChange}
            onAddWatchRoot={() => void handleAddWatchRoot()}
            onRemoveWatchRoot={(root) => void handleRemoveWatchRoot(root)}
            bridgeOpen={bridgeOpen}
            onToggleBridge={handleToggleBridge}
            bridgeEnabled={Boolean(state?.settings.mcp.enabled)}
            onBridgeToggle={(enabled) => void handleBridgeToggle(enabled)}
            bridgeStatus={bridgeStatus}
            bridgeUrl={bridgeUrl}
            maskedToken={maskedToken}
            bridgeLastError={state?.mcpRuntime.lastError ?? null}
            onRestartBridge={() => void handleRestartBridge()}
            onRegenerateBridgeToken={() => void handleRegenerateBridgeToken()}
            onCopyBridgeSnippet={(kind) => void handleCopyBridgeSnippet(kind)}
            onCopyCodexTokenExport={() => void handleCopyCodexTokenExport()}
            bridgeDoctor={bridgeDoctor}
            bridgeDoctorPending={bridgeDoctorPending}
            onRunBridgeDoctor={() => void handleRunBridgeDoctor()}
            agentDefaultsOpen={agentDefaultsOpen}
            onToggleAgentDefaults={handleToggleAgentDefaults}
            agentStatuses={agentStatuses}
            agentPendingKind={agentPendingKind}
            onApplyAgentDefaults={(kind, action) => void handleApplyAgentDefaults(kind, action)}
            cliStatus={cliStatus}
            cliPending={cliPending}
            onInstallCli={() => void handleInstallCli()}
            onCopyCliSetup={() => void handleCopyCliSetup()}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
