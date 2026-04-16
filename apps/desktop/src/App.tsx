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
  getBridgeClientSnippets,
  getBridgeStatus,
  getProject,
  initProject,
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
  type BoardProjectDetailMap,
  type SessionBoardData,
  type SessionBoardRow,
} from './lib/session-board';
import CollapsibleSection from './components/CollapsibleSection';
import type {
  ActivityEvent,
  BridgeStateEvent,
  LoadStatePayload,
  Phase,
  ProjectDetail,
  ProjectSummary,
  Step,
  WorkflowSession,
} from './lib/types';

type IndexedPlanStep = {
  order: number;
  phase: Phase;
  step: Step;
};

type SessionGroups = Record<'active' | 'paused' | 'done', WorkflowSession[]>;

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

function getIndexedPlan(phases: Phase[]): IndexedPlanStep[] {
  let order = 1;
  return phases.flatMap((phase) =>
    phase.steps.map((step) => {
      const indexed = { order, phase, step };
      order += 1;
      return indexed;
    }),
  );
}

function timelineLabel(event: ActivityEvent, sessionsById: Map<string, WorkflowSession>) {
  if (event.session_id) {
    return sessionsById.get(event.session_id)?.title ?? event.session_id;
  }
  return `${event.actor}/${event.source}`;
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
          {watchedRootCount} roots · {projects.length} repos
        </p>
      </div>
      <CollapsibleSection
        label="Repos"
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
                <strong>{project.name}</strong>
                <span className="project-row-state">{compactProjectStatus(project.status)}</span>
              </div>
              {project.initialized ? (
                <div className="project-row-meta">
                  <span>
                    {project.completedStepCount}/{project.totalStepCount}
                  </span>
                  <span>{project.activeSessionCount} sessions</span>
                </div>
              ) : null}
              {project.currentStepTitle ? (
                <div className="project-row-focus">{project.currentStepTitle}</div>
              ) : null}
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

type FocusPanelProps = {
  detail: ProjectDetail;
  currentOwner: WorkflowSession | null;
  currentStepEntry: IndexedPlanStep | null;
  nextStepEntry: IndexedPlanStep | undefined;
};

const FocusPanel = memo(function FocusPanel({
  detail,
  currentOwner,
  currentStepEntry,
  nextStepEntry,
}: FocusPanelProps) {
  return (
    <section className="panel focus-panel">
      <div className="focus-head">
        <span className={`status status-${detail.runtime.status}`}>{detail.runtime.status}</span>
        {detail.runtime.active_branch ? (
          <span className="hero-branch">{detail.runtime.active_branch}</span>
        ) : null}
      </div>
      <h3>{currentStepEntry ? `${currentStepEntry.order}. ${currentStepEntry.step.title}` : 'No current step'}</h3>
      {currentStepEntry?.step.summary ? <p className="focus-summary">{currentStepEntry.step.summary}</p> : null}
      <div className="focus-meta-grid">
        <div>
          <label>Owning session</label>
          <strong>{currentOwner?.title ?? 'Unowned'}</strong>
        </div>
        <div>
          <label>Next valid step</label>
          <strong>{nextStepEntry ? `${nextStepEntry.order}. ${nextStepEntry.step.title}` : 'None'}</strong>
        </div>
      </div>
      {detail.runtime.blockers.length > 0 ? (
        <div className="blocker-strip">
          {detail.runtime.blockers.map((blocker) => (
            <span className="blocker-chip" key={blocker}>
              {blocker}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
});

type PlanPanelProps = {
  indexedPlan: IndexedPlanStep[];
  currentStepId: string | null | undefined;
  expandedSteps: Record<string, boolean>;
  sessionsById: Map<string, WorkflowSession>;
  onToggleStep: (stepId: string) => void;
};

const PlanPanel = memo(function PlanPanel({
  indexedPlan,
  currentStepId,
  expandedSteps,
  sessionsById,
  onToggleStep,
}: PlanPanelProps) {
  return (
    <section className="panel plan-panel">
      <div className="panel-header">
        <h3>Plan</h3>
        <span className="muted">{indexedPlan.length} steps</span>
      </div>
      <div className="plan-list">
        {indexedPlan.map((entry) => {
          const owner = entry.step.owner_session_id
            ? sessionsById.get(entry.step.owner_session_id) ?? null
            : null;
          const isExpanded = expandedSteps[entry.step.id] ?? entry.step.id === currentStepId;
          const hasDetails = entry.step.details.length > 0 || entry.step.subtasks.length > 0;

          return (
            <article
              className={`plan-row ${entry.step.id === currentStepId ? 'current' : ''} status-${entry.step.status}`}
              key={entry.step.id}
            >
              <button
                type="button"
                className="plan-row-main"
                onClick={hasDetails ? () => onToggleStep(entry.step.id) : undefined}
              >
                <span className="plan-order">{entry.order}</span>
                <div className="plan-copy">
                  <div className="plan-row-head">
                    <strong>{entry.step.title}</strong>
                    <span className={`status status-${entry.step.status}`}>{entry.step.status}</span>
                  </div>
                  {entry.step.summary ? <p className="plan-summary">{entry.step.summary}</p> : null}
                  <div className="plan-row-meta">
                    <span>{entry.phase.title}</span>
                    <span>{owner?.title ?? 'No owner'}</span>
                  </div>
                </div>
                {hasDetails ? <span className="plan-row-toggle">{isExpanded ? '−' : '+'}</span> : null}
              </button>
              {hasDetails && isExpanded ? (
                <div className="plan-row-details">
                  {entry.step.details.length > 0 ? (
                    <ul className="detail-list">
                      {entry.step.details.map((detailLine) => (
                        <li key={detailLine}>{detailLine}</li>
                      ))}
                    </ul>
                  ) : null}
                  {entry.step.subtasks.length > 0 ? (
                    <div className="subtask-list">
                      {entry.step.subtasks.map((subtask) => (
                        <div className="subtask-row" key={subtask.id}>
                          <span className={`subtask-state subtask-${subtask.status}`} />
                          <span>{subtask.title}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
});

type SessionsPanelProps = {
  groupedSessions: SessionGroups;
  stepTitlesById: Map<string, string>;
};

const SessionsPanel = memo(function SessionsPanel({
  groupedSessions,
  stepTitlesById,
}: SessionsPanelProps) {
  const groups: Array<keyof SessionGroups> = ['active', 'paused', 'done'];

  return (
    <section className="panel session-panel">
      <div className="panel-header">
        <h3>Sessions</h3>
      </div>
      {groups.map((groupKey) =>
        groupedSessions[groupKey].length > 0 ? (
          <div className="session-group" key={groupKey}>
            <label>{groupKey}</label>
            <div className="session-list">
              {groupedSessions[groupKey].map((session) => (
                <div className="session-row" key={session.id}>
                  <div>
                    <strong>{session.title}</strong>
                    <p className="muted">
                      {session.actor}/{session.source}
                    </p>
                  </div>
                  <div className="session-row-meta">
                    <span>
                      {session.owned_step_id
                        ? stepTitlesById.get(session.owned_step_id) ?? session.owned_step_id
                        : 'No owned step'}
                    </span>
                    <span>{formatRelativeTime(session.last_updated_at)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null,
      )}
    </section>
  );
});

type TimelinePanelProps = {
  timeline: ActivityEvent[];
  sessionsById: Map<string, WorkflowSession>;
  stepTitlesById: Map<string, string>;
};

const TimelinePanel = memo(function TimelinePanel({
  timeline,
  sessionsById,
  stepTitlesById,
}: TimelinePanelProps) {
  return (
    <section className="panel timeline-panel">
      <div className="panel-header">
        <h3>Timeline</h3>
      </div>
      <div className="timeline-list">
        {timeline.map((event) => (
          <div className="timeline-row" key={`${event.timestamp}-${event.summary}`}>
            <div className="timeline-row-head">
              <strong>{event.summary}</strong>
              <span>{formatRelativeTime(event.timestamp)}</span>
            </div>
            <div className="timeline-row-meta">
              <span>{timelineLabel(event, sessionsById)}</span>
              {event.step_id ? <span>{stepTitlesById.get(event.step_id) ?? event.step_id}</span> : null}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
});

type WorkspaceViewProps = {
  detail: ProjectDetail;
  completedCount: number;
  indexedPlan: IndexedPlanStep[];
  activeSessionCount: number;
  currentOwner: WorkflowSession | null;
  currentStepEntry: IndexedPlanStep | null;
  nextStepEntry: IndexedPlanStep | undefined;
  expandedSteps: Record<string, boolean>;
  sessionsById: Map<string, WorkflowSession>;
  groupedSessions: SessionGroups;
  timeline: ActivityEvent[];
  stepTitlesById: Map<string, string>;
  onToggleStep: (stepId: string) => void;
};

const WorkspaceView = memo(function WorkspaceView({
  detail,
  completedCount,
  indexedPlan,
  activeSessionCount,
  currentOwner,
  currentStepEntry,
  nextStepEntry,
  expandedSteps,
  sessionsById,
  groupedSessions,
  timeline,
  stepTitlesById,
  onToggleStep,
}: WorkspaceViewProps) {
  return (
    <section className="workspace">
      <section className="panel workspace-header">
        <div>
          <h2>{detail.manifest.name}</h2>
          <p className="muted">{detail.manifest.root}</p>
        </div>
        <div className="workspace-header-meta">
          <span>{completedCount}/{indexedPlan.length} complete</span>
          <span>{activeSessionCount} active sessions</span>
          <span>{formatRelativeTime(detail.runtime.last_updated_at)}</span>
        </div>
      </section>

      <section className="workspace-grid">
        <div className="workspace-main">
          <FocusPanel
            detail={detail}
            currentOwner={currentOwner}
            currentStepEntry={currentStepEntry}
            nextStepEntry={nextStepEntry}
          />
          <PlanPanel
            indexedPlan={indexedPlan}
            currentStepId={currentStepEntry?.step.id}
            expandedSteps={expandedSteps}
            sessionsById={sessionsById}
            onToggleStep={onToggleStep}
          />
        </div>

        <aside className="workspace-side">
          {detail.sessions.length > 0 ? (
            <SessionsPanel groupedSessions={groupedSessions} stepTitlesById={stepTitlesById} />
          ) : null}
          {timeline.length > 0 ? (
            <TimelinePanel
              timeline={timeline}
              sessionsById={sessionsById}
              stepTitlesById={stepTitlesById}
            />
          ) : null}
        </aside>
      </section>
    </section>
  );
});

export default function App() {
  const [state, setState] = useState<LoadStatePayload | null>(null);
  const [selectedRoot, setSelectedRoot] = useState<string | null>(null);
  const [detailMap, setDetailMap] = useState<BoardProjectDetailMap>(new Map());
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [watchRootInput, setWatchRootInput] = useState('');
  const [watchRootError, setWatchRootError] = useState<string | null>(null);
  const [watchRootPending, setWatchRootPending] = useState(false);
  const [initName, setInitName] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rootsOpen, setRootsOpen] = useState(false);
  const [bridgeOpen, setBridgeOpen] = useState(true);
  const [reposOpen, setReposOpen] = useState(true);
  const [expandedSteps, setExpandedSteps] = useState<Record<string, boolean>>({});
  const reloadInFlight = useRef(false);
  const reloadQueued = useRef<string | null | undefined>(undefined);
  const selectedRootRef = useRef<string | null>(null);

  useEffect(() => {
    selectedRootRef.current = selectedRoot;
  }, [selectedRoot]);

  const loadBoardDetails = useCallback(async (nextState: LoadStatePayload, selectedRootCandidate: string | null) => {
    const rootsToLoad = new Set<string>();

    for (const project of nextState.projects) {
      if (project.initialized && project.activeSessionCount > 0) {
        rootsToLoad.add(project.root);
      }
    }

    if (selectedRootCandidate) {
      const selectedProject =
        nextState.projects.find((project) => project.root === selectedRootCandidate) ?? null;
      if (selectedProject?.initialized) {
        rootsToLoad.add(selectedRootCandidate);
      }
    }

    if (rootsToLoad.size === 0) {
      setDetailMap(new Map());
      setDetailLoading(false);
      return;
    }

    setDetailLoading(true);
    try {
      const settledEntries = await Promise.allSettled(
        [...rootsToLoad].map(async (root) => [root, await getProject(root)] as const),
      );
      const entries: Array<readonly [string, ProjectDetail]> = [];

      for (const result of settledEntries) {
        if (result.status === 'fulfilled') {
          entries.push(result.value);
        } else {
          setError(result.reason instanceof Error ? result.reason.message : String(result.reason));
        }
      }

      setDetailMap(new Map(entries));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const applyLoadState = useCallback(
    async (nextState: LoadStatePayload, options?: { selectRoot?: string | null }) => {
      setState(nextState);
      const selection = resolveSelectionState(nextState, options?.selectRoot ?? selectedRootRef.current);
      setSelectedRoot(selection.selectedRoot);
      await loadBoardDetails(nextState, selection.selectedRoot);
    },
    [loadBoardDetails],
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

        const unlistenWorkflow = await listen('workflow://changed', () => {
          void reloadState(selectedRootRef.current);
        });
        if (!active) {
          unlistenWorkflow();
          return;
        }
        unlisteners.push(unlistenWorkflow);

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

  const selectedSummary = useMemo(() => {
    return state?.projects.find((project) => project.root === selectedRoot) ?? null;
  }, [selectedRoot, state?.projects]);

  const board = useMemo(() => {
    return buildSessionBoard(state ?? emptyLoadState, detailMap);
  }, [detailMap, state]);

  const selectedBoardRow = useMemo(() => {
    return choosePrimaryBoardRow(board, selectedRoot, selectedSessionId);
  }, [board, selectedRoot, selectedSessionId]);

  useEffect(() => {
    setSelectedSessionId(resolveSelectedSessionId(selectedBoardRow));
  }, [selectedBoardRow]);

  const selectedDetail = useMemo(() => {
    return selectedBoardRow ? detailMap.get(selectedBoardRow.repoRoot) ?? null : null;
  }, [detailMap, selectedBoardRow]);

  const indexedPlan = useMemo(() => {
    return selectedDetail ? getIndexedPlan(selectedDetail.plan.phases) : [];
  }, [selectedDetail]);

  const planEntriesById = useMemo(() => {
    return new Map(indexedPlan.map((entry) => [entry.step.id, entry]));
  }, [indexedPlan]);

  const stepTitlesById = useMemo(() => {
    return new Map(indexedPlan.map((entry) => [entry.step.id, entry.step.title]));
  }, [indexedPlan]);

  const stepStatusById = useMemo(() => {
    return new Map(indexedPlan.map((entry) => [entry.step.id, entry.step.status]));
  }, [indexedPlan]);

  const currentStepEntry = useMemo(() => {
    if (!selectedDetail) {
      return null;
    }
    return planEntriesById.get(selectedDetail.runtime.current_step_id ?? '') ?? null;
  }, [selectedDetail, planEntriesById]);

  const nextStepEntry = useMemo(() => {
    return indexedPlan.find(
      (entry) =>
        entry.step.id !== currentStepEntry?.step.id &&
        entry.step.status !== 'done' &&
        entry.step.depends_on.every((dependency) => stepStatusById.get(dependency) === 'done'),
    );
  }, [currentStepEntry?.step.id, indexedPlan, stepStatusById]);

  const sessionsById = useMemo(() => {
    return new Map((selectedDetail?.sessions ?? []).map((session) => [session.id, session]));
  }, [selectedDetail]);

  const currentOwner = useMemo(() => {
    return currentStepEntry?.step.owner_session_id
      ? sessionsById.get(currentStepEntry.step.owner_session_id) ?? null
      : null;
  }, [currentStepEntry, sessionsById]);

  const groupedSessions = useMemo<SessionGroups>(() => {
    const groups: SessionGroups = {
      active: [],
      paused: [],
      done: [],
    };

    for (const session of selectedDetail?.sessions ?? []) {
      groups[session.status].push(session);
    }

    return groups;
  }, [selectedDetail]);

  const activeSessionCount = groupedSessions.active.length;

  const completedCount = useMemo(() => {
    return indexedPlan.reduce((count, entry) => count + (entry.step.status === 'done' ? 1 : 0), 0);
  }, [indexedPlan]);

  const timeline = useMemo(() => {
    return selectedDetail?.recentActivity.slice(-12).reverse() ?? [];
  }, [selectedDetail]);

  const noProjectsDiscovered =
    !loading && Boolean(state) && state.settings.watchedRoots.length > 0 && state.projects.length === 0;

  useEffect(() => {
    if (!currentStepEntry) {
      return;
    }

    setExpandedSteps((existing) => ({
      ...existing,
      [currentStepEntry.step.id]: true,
    }));
  }, [currentStepEntry?.step.id]);

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

    void reloadState(project.root);
  }, [reloadState]);

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
    setDetailLoading(true);
    try {
      await initProject(selectedSummary.root, initName || selectedSummary.name);
      const nextState = await refreshProjects();
      await applyLoadState(nextState, { selectRoot: selectedSummary.root });
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : String(mutationError));
    } finally {
      setDetailLoading(false);
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

  const handleTogglePlanStep = useCallback(
    (stepId: string) => {
      setExpandedSteps((existing) => ({
        ...existing,
        [stepId]: !(existing[stepId] ?? stepId === currentStepEntry?.step.id),
      }));
    },
    [currentStepEntry?.step.id],
  );

  const handleSync = useCallback(() => {
    void reloadState(selectedRootRef.current);
  }, [reloadState]);

  const handleToggleRepos = useCallback(() => setReposOpen((open) => !open), []);
  const handleToggleSettings = useCallback(() => setSettingsOpen((open) => !open), []);
  const handleCloseSettings = useCallback(() => setSettingsOpen(false), []);
  const handleToggleRoots = useCallback(() => setRootsOpen((open) => !open), []);
  const handleToggleBridge = useCallback(() => setBridgeOpen((open) => !open), []);
  const handleWatchRootInputChange = useCallback((value: string) => setWatchRootInput(value), []);
  const handleProjectSelection = useCallback(
    (project: ProjectSummary) => {
      void selectProject(project);
    },
    [selectProject],
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
        {!loading && !selectedBoardRow && !selectedSummary ? (
          <div className="empty-state">
            {noProjectsDiscovered ? 'No repos in current roots.' : 'Add a root to start.'}
          </div>
        ) : null}

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
              <button type="submit">Initialize workflow</button>
            </form>
          </section>
        ) : null}

        {!loading && selectedBoardRow && selectedDetail ? (
          <WorkspaceView
            detail={selectedDetail}
            completedCount={completedCount}
            indexedPlan={indexedPlan}
            activeSessionCount={activeSessionCount}
            currentOwner={currentOwner}
            currentStepEntry={currentStepEntry}
            nextStepEntry={nextStepEntry}
            expandedSteps={expandedSteps}
            sessionsById={sessionsById}
            groupedSessions={groupedSessions}
            timeline={timeline}
            stepTitlesById={stepTitlesById}
            onToggleStep={handleTogglePlanStep}
          />
        ) : null}
        {!loading && selectedBoardRow && !selectedDetail && detailLoading ? (
          <div className="empty-state">Loading project…</div>
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
          />
        </Suspense>
      ) : null}
    </div>
  );
}
