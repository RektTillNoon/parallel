import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  Suspense,
  lazy,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  addWatchRoot,
  getCliInstallStatus,
  getBridgeClientSnippets,
  getBridgeStatus,
  initProject,
  installCli,
  loadState,
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
import CollapsibleSection from './components/CollapsibleSection';
import ContextRail from './components/ContextRail';
import SessionLedger from './components/SessionLedger';
import type {
  BoardProjectDetail,
  BridgeStateEvent,
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
    setupStale: false,
    staleReasons: [],
    staleClients: [],
  },
};

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const LazySettingsModal = lazy(() => import('./components/SettingsModal'));
const staleClientLabels = {
  codex: 'Codex',
  claudeCode: 'Claude Code',
  claudeDesktop: 'Claude Desktop',
} as const;

export function choosePrimaryBoardRow(
  board: SessionBoardData,
  selectedRoot: string | null,
  selectedSessionId: string | null,
): SessionBoardRow | null {
  if (selectedRoot) {
    return (
      board.rows.find(
        (row) => row.repoRoot === selectedRoot && row.sessionId === selectedSessionId,
      ) ?? board.rows.find((row) => row.repoRoot === selectedRoot) ?? null
    );
  }

  return chooseBoardSelection(board, selectedSessionId);
}

export function resolveSelectedSessionId(selectedBoardRow: SessionBoardRow | null) {
  return selectedBoardRow?.sessionId ?? null;
}

export function resolveBoardSelectionFromRow(selectedRow: SessionBoardRow | null) {
  return {
    selectedRoot: selectedRow?.repoRoot ?? null,
    selectedSessionId: selectedRow?.sessionId ?? null,
  };
}

export function projectCollectionSummary(watchedRootCount: number, projectCount: number) {
  return `${watchedRootCount} roots · ${projectCount} projects`;
}

export const projectSectionLabel = 'Projects';

function compactProjectStatus(status: ProjectSummary['status']) {
  switch (status) {
    case 'uninitialized':
      return 'new';
    case 'in_progress':
      return 'active';
    default:
      return status;
  }
}

function formatRelativeTime(value: string | null | undefined) {
  if (!value) {
    return 'Unknown';
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }

  const diffMs = timestamp - Date.now();
  const absMinutes = Math.round(Math.abs(diffMs) / 60000);

  if (absMinutes < 1) {
    return 'just now';
  }

  if (absMinutes < 60) {
    return relativeTimeFormatter.format(Math.round(diffMs / 60000), 'minute');
  }

  const absHours = Math.round(absMinutes / 60);
  if (absHours < 24) {
    return relativeTimeFormatter.format(Math.round(diffMs / 3600000), 'hour');
  }

  const absDays = Math.round(absHours / 24);
  return relativeTimeFormatter.format(Math.round(diffMs / 86400000), 'day');
}

