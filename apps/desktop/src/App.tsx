import { listen } from '@tauri-apps/api/event';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

import {
  addWatchRoot,
  getBridgeClientSnippets,
  getProject,
  initProject,
  loadState,
  regenerateBridgeToken,
  removeWatchRoot,
  restartBridge,
  setBridgeEnabled,
  setLastFocusedProject,
} from './lib/api';
import { resolveSelectionState } from './lib/state';
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

type CollapsibleSectionProps = {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  className?: string;
  count?: number;
};

type IndexedPlanStep = {
  order: number;
  phase: Phase;
  step: Step;
};

function CollapsibleSection({
  label,
  open,
  onToggle,
  children,
  className,
  count,
}: CollapsibleSectionProps) {
  const reduceMotion = useReducedMotion();
  const transition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.22, ease: [0.22, 1, 0.36, 1] as const };

  return (
    <section className={`collapse-section ${className ?? ''}`.trim()}>
      <button
        type="button"
        className="collapse-trigger"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span>{label}</span>
        <span className="collapse-meta">
          {typeof count === 'number' ? <span>{count}</span> : null}
          <motion.span
            aria-hidden="true"
            className="collapse-icon"
            animate={{ rotate: open ? 90 : 0 }}
            transition={transition}
          >
            ›
          </motion.span>
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="content"
            className="collapse-content"
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={transition}
          >
            <div className="collapse-inner">{children}</div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
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
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  if (absMinutes < 1) {
    return 'just now';
  }

  if (absMinutes < 60) {
    return rtf.format(Math.round(diffMs / 60000), 'minute');
  }

  const absHours = Math.round(absMinutes / 60);
  if (absHours < 24) {
    return rtf.format(Math.round(diffMs / 3600000), 'hour');
  }

  const absDays = Math.round(absHours / 24);
  return rtf.format(Math.round(diffMs / 86400000), 'day');
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

export default function App() {
  const [state, setState] = useState<LoadStatePayload | null>(null);
  const [selectedRoot, setSelectedRoot] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [watchRootInput, setWatchRootInput] = useState('');
  const [watchRootError, setWatchRootError] = useState<string | null>(null);
  const [watchRootPending, setWatchRootPending] = useState(false);
  const [initName, setInitName] = useState('');
  const [rootsOpen, setRootsOpen] = useState(false);
  const [bridgeOpen, setBridgeOpen] = useState(true);
  const [reposOpen, setReposOpen] = useState(true);
  const [expandedSteps, setExpandedSteps] = useState<Record<string, boolean>>({});

  async function reloadState(selectRoot?: string | null) {
    setLoading(true);
    setError(null);
    try {
      const nextState = await loadState();
      if (!nextState) {
        throw new Error('load_state returned no payload');
      }
      setState(nextState);
      const selection = resolveSelectionState(nextState, selectRoot);

      setSelectedRoot(selection.selectedRoot);
      if (selection.shouldLoadDetail && selection.selectedRoot) {
        setDetail(await getProject(selection.selectedRoot));
      } else {
        setDetail(null);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reloadState();
    const unlistenPromise = listen('workflow://changed', () => {
      void reloadState(selectedRoot);
    });
    const bridgePromise = listen<BridgeStateEvent>('bridge://state-changed', (event) => {
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

    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
      void bridgePromise.then((unlisten) => unlisten());
    };
  }, []);

  const selectedSummary = useMemo(() => {
    return state?.projects.find((project) => project.root === selectedRoot) ?? null;
  }, [selectedRoot, state]);

  const indexedPlan = useMemo(() => {
    return detail ? getIndexedPlan(detail.plan.phases) : [];
  }, [detail]);

  const currentStepEntry = useMemo(() => {
    if (!detail) {
      return null;
    }
    return indexedPlan.find((entry) => entry.step.id === detail.runtime.current_step_id) ?? null;
  }, [detail, indexedPlan]);

  const nextStepEntry = useMemo(() => {
    return indexedPlan.find(
      (entry) =>
        entry.step.id !== currentStepEntry?.step.id &&
        entry.step.status !== 'done' &&
        entry.step.depends_on.every((dependency) =>
          indexedPlan.find((candidate) => candidate.step.id === dependency)?.step.status === 'done',
        ),
    );
  }, [currentStepEntry?.step.id, indexedPlan]);

  const sessionsById = useMemo(() => {
    return new Map((detail?.sessions ?? []).map((session) => [session.id, session]));
  }, [detail]);

  const currentOwner = useMemo(() => {
    return currentStepEntry?.step.owner_session_id
      ? sessionsById.get(currentStepEntry.step.owner_session_id) ?? null
      : null;
  }, [currentStepEntry, sessionsById]);

  const activeSessions = useMemo(
    () => (detail?.sessions ?? []).filter((session) => session.status === 'active'),
    [detail],
  );

  const groupedSessions = useMemo(() => {
    const sessions = detail?.sessions ?? [];
    return {
      active: sessions.filter((session) => session.status === 'active'),
      paused: sessions.filter((session) => session.status === 'paused'),
      done: sessions.filter((session) => session.status === 'done'),
    };
  }, [detail]);

  const completedCount = useMemo(
    () => indexedPlan.filter((entry) => entry.step.status === 'done').length,
    [indexedPlan],
  );

  const timeline = useMemo(() => {
    return detail?.recentActivity.slice().reverse() ?? [];
  }, [detail]);

  const noProjectsDiscovered =
    !loading && state && state.settings.watchedRoots.length > 0 && state.projects.length === 0;

  useEffect(() => {
    if (!currentStepEntry) {
      return;
    }
    setExpandedSteps((existing) => ({
      ...existing,
      [currentStepEntry.step.id]: true,
    }));
  }, [currentStepEntry?.step.id]);

  async function selectProject(project: ProjectSummary) {
    setSelectedRoot(project.root);
    await setLastFocusedProject(project.root);
    if (project.initialized) {
      setDetail(await getProject(project.root));
    } else {
      setDetail(null);
      setInitName(project.name);
    }
  }

  async function handleMutation<T>(operation: Promise<T>) {
    setError(null);
    try {
      await operation;
      await reloadState(selectedRoot);
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : String(mutationError));
    }
  }

  async function handleAddWatchRoot() {
    const candidate = watchRootInput.trim();
    if (!candidate) {
      return;
    }

    setError(null);
    setWatchRootError(null);
    setWatchRootPending(true);
    try {
      const nextState = await addWatchRoot(candidate);
      if (!nextState) {
        throw new Error('add_watch_root returned no payload');
      }
      setState(nextState);
      setWatchRootInput('');
      const selection = resolveSelectionState(nextState, selectedRoot);

      setSelectedRoot(selection.selectedRoot);
      if (selection.shouldLoadDetail && selection.selectedRoot) {
        setDetail(await getProject(selection.selectedRoot));
      } else {
        setDetail(null);
      }
    } catch (mutationError) {
      const message = mutationError instanceof Error ? mutationError.message : String(mutationError);
      setError(message);
      setWatchRootError(message);
    } finally {
      setWatchRootPending(false);
    }
  }

  async function handleBridgeToggle(enabled: boolean) {
    setError(null);
    try {
      const nextState = await setBridgeEnabled(enabled);
      setState(nextState);
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : String(mutationError));
    }
  }

  async function handleCopyBridgeSnippet(kind: string) {
    setError(null);
    try {
      const snippets = await getBridgeClientSnippets(kind);
      const [snippet] = snippets;
      if (!snippet) {
        throw new Error(`No snippet returned for ${kind}`);
      }
      await navigator.clipboard.writeText(snippet.content);
      setState((current) =>
        current
          ? {
              ...current,
              mcpRuntime: {
                ...current.mcpRuntime,
                staleClients: current.mcpRuntime.staleClients.filter((candidate) => candidate !== kind),
                setupStale: current.mcpRuntime.staleClients.some((candidate) => candidate !== kind),
                staleReasons:
                  current.mcpRuntime.staleClients.filter((candidate) => candidate !== kind).length > 0
                    ? current.mcpRuntime.staleReasons
                    : [],
              },
            }
          : current,
      );
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : String(mutationError));
    }
  }

  const bridgePort = state?.mcpRuntime.boundPort ?? state?.settings.mcp.port ?? null;
  const bridgeUrl = bridgePort ? `http://127.0.0.1:${bridgePort}/mcp` : 'Not configured';
  const maskedToken = state?.settings.mcp.token
    ? `${state.settings.mcp.token.slice(0, 6)}••••${state.settings.mcp.token.slice(-4)}`
    : 'Not generated';
  const staleClientLabels = {
    codex: 'Codex',
    claudeCode: 'Claude Code',
    claudeDesktop: 'Claude Desktop',
  } as const;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-block">
          <div className="panel-header sidebar-top">
            <h1 className="brand-mark">parallel</h1>
            <button className="ghost-button" onClick={() => void reloadState(selectedRoot)}>
              Sync
            </button>
          </div>
          <p className="sidebar-meta">
            {state?.settings.watchedRoots.length ?? 0} roots · {state?.projects.length ?? 0} repos
          </p>
          <CollapsibleSection
            label="Roots"
            open={rootsOpen}
            onToggle={() => setRootsOpen((open) => !open)}
            className="roots-toggle"
            count={state?.settings.watchedRoots.length ?? 0}
          >
            <form
              className="stack compact-form watch-root-form"
              onSubmit={(event) => {
                event.preventDefault();
                void handleAddWatchRoot();
              }}
            >
              <div className="watch-root-controls">
                <input
                  value={watchRootInput}
                  onChange={(event) => setWatchRootInput(event.target.value)}
                  placeholder="/Users/light/Projects"
                />
                <button className="add-root-button" type="submit" disabled={watchRootPending}>
                  <span aria-hidden="true">+</span>
                  <span>{watchRootPending ? 'Adding…' : 'Add'}</span>
                </button>
              </div>
              {watchRootError ? <div className="inline-error">{watchRootError}</div> : null}
            </form>
            <div className="root-list">
              {state?.settings.watchedRoots.map((root) => (
                <div className="root-row" key={root}>
                  <code>{root}</code>
                  <button
                    className="ghost-button root-row-action"
                    onClick={() => void handleMutation(removeWatchRoot(root))}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </CollapsibleSection>
        </div>
        <CollapsibleSection
          label="Agent Bridge"
          open={bridgeOpen}
          onToggle={() => setBridgeOpen((open) => !open)}
          className="sidebar-block bridge-toggle"
        >
          <section className="panel bridge-panel">
            <div className="panel-header">
              <h3>Agent Bridge</h3>
              <label className="toggle-row">
                <span>{state?.settings.mcp.enabled ? 'On' : 'Off'}</span>
                <input
                  type="checkbox"
                  checked={Boolean(state?.settings.mcp.enabled)}
                  onChange={(event) => void handleBridgeToggle(event.target.checked)}
                />
              </label>
            </div>
            <div className="bridge-meta">
              <div>
                <label>Status</label>
                <strong className={`status status-${state?.mcpRuntime.status ?? 'stopped'}`}>
                  {state?.mcpRuntime.status ?? 'stopped'}
                </strong>
              </div>
              <div>
                <label>URL</label>
                <code className="bridge-url">{bridgeUrl}</code>
              </div>
              <div>
                <label>Token</label>
                <code className="bridge-url">{maskedToken}</code>
              </div>
            </div>
            {state?.mcpRuntime.setupStale ? (
              <div className="bridge-warning">
                Re-copy setup for:{' '}
                {state.mcpRuntime.staleClients
                  .map((kind) => staleClientLabels[kind as keyof typeof staleClientLabels] ?? kind)
                  .join(', ')}
              </div>
            ) : null}
            {state?.mcpRuntime.lastError ? (
              <div className="inline-error">{state.mcpRuntime.lastError}</div>
            ) : null}
            <div className="bridge-actions">
              <button
                type="button"
                onClick={() => void handleMutation(restartBridge())}
                disabled={!state?.settings.mcp.enabled}
              >
                Restart
              </button>
              <button type="button" onClick={() => void handleMutation(regenerateBridgeToken())}>
                Regenerate token
              </button>
            </div>
            <div className="bridge-copy-list">
              <button type="button" onClick={() => void handleCopyBridgeSnippet('codex')}>
                Copy Codex setup
              </button>
              <button type="button" onClick={() => void handleCopyBridgeSnippet('claudeCode')}>
                Copy Claude Code setup
              </button>
              <button type="button" onClick={() => void handleCopyBridgeSnippet('claudeDesktop')}>
                Copy Claude Desktop setup
              </button>
            </div>
          </section>
        </CollapsibleSection>
        <CollapsibleSection
          label="Repos"
          open={reposOpen}
          onToggle={() => setReposOpen((open) => !open)}
          className="sidebar-block repos-toggle"
          count={state?.projects.length ?? 0}
        >
          <div className="project-list">
            {state?.projects.map((project) => (
              <button
                className={`project-row ${selectedRoot === project.root ? 'selected' : ''}`}
                key={project.root}
                onClick={() => void selectProject(project)}
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
      </aside>

      <main className="content">
        {loading ? <div className="empty-state">Loading state…</div> : null}
        {error ? <div className="error-banner">{error}</div> : null}
        {!loading && !selectedSummary ? (
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
                void handleMutation(initProject(selectedSummary.root, initName || selectedSummary.name));
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

        {!loading && detail ? (
          <section className="workspace">
            <section className="panel workspace-header">
              <div>
                <h2>{detail.manifest.name}</h2>
                <p className="muted">{detail.manifest.root}</p>
              </div>
              <div className="workspace-header-meta">
                <span>{completedCount}/{indexedPlan.length} complete</span>
                <span>{activeSessions.length} active sessions</span>
                <span>{formatRelativeTime(detail.runtime.last_updated_at)}</span>
              </div>
            </section>

            <section className="workspace-grid">
              <div className="workspace-main">
                <section className="panel focus-panel">
                  <div className="focus-head">
                    <span className={`status status-${detail.runtime.status}`}>{detail.runtime.status}</span>
                    {detail.runtime.active_branch ? (
                      <span className="hero-branch">{detail.runtime.active_branch}</span>
                    ) : null}
                  </div>
                  <h3>
                    {currentStepEntry
                      ? `${currentStepEntry.order}. ${currentStepEntry.step.title}`
                      : 'No current step'}
                  </h3>
                  {currentStepEntry?.step.summary ? (
                    <p className="focus-summary">{currentStepEntry.step.summary}</p>
                  ) : null}
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
                      const isExpanded =
                        expandedSteps[entry.step.id] ??
                        entry.step.id === currentStepEntry?.step.id;
                      const hasDetails = entry.step.details.length > 0 || entry.step.subtasks.length > 0;

                      return (
                        <article
                          className={`plan-row ${entry.step.id === currentStepEntry?.step.id ? 'current' : ''} status-${entry.step.status}`}
                          key={entry.step.id}
                        >
                          <button
                            type="button"
                            className="plan-row-main"
                            onClick={() =>
                              hasDetails
                                ? setExpandedSteps((existing) => ({
                                    ...existing,
                                    [entry.step.id]: !isExpanded,
                                  }))
                                : undefined
                            }
                          >
                            <span className="plan-order">{entry.order}</span>
                            <div className="plan-copy">
                              <div className="plan-row-head">
                                <strong>{entry.step.title}</strong>
                                <span className={`status status-${entry.step.status}`}>{entry.step.status}</span>
                              </div>
                              {entry.step.summary ? (
                                <p className="plan-summary">{entry.step.summary}</p>
                              ) : null}
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
              </div>

              <aside className="workspace-side">
                {detail.sessions.length > 0 ? (
                  <section className="panel session-panel">
                    <div className="panel-header">
                      <h3>Sessions</h3>
                    </div>
                    {(['active', 'paused', 'done'] as const).map((groupKey) =>
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
                                  <span>{session.owned_step_id ? sessionsById.has(session.id) ? indexedPlan.find((entry) => entry.step.id === session.owned_step_id)?.step.title ?? session.owned_step_id : session.owned_step_id : 'No owned step'}</span>
                                  <span>{formatRelativeTime(session.last_updated_at)}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null,
                    )}
                  </section>
                ) : null}

                {timeline.length > 0 ? (
                  <section className="panel timeline-panel">
                    <div className="panel-header">
                      <h3>Timeline</h3>
                    </div>
                    <div className="timeline-list">
                      {timeline.slice(0, 12).map((event) => (
                        <div className="timeline-row" key={`${event.timestamp}-${event.summary}`}>
                          <div className="timeline-row-head">
                            <strong>{event.summary}</strong>
                            <span>{formatRelativeTime(event.timestamp)}</span>
                          </div>
                          <div className="timeline-row-meta">
                            <span>{timelineLabel(event, sessionsById)}</span>
                            {event.step_id ? (
                              <span>{indexedPlan.find((entry) => entry.step.id === event.step_id)?.step.title ?? event.step_id}</span>
                            ) : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                ) : null}
              </aside>
            </section>
          </section>
        ) : null}
      </main>
    </div>
  );
}