export function formatShortDuration(value: string | null | undefined) {
  if (!value) {
    return '—';
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return '—';
  }

  const diffMinutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
  if (diffMinutes < 1) return 'now';
  if (diffMinutes < 60) return `${diffMinutes}m`;
  const hours = Math.round(diffMinutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks}w`;
  return `${Math.round(days / 30)}mo`;
}

function padCount(value: number) {
  return value < 10 ? `0${value}` : String(value);
}

type SidebarProps = {
  projects: ProjectSummary[];
  selectedRoot: string | null;
  reposOpen: boolean;
  settingsOpen: boolean;
  watchedRootCount: number;
  onSync: () => void;
  onToggleRepos: () => void;
  onSelectProject: (project: ProjectSummary) => void;
  onToggleSettings: () => void;
};

const Sidebar = memo(function Sidebar({
  projects,
  selectedRoot,
  reposOpen,
  settingsOpen,
  watchedRootCount,
  onSync,
  onToggleRepos,
  onSelectProject,
  onToggleSettings,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-block">
        <div className="panel-header sidebar-top">
          <h1 className="brand-mark">parallel</h1>
          <div className="sidebar-actions">
            <button className="ghost-button" onClick={onSync}>
              Sync
            </button>
          </div>
        </div>
        <p className="sidebar-meta">
          {projectCollectionSummary(watchedRootCount, projects.length)}
        </p>
      </div>
      <CollapsibleSection
        label={projectSectionLabel}
        open={reposOpen}
        onToggle={onToggleRepos}
        className="sidebar-block repos-toggle"
        count={projects.length}
      >
        <div className="project-list">
          {projects.map((project) => (
            <button
              className={`project-row ${selectedRoot === project.root ? 'selected' : ''}`}
              key={project.root}
              onClick={() => onSelectProject(project)}
            >
              <div className="project-row-head">
                <span className="project-row-lead">
                  <span
                    className="project-status-dot"
                    data-status={project.status}
                    aria-hidden="true"
                  />
                  <strong>{project.name}</strong>
                </span>
                <span className="project-row-state">{compactProjectStatus(project.status)}</span>
              </div>
            </button>
          ))}
        </div>
      </CollapsibleSection>
      <div className="sidebar-footer">
        <button
          type="button"
          className={`ghost-button settings-button sidebar-settings-button ${settingsOpen ? 'is-open' : ''}`}
          aria-expanded={settingsOpen}
          aria-controls="settings-dialog"
          aria-haspopup="dialog"
          aria-label={settingsOpen ? 'Close settings' : 'Open settings'}
          onClick={onToggleSettings}
        >
          <span className="settings-button-icon" aria-hidden="true">
            ⚙
          </span>
          <span className="settings-button-label">Settings</span>
        </button>
      </div>
    </aside>
  );
});

export default function App() {
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
  const [cliOpen, setCliOpen] = useState(false);
  const [reposOpen, setReposOpen] = useState(true);
  const [cliStatus, setCliStatus] = useState<CliInstallStatus | null>(null);
  const [cliPending, setCliPending] = useState(false);
  const reloadInFlight = useRef(false);
  const reloadQueued = useRef<string | null | undefined>(undefined);
  const selectedRootRef = useRef<string | null>(null);

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
    async (selectRoot?: string | null) => {
      if (reloadInFlight.current) {
        reloadQueued.current = selectRoot;
        return;
      }

      reloadInFlight.current = true;
      setLoading(true);
      setError(null);
      try {
        const nextState = await loadState();
        if (!nextState) {
          throw new Error('load_state returned no payload');
        }
        await applyLoadState(nextState, { selectRoot });
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        reloadInFlight.current = false;
        setLoading(false);
        if (reloadQueued.current !== undefined) {
          const queued = reloadQueued.current;
          reloadQueued.current = undefined;
          void reloadState(queued);
        }
      }
    },
    [applyLoadState],
  );

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

  useEffect(() => {
    let active = true;
    const unlisteners: Array<() => void> = [];

    void runBootstrapTasks(
      async () => {
        if (!isTauri()) {
          return;
        }

        const unlistenSnapshot = await listen('workflow://snapshot-changed', () => {
          void reloadState(selectedRootRef.current);
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
          await reloadState();
        }
      },
    );

    return () => {
      active = false;
      for (const unlisten of unlisteners) {
        unlisten();
      }
    };
  }, [reloadState]);

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
    state?.settings.mcp.enabled,
    state?.mcpRuntime.status,
  ]);

  useEffect(() => {
    if (!settingsOpen || !isTauri()) {
      return;
    }

    let active = true;
    void (async () => {
      try {
        const status = await getCliInstallStatus();
        if (active) {
          setCliStatus(status);
        }
      } catch (cliError) {
        if (active) {
          setError(cliError instanceof Error ? cliError.message : String(cliError));
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [settingsOpen]);

  const selectedSummary = useMemo(() => {
    return state?.projects.find((project) => project.root === selectedRoot) ?? null;
  }, [selectedRoot, state?.projects]);

  const board = useMemo(() => {
    return buildSessionBoard(state ?? emptyLoadState);
  }, [state]);

  const selectedBoardRow = useMemo(() => {
    return choosePrimaryBoardRow(board, selectedRoot, selectedSessionId);
  }, [board, selectedRoot, selectedSessionId]);

  useEffect(() => {
    setSelectedSessionId(resolveSelectedSessionId(selectedBoardRow));
  }, [selectedBoardRow]);

  const selectedBoardProject = useMemo<BoardProjectDetail | null>(() => {
    return state?.boardProjects.find((project) => project.root === selectedRoot) ?? null;
  }, [selectedRoot, state?.boardProjects]);

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
    return selectedBoardProject?.runtimeNextAction ?? 'No step summary';
  }, [selectedBoardProject, selectedBoardRow?.summary, selectedSummary?.currentStepId]);

  const noProjectsDiscovered =
    !loading && Boolean(state) && state.settings.watchedRoots.length > 0 && state.projects.length === 0;

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
    setSelectedRoot(project.root);
    void setLastFocusedProject(project.root).catch((selectionError) => {
      setError(selectionError instanceof Error ? selectionError.message : String(selectionError));
    });

    if (!project.initialized) {
      setInitName(project.name);
      return;
    }
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
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : String(mutationError));
    }
  }, [applyLoadState]);

  const handleRegenerateBridgeToken = useCallback(async () => {
    setError(null);
    try {
      const nextState = await regenerateBridgeToken();
      await applyLoadState(nextState);
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : String(mutationError));
    }
  }, [applyLoadState]);

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
      setState((current) => {
        if (!current) {
          return current;
        }

        const staleClients = current.mcpRuntime.staleClients.filter((candidate) => candidate !== kind);
        return {
          ...current,
          mcpRuntime: {
            ...current.mcpRuntime,
            staleClients,
            setupStale: staleClients.length > 0,
            staleReasons: staleClients.length > 0 ? current.mcpRuntime.staleReasons : [],
          },
        };
      });
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : String(mutationError));
    }
  }, []);

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
      } catch (mutationError) {
        setError(mutationError instanceof Error ? mutationError.message : String(mutationError));
      }
    })();
  }, [applyLoadState]);

  const handleToggleRepos = useCallback(() => setReposOpen((open) => !open), []);
  const handleToggleSettings = useCallback(() => setSettingsOpen((open) => !open), []);
  const handleCloseSettings = useCallback(() => setSettingsOpen(false), []);
  const handleToggleRoots = useCallback(() => setRootsOpen((open) => !open), []);
  const handleToggleBridge = useCallback(() => setBridgeOpen((open) => !open), []);
  const handleToggleCli = useCallback(() => setCliOpen((open) => !open), []);
  const handleWatchRootInputChange = useCallback((value: string) => setWatchRootInput(value), []);
  const handleProjectSelection = useCallback(
    (project: ProjectSummary) => {
      void selectProject(project);
    },
    [selectProject],
  );

  const handleBoardRowSelection = useCallback((row: SessionBoardRow) => {
    const nextSelection = resolveBoardSelectionFromRow(row);
    setSelectedRoot(nextSelection.selectedRoot);
    setSelectedSessionId(nextSelection.selectedSessionId);
    void setLastFocusedProject(row.repoRoot).catch((selectionError) => {
      setError(selectionError instanceof Error ? selectionError.message : String(selectionError));
    });
  }, []);

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
      setupStale: false,
      staleReasons: [],
      staleClients: [],
    },
    Boolean(state?.settings.mcp.enabled),
  );
  const staleClientNames = useMemo(() => {
    return (state?.mcpRuntime.staleClients ?? [])
      .map((kind) => staleClientLabels[kind as keyof typeof staleClientLabels] ?? kind)
      .join(', ');
  }, [state?.mcpRuntime.staleClients]);

  return (
    <div className="shell">
      <Sidebar
        projects={state?.projects ?? []}
        selectedRoot={selectedRoot}
        reposOpen={reposOpen}
        settingsOpen={settingsOpen}
        watchedRootCount={state?.settings.watchedRoots.length ?? 0}
        onSync={handleSync}
        onToggleRepos={handleToggleRepos}
        onSelectProject={handleProjectSelection}
        onToggleSettings={handleToggleSettings}
      />

      <main className="content">
        {loading ? <div className="empty-state">Loading state…</div> : null}
        {error ? <div className="error-banner">{error}</div> : null}
        {!loading && selectedSummary && !selectedSummary.initialized ? (
          <section className="panel init-panel">
            <h2>{selectedSummary.name}</h2>
            <p className="muted">{selectedSummary.root}</p>
            <p>Initialize workflow for this repo.</p>
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

        {!loading && (board.rows.length > 0 || Boolean(selectedBoardProject)) ? (
          <>
            <section className="board-topline">
              <div>
                <h2>Active sessions</h2>
                <p className="muted">Live log of work in motion across watched repos.</p>
              </div>
              <dl className="board-metrics" aria-label="Board totals">
                <div>
                  <dd>{padCount(board.rows.length)}</dd>
                  <dt>Active</dt>
                </div>
                <div>
                  <dd>{padCount(state?.projects.filter((project) => project.blockerCount > 0).length ?? 0)}</dd>
                  <dt>Blocked</dt>
                </div>
                <div>
                  <dd>{padCount(state?.projects.filter((project) => project.activeSessionCount > 0).length ?? 0)}</dd>
                  <dt>Repos live</dt>
                </div>
                <div>
                  <dd className="board-metrics-time">{formatShortDuration(board.rows[0]?.lastUpdatedAt)}</dd>
                  <dt>Last touch</dt>
                </div>
              </dl>
            </section>

            <section className="session-board-layout">
              <SessionLedger
                rows={board.rows}
                selectedSessionId={selectedBoardRow?.sessionId ?? null}
                onSelectSession={handleBoardRowSelection}
                formatRelativeTime={formatRelativeTime}
              />
              <ContextRail
                project={selectedSummary}
                detail={selectedBoardProject}
                currentStepTitle={selectedBoardRow?.stepTitle ?? selectedSummary?.currentStepTitle ?? 'No current step'}
                currentStepSummary={currentStepSummary}
              />
            </section>
          </>
        ) : null}
        {!loading && !board.rows.length && !selectedSummary ? (
          <div className="empty-state">
            {noProjectsDiscovered ? 'No repos in current roots.' : 'Add a root to start.'}
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
            setupStale={Boolean(state?.mcpRuntime.setupStale)}
            staleClientNames={staleClientNames}
            bridgeLastError={state?.mcpRuntime.lastError ?? null}
            onRestartBridge={() => void handleRestartBridge()}
            onRegenerateBridgeToken={() => void handleRegenerateBridgeToken()}
            onCopyBridgeSnippet={(kind) => void handleCopyBridgeSnippet(kind)}
            cliOpen={cliOpen}
            onToggleCli={handleToggleCli}
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
