import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

import { buildAcceptedDecisionMarkdown, parseAcceptedDecisions } from './decisions';
import { discoverGitRepos } from './discovery';
import { generateHandoff } from './handoff';
import { IndexStore, type IndexedProjectSummary } from './index-store';
import {
  getAllSteps,
  getNextActionableStep,
  getPlanProgress,
  locateStep,
  normalizePlanInProgressStates,
} from './project-helpers';
import {
  activityEventSchema,
  decisionProposalSchema,
  decisionProposalsFileSchema,
  manifestSchema,
  planSchema,
  runtimeSchema,
  sessionsFileSchema,
  type ActivityEvent,
  type DecisionProposal,
  type Manifest,
  type Plan,
  type RuntimeState,
  type SessionsFile,
  type Step,
  type WorkflowSession,
} from './schemas';
import {
  appendJsonLine,
  ensureDir,
  getWorkflowPaths,
  nowIso,
  pathExists,
  readGitBranch,
  readJsonLines,
  readTextIfExists,
  readYamlFile,
  slugify,
  withProjectLock,
  writeTextAtomic,
  writeYamlAtomic,
} from './utils';

export interface MutationActor {
  actor: string;
  source: ActivityEvent['source'];
}

export interface SessionContextInput {
  sessionId?: string;
  sessionTitle?: string;
  branch?: string | null;
}

export type ProjectSummary = IndexedProjectSummary;

export interface ProjectDetail {
  manifest: Manifest;
  plan: Plan;
  runtime: RuntimeState;
  sessions: WorkflowSession[];
  recentActivity: ActivityEvent[];
  blockers: string[];
  pendingProposals: DecisionProposal[];
  handoff: string;
  decisions: ReturnType<typeof parseAcceptedDecisions>;
}

export interface InitProjectInput extends MutationActor {
  root: string;
  name?: string;
  kind?: string;
  owner?: string;
  tags?: string[];
  indexDbPath?: string;
}

export interface RuntimePatchInput extends MutationActor {
  root: string;
  patch: Partial<RuntimeState>;
  summary: string;
  eventType?: string;
  indexDbPath?: string;
}

export interface PlanSyncSubtaskInput {
  id?: string;
  title: string;
  status?: 'todo' | 'done';
}

export interface PlanSyncStepInput {
  id?: string;
  title: string;
  summary?: string;
  details?: string[];
  depends_on?: string[];
  subtasks?: PlanSyncSubtaskInput[];
}

export interface PlanSyncPhaseInput {
  id?: string;
  title: string;
  steps: PlanSyncStepInput[];
}

export interface SyncPlanInput extends MutationActor, SessionContextInput {
  root: string;
  phases: PlanSyncPhaseInput[];
  indexDbPath?: string;
}

export interface EnsureSessionInput extends MutationActor, SessionContextInput {
  root: string;
  indexDbPath?: string;
}

export interface AppendActivityInput extends MutationActor, SessionContextInput {
  type: string;
  summary: string;
  payload?: Record<string, unknown>;
  stepId?: string;
  subtaskId?: string;
  indexDbPath?: string;
}

interface MutateProjectState {
  manifest: Manifest;
  plan: Plan;
  runtime: RuntimeState;
  sessions: SessionsFile;
  proposals: { version: number; proposals: DecisionProposal[] };
  activity: ActivityEvent[];
}

interface MutateProjectResult {
  summary: string;
  eventType: string;
  payload?: Record<string, unknown>;
  writePlan?: Plan;
  writeRuntime?: RuntimeState;
  writeSessions?: SessionsFile;
  writeProposals?: { version: number; proposals: DecisionProposal[] };
  eventContext?: {
    sessionId?: string | null;
    stepId?: string | null;
    subtaskId?: string | null;
  };
}

function createDefaultPlan() {
  return planSchema.parse({
    version: 2,
    phases: [
      {
        id: 'define',
        title: 'Define',
        steps: [
          {
            id: 'capture-requirements',
            title: 'Capture requirements',
            summary: 'Write the initial problem statement and success criteria.',
            details: ['Write the initial problem statement and success criteria.'],
            depends_on: [],
            subtasks: [],
            status: 'todo',
            owner_session_id: null,
            completed_at: null,
            completed_by: null,
          },
        ],
      },
    ],
  });
}

function createDefaultManifest(root: string, input: InitProjectInput, timestamp: string) {
  const name = input.name ?? path.basename(root);
  return manifestSchema.parse({
    version: 1,
    id: `${slugify(name)}-${crypto.randomUUID().slice(0, 8)}`,
    name,
    root,
    kind: input.kind ?? 'software',
    owner: input.owner ?? input.actor,
    tags: input.tags ?? [],
    created_at: timestamp,
  });
}

function createDefaultRuntime(plan: Plan, activeBranch: string | null, timestamp: string) {
  const firstStep = getNextActionableStep(plan);
  return runtimeSchema.parse({
    version: 2,
    current_phase_id: firstStep?.phase.id ?? null,
    current_step_id: firstStep?.step.id ?? null,
    focus_session_id: null,
    next_action: firstStep ? `Start "${firstStep.step.title}"` : 'Add the first project step',
    status: firstStep ? 'todo' : 'done',
    blockers: [],
    last_updated_at: timestamp,
    active_branch: activeBranch,
    active_session_ids: [],
  });
}

function blankSessionsFile() {
  return sessionsFileSchema.parse({
    version: 1,
    sessions: [],
  });
}

async function ensureProjectFiles(root: string, actor: MutationActor) {
  const paths = getWorkflowPaths(root);
  await ensureDir(paths.localDir);

  if (!(await pathExists(paths.proposedDecisionsPath))) {
    await writeYamlAtomic(paths.proposedDecisionsPath, { version: 1, proposals: [] });
  }

  if (!(await pathExists(paths.sessionsPath))) {
    await writeYamlAtomic(paths.sessionsPath, blankSessionsFile());
  }

  if (!(await pathExists(paths.activityPath))) {
    await appendJsonLine(paths.activityPath, {
      timestamp: nowIso(),
      actor: actor.actor,
      source: actor.source,
      project_id: 'pending-init',
      session_id: null,
      step_id: null,
      subtask_id: null,
      type: 'system.bootstrap',
      summary: 'Created workflow activity log',
      payload: {},
    });
  }
}

async function ensureGitignoreEntry(root: string) {
  const gitignorePath = path.join(root, '.gitignore');
  const entry = '.project-workflow/local/';
  const current = (await readTextIfExists(gitignorePath)) ?? '';

  if (current.includes(entry)) {
    return;
  }

  const nextBody = current.endsWith('\n') || current.length === 0 ? current : `${current}\n`;
  await writeTextAtomic(gitignorePath, `${nextBody}${entry}\n`);
}

async function readManifest(root: string) {
  return readYamlFile(getWorkflowPaths(root).manifestPath, manifestSchema);
}

async function readPlan(root: string) {
  return readYamlFile(getWorkflowPaths(root).planPath, planSchema);
}

async function readRuntime(root: string) {
  return readYamlFile(getWorkflowPaths(root).runtimePath, runtimeSchema);
}

async function readSessions(root: string) {
  const paths = getWorkflowPaths(root);
  if (!(await pathExists(paths.sessionsPath))) {
    return blankSessionsFile();
  }

  return readYamlFile(paths.sessionsPath, sessionsFileSchema);
}

async function readPendingProposals(root: string) {
  return readYamlFile(getWorkflowPaths(root).proposedDecisionsPath, decisionProposalsFileSchema);
}

async function appendActivity(root: string, event: ActivityEvent) {
  await appendJsonLine(getWorkflowPaths(root).activityPath, activityEventSchema.parse(event));
}

async function readActivity(root: string) {
  const raw = await readJsonLines<unknown>(getWorkflowPaths(root).activityPath);
  return raw.map((event) => activityEventSchema.parse(event));
}

async function readDecisionsMarkdown(root: string) {
  return (await readTextIfExists(getWorkflowPaths(root).decisionsPath)) ?? '# Accepted Decisions\n';
}

function determineProjectStale(runtime: RuntimeState | null, repoExists: boolean) {
  if (!repoExists) {
    return true;
  }

  if (!runtime) {
    return false;
  }

  const lastUpdated = Date.parse(runtime.last_updated_at);
  if (Number.isNaN(lastUpdated)) {
    return false;
  }

  const ageMs = Date.now() - lastUpdated;
  return ageMs >= 7 * 24 * 60 * 60 * 1000;
}

function activeSessionIds(sessions: WorkflowSession[]) {
  return sessions.filter((session) => session.status === 'active').map((session) => session.id);
}

function humanOverrideAllowed(source: ActivityEvent['source']) {
  return source === 'human' || source === 'desktop';
}

function uniqueId(base: string, used: Set<string>) {
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function subtaskIdFromTitle(title: string) {
  return slugify(title) || 'subtask';
}

function stepIdFromTitle(title: string) {
  return slugify(title) || 'step';
}

function phaseIdFromTitle(title: string) {
  return slugify(title) || 'phase';
}

function ensureObservedStep(session: WorkflowSession, stepId: string | null | undefined) {
  if (!stepId) {
    return session;
  }
  if (session.owned_step_id === stepId || session.observed_step_ids.includes(stepId)) {
    return session;
  }
  return {
    ...session,
    observed_step_ids: [...session.observed_step_ids, stepId],
  };
}

function reconcileSessionsAndPlan(plan: Plan, sessions: SessionsFile) {
  const stepIds = new Set(getAllSteps(plan).map((step) => step.id));
  const sessionIds = new Set(sessions.sessions.map((session) => session.id));

  for (const session of sessions.sessions) {
    if (session.owned_step_id && !stepIds.has(session.owned_step_id)) {
      session.owned_step_id = null;
    }
    session.observed_step_ids = session.observed_step_ids.filter((stepId) => stepIds.has(stepId));
  }

  for (const step of getAllSteps(plan)) {
    if (step.owner_session_id && !sessionIds.has(step.owner_session_id)) {
      step.owner_session_id = null;
    }
  }
}

function refreshRuntimeState(
  plan: Plan,
  runtime: RuntimeState,
  sessions: SessionsFile,
  activeBranch: string | null,
  now: string,
) {
  reconcileSessionsAndPlan(plan, sessions);
  const nextStep = runtime.current_step_id ? locateStep(plan, runtime.current_step_id) : null;
  const current =
    nextStep && nextStep.step.status !== 'done' ? nextStep : getNextActionableStep(plan);

  const focusSessionId =
    current?.step.owner_session_id ??
    (runtime.focus_session_id &&
    sessions.sessions.some((session) => session.id === runtime.focus_session_id)
      ? runtime.focus_session_id
      : null);

  const blockers = runtime.blockers;
  const status = blockers.length > 0 ? 'blocked' : current ? current.step.status : 'done';

  const nextAction = current
    ? current.step.owner_session_id
      ? current.step.summary || current.step.details[0] || `Continue "${current.step.title}"`
      : `Start "${current.step.title}"`
    : 'No remaining steps';

  return runtimeSchema.parse({
    version: 2,
    current_phase_id: current?.phase.id ?? null,
    current_step_id: current?.step.id ?? null,
    focus_session_id: focusSessionId,
    next_action: nextAction,
    status,
    blockers,
    last_updated_at: now,
    active_branch: activeBranch,
    active_session_ids: activeSessionIds(sessions.sessions),
  });
}

async function buildInitializedProjectSummary(root: string): Promise<ProjectSummary> {
  const [manifest, plan, runtime, proposals, sessions] = await Promise.all([
    readManifest(root),
    readPlan(root),
    readRuntime(root),
    readPendingProposals(root),
    readSessions(root),
  ]);
  const repoExists = await pathExists(root);
  const located = runtime.current_step_id ? locateStep(plan, runtime.current_step_id) : null;
  const progress = getPlanProgress(plan);

  return {
    id: manifest.id,
    name: manifest.name,
    root,
    kind: manifest.kind,
    owner: manifest.owner,
    tags: manifest.tags,
    initialized: true,
    status: runtime.status,
    stale: determineProjectStale(runtime, repoExists),
    missing: !repoExists,
    currentStepId: runtime.current_step_id,
    currentStepTitle: located?.step.title ?? null,
    blockerCount: runtime.blockers.length,
    totalStepCount: progress.total,
    completedStepCount: progress.completed,
    activeSessionCount: sessions.sessions.filter((session) => session.status === 'active').length,
    focusSessionId: runtime.focus_session_id,
    lastUpdatedAt: runtime.last_updated_at,
    nextAction: runtime.next_action || null,
    activeBranch: runtime.active_branch ?? null,
    pendingProposalCount: proposals.proposals.length,
    lastSeenAt: nowIso(),
  };
}

async function buildUninitializedProjectSummary(root: string): Promise<ProjectSummary> {
  const name = path.basename(root);
  const repoExists = await pathExists(root);
  return {
    id: null,
    name,
    root,
    kind: null,
    owner: null,
    tags: [],
    initialized: false,
    status: 'uninitialized',
    stale: !repoExists,
    missing: !repoExists,
    currentStepId: null,
    currentStepTitle: null,
    blockerCount: 0,
    totalStepCount: 0,
    completedStepCount: 0,
    activeSessionCount: 0,
    focusSessionId: null,
    lastUpdatedAt: null,
    nextAction: 'Initialize workflow metadata',
    activeBranch: await readGitBranch(root),
    pendingProposalCount: 0,
    lastSeenAt: nowIso(),
  };
}

async function buildProjectSummary(root: string): Promise<ProjectSummary> {
  if (await pathExists(getWorkflowPaths(root).workflowDir)) {
    return buildInitializedProjectSummary(root);
  }

  return buildUninitializedProjectSummary(root);
}

async function maybeSyncIndex(summary: ProjectSummary, watchedRoot: string, indexDbPath?: string) {
  if (!indexDbPath) {
    return;
  }

  const store = new IndexStore(indexDbPath);
  store.syncProject({ ...summary, watchedRoot });
}

export async function refreshProjectIndex(root: string, indexDbPath: string, watchedRoot?: string) {
  const summary = await buildProjectSummary(root);
  const store = new IndexStore(indexDbPath);
  store.syncProject({
    ...summary,
    watchedRoot: watchedRoot ?? root,
  });
}

async function refreshHandoffFile(root: string, indexDbPath?: string) {
  const detail = await getProject(root);
  const handoff = generateHandoff({
    manifest: detail.manifest,
    plan: detail.plan,
    runtime: detail.runtime,
    sessions: detail.sessions,
    activity: detail.recentActivity,
    proposals: detail.pendingProposals,
  });

  await writeTextAtomic(getWorkflowPaths(root).handoffPath, handoff);
  if (indexDbPath) {
    await refreshProjectIndex(root, indexDbPath);
  }
  return handoff;
}

function matchingActiveSessions(
  sessions: SessionsFile,
  actor: string,
  source: ActivityEvent['source'],
  branch: string | null,
) {
  return sessions.sessions.filter(
    (session) =>
      session.status === 'active' &&
      session.actor === actor &&
      session.source === source &&
      session.branch === branch,
  );
}

function createSessionRecord(
  actor: MutationActor,
  branch: string | null,
  title: string | undefined,
  now: string,
  preferredId?: string,
) {
  return {
    id: preferredId ?? `${slugify(title || actor.actor || 'session')}-${crypto.randomUUID().slice(0, 8)}`,
    title: title?.trim() || `${actor.actor} session`,
    actor: actor.actor,
    source: actor.source,
    branch,
    status: 'active' as const,
    owned_step_id: null,
    observed_step_ids: [],
    started_at: now,
    last_updated_at: now,
  };
}

function ensureSessionRecord(
  sessions: SessionsFile,
  actor: MutationActor,
  branch: string | null,
  context: SessionContextInput,
  now: string,
) {
  if (context.sessionId) {
    const existing = sessions.sessions.find((session) => session.id === context.sessionId);
    if (existing) {
      existing.title = context.sessionTitle?.trim() || existing.title;
      existing.branch = branch;
      existing.status = 'active';
      existing.last_updated_at = now;
      return existing;
    }

    const created = createSessionRecord(actor, branch, context.sessionTitle, now, context.sessionId);
    sessions.sessions.push(created);
    return created;
  }

  const matches = matchingActiveSessions(sessions, actor.actor, actor.source, branch);
  if (matches.length === 1) {
    matches[0].title = context.sessionTitle?.trim() || matches[0].title;
    matches[0].last_updated_at = now;
    return matches[0];
  }

  const created = createSessionRecord(actor, branch, context.sessionTitle, now);
  sessions.sessions.push(created);
  return created;
}

function releaseOwnership(plan: Plan, sessionId: string) {
  for (const step of getAllSteps(plan)) {
    if (step.owner_session_id === sessionId) {
      step.owner_session_id = null;
      if (step.status === 'in_progress' || step.status === 'blocked') {
        step.status = 'todo';
      }
    }
  }
}

function findStepByTitle(plan: Plan, title: string) {
  return getAllSteps(plan).find((step) => step.title.trim().toLowerCase() === title.trim().toLowerCase());
}

function buildSyncedPlan(previousPlan: Plan, phases: PlanSyncPhaseInput[]) {
  const previousSteps = getAllSteps(previousPlan);
  const previousById = new Map(previousSteps.map((step) => [step.id, step]));
  const previousByTitle = new Map(previousSteps.map((step) => [step.title.trim().toLowerCase(), step]));
  const usedPhaseIds = new Set<string>();
  const usedStepIds = new Set<string>();

  const nextPlan = planSchema.parse({
    version: 2,
    phases: phases.map((phaseInput) => {
      const phaseId = uniqueId(
        phaseInput.id?.trim() || phaseIdFromTitle(phaseInput.title),
        usedPhaseIds,
      );

      return {
        id: phaseId,
        title: phaseInput.title,
        steps: phaseInput.steps.map((stepInput) => {
          const previous =
            (stepInput.id ? previousById.get(stepInput.id) : undefined) ??
            previousByTitle.get(stepInput.title.trim().toLowerCase()) ??
            findStepByTitle(previousPlan, stepInput.title);
          const stepId = uniqueId(
            stepInput.id?.trim() || previous?.id || stepIdFromTitle(stepInput.title),
            usedStepIds,
          );
          const previousSubtasks = new Map((previous?.subtasks ?? []).map((subtask) => [subtask.id, subtask]));
          const previousSubtasksByTitle = new Map(
            (previous?.subtasks ?? []).map((subtask) => [subtask.title.trim().toLowerCase(), subtask]),
          );
          const usedSubtaskIds = new Set<string>();

          return {
            id: stepId,
            title: stepInput.title,
            summary: stepInput.summary?.trim() || previous?.summary || '',
            status: previous?.status ?? 'todo',
            depends_on: stepInput.depends_on ?? previous?.depends_on ?? [],
            details: stepInput.details ?? previous?.details ?? [],
            subtasks: (stepInput.subtasks ?? []).map((subtaskInput) => {
              const previousSubtask =
                (subtaskInput.id ? previousSubtasks.get(subtaskInput.id) : undefined) ??
                previousSubtasksByTitle.get(subtaskInput.title.trim().toLowerCase());
              const subtaskId = uniqueId(
                subtaskInput.id?.trim() || previousSubtask?.id || subtaskIdFromTitle(subtaskInput.title),
                usedSubtaskIds,
              );

              return {
                id: subtaskId,
                title: subtaskInput.title,
                status: subtaskInput.status ?? previousSubtask?.status ?? 'todo',
              };
            }),
            owner_session_id: previous?.owner_session_id ?? null,
            completed_at: previous?.completed_at ?? null,
            completed_by: previous?.completed_by ?? null,
          };
        }),
      };
    }),
  });

  return nextPlan;
}

async function mutateProject(
  root: string,
  actor: MutationActor,
  indexDbPath: string | undefined,
  mutate: (data: MutateProjectState) => Promise<MutateProjectResult>,
) {
  return withProjectLock(root, async () => {
    await ensureProjectFiles(root, actor);
    const [manifest, plan, runtime, sessions, proposalFile, activity] = await Promise.all([
      readManifest(root),
      readPlan(root),
      readRuntime(root),
      readSessions(root),
      readPendingProposals(root),
      readActivity(root),
    ]);

    const result = await mutate({
      manifest,
      plan,
      runtime,
      sessions,
      proposals: proposalFile,
      activity,
    });

    if (result.writePlan) {
      await writeYamlAtomic(getWorkflowPaths(root).planPath, result.writePlan);
    }

    if (result.writeRuntime) {
      await writeYamlAtomic(getWorkflowPaths(root).runtimePath, result.writeRuntime);
    }

    if (result.writeSessions) {
      await writeYamlAtomic(getWorkflowPaths(root).sessionsPath, result.writeSessions);
    }

    if (result.writeProposals) {
      await writeYamlAtomic(getWorkflowPaths(root).proposedDecisionsPath, result.writeProposals);
    }

    await appendActivity(root, {
      timestamp: nowIso(),
      actor: actor.actor,
      source: actor.source,
      project_id: manifest.id,
      session_id: result.eventContext?.sessionId ?? null,
      step_id: result.eventContext?.stepId ?? null,
      subtask_id: result.eventContext?.subtaskId ?? null,
      type: result.eventType,
      summary: result.summary,
      payload: result.payload ?? {},
    });

    await refreshHandoffFile(root, indexDbPath);
    return getProject(root);
  });
}

export async function initProject(input: InitProjectInput) {
  return withProjectLock(input.root, async () => {
    const timestamp = nowIso();
    const paths = getWorkflowPaths(input.root);
    const manifest = createDefaultManifest(input.root, input, timestamp);
    const plan = createDefaultPlan();
    const runtime = createDefaultRuntime(plan, await readGitBranch(input.root), timestamp);
    const sessions = blankSessionsFile();

    await ensureDir(paths.localDir);
    await writeYamlAtomic(paths.manifestPath, manifest);
    await writeYamlAtomic(paths.planPath, plan);
    await writeTextAtomic(paths.decisionsPath, '# Accepted Decisions\n');
    await writeYamlAtomic(paths.runtimePath, runtime);
    await writeYamlAtomic(paths.sessionsPath, sessions);
    await writeYamlAtomic(paths.proposedDecisionsPath, { version: 1, proposals: [] });
    await writeTextAtomic(paths.activityPath, '');
    await appendActivity(input.root, {
      timestamp,
      actor: input.actor,
      source: input.source,
      project_id: manifest.id,
      session_id: null,
      step_id: runtime.current_step_id,
      subtask_id: null,
      type: 'project.initialized',
      summary: 'Initialized project workflow files',
      payload: {},
    });
    await ensureGitignoreEntry(input.root);
    const handoff = generateHandoff({
      manifest,
      plan,
      runtime,
      sessions: sessions.sessions,
      activity: await readActivity(input.root),
      proposals: [],
    });
    await writeTextAtomic(paths.handoffPath, handoff);
    if (input.indexDbPath) {
      await refreshProjectIndex(input.root, input.indexDbPath, input.root);
    }
    return getProject(input.root);
  });
}

export async function getProject(root: string): Promise<ProjectDetail> {
  const paths = getWorkflowPaths(root);
  const [manifest, plan, runtime, sessions, activity, proposalFile, handoff, decisionsMarkdown] =
    await Promise.all([
      readYamlFile(paths.manifestPath, manifestSchema),
      readYamlFile(paths.planPath, planSchema),
      readYamlFile(paths.runtimePath, runtimeSchema),
      readSessions(root),
      readActivity(root),
      readYamlFile(paths.proposedDecisionsPath, decisionProposalsFileSchema),
      readTextIfExists(paths.handoffPath),
      readDecisionsMarkdown(root),
    ]);

  return {
    manifest,
    plan,
    runtime,
    sessions: sessions.sessions,
    recentActivity: activity,
    blockers: runtime.blockers,
    pendingProposals: proposalFile.proposals.filter((proposal) => proposal.status === 'proposed'),
    handoff: handoff ?? '',
    decisions: parseAcceptedDecisions(decisionsMarkdown),
  };
}

export async function listProjects(roots: string[], indexDbPath?: string) {
  const discoveredRoots = await discoverGitRepos(roots);
  const summaries: ProjectSummary[] = [];

  for (const repoRoot of discoveredRoots) {
    const summary = await buildProjectSummary(repoRoot);
    summaries.push(summary);

    const watchedRoot = roots.find((candidate) => repoRoot.startsWith(path.resolve(candidate))) ?? repoRoot;
    await maybeSyncIndex(summary, watchedRoot, indexDbPath);
  }

  if (indexDbPath) {
    const store = new IndexStore(indexDbPath);
    store.markMissingProjects(
      roots.map((root) => path.resolve(root)),
      new Set(discoveredRoots.map((root) => path.resolve(root))),
    );
    return store.listProjects(roots.map((root) => path.resolve(root)));
  }

  return summaries;
}

export async function ensureSession(input: EnsureSessionInput) {
  return mutateProject(input.root, input, input.indexDbPath, async ({ plan, runtime, sessions }) => {
    const now = nowIso();
    const branch = input.branch ?? (await readGitBranch(input.root));
    const session = ensureSessionRecord(sessions, input, branch, input, now);
    const nextRuntime = refreshRuntimeState(
      plan,
      {
        ...runtime,
        focus_session_id: session.id,
        last_updated_at: now,
      },
      sessions,
      branch,
      now,
    );

    return {
      summary: `Ensured session "${session.title}"`,
      eventType: 'session.ensured',
      payload: { sessionId: session.id },
      writeRuntime: nextRuntime,
      writeSessions: sessions,
      eventContext: {
        sessionId: session.id,
      },
    };
  });
}

export async function syncPlan(input: SyncPlanInput) {
  return mutateProject(input.root, input, input.indexDbPath, async ({ plan, runtime, sessions }) => {
    const now = nowIso();
    const branch = input.branch ?? (await readGitBranch(input.root));
    const nextPlan = buildSyncedPlan(plan, input.phases);
    const session = ensureSessionRecord(sessions, input, branch, input, now);
    reconcileSessionsAndPlan(nextPlan, sessions);
    const nextRuntime = refreshRuntimeState(
      nextPlan,
      {
        ...runtime,
        focus_session_id: session.id,
        last_updated_at: now,
      },
      sessions,
      branch,
      now,
    );

    return {
      summary: 'Synced canonical project plan',
      eventType: 'plan.synced',
      payload: { phaseCount: nextPlan.phases.length },
      writePlan: nextPlan,
      writeRuntime: nextRuntime,
      writeSessions: sessions,
      eventContext: {
        sessionId: session.id,
        stepId: nextRuntime.current_step_id,
      },
    };
  });
}

export async function startStep(
  root: string,
  stepId: string,
  actor: MutationActor & SessionContextInput,
  indexDbPath?: string,
) {
  return mutateProject(root, actor, indexDbPath, async ({ plan, runtime, sessions }) => {
    const located = locateStep(plan, stepId);
    if (!located) {
      throw new Error(`Unknown step "${stepId}"`);
    }

    const allSteps = getAllSteps(plan);
    const blockedDependency = located.step.depends_on.find((dependency) => {
      return allSteps.find((candidate) => candidate.id === dependency)?.status !== 'done';
    });
    if (blockedDependency) {
      throw new Error(`Cannot start "${stepId}" until "${blockedDependency}" is done`);
    }

    const now = nowIso();
    const branch = actor.branch ?? (await readGitBranch(root));
    const session = ensureSessionRecord(sessions, actor, branch, actor, now);

    if (located.step.owner_session_id && located.step.owner_session_id !== session.id) {
      throw new Error(`Step "${located.step.title}" is owned by another session`);
    }

    releaseOwnership(plan, session.id);
    normalizePlanInProgressStates(plan, located.step.id);
    located.step.owner_session_id = session.id;
    located.step.status = runtime.blockers.length > 0 ? 'blocked' : 'in_progress';
    located.step.completed_at = null;
    located.step.completed_by = null;
    session.owned_step_id = located.step.id;
    session.last_updated_at = now;

    const nextRuntime = refreshRuntimeState(
      plan,
      {
        ...runtime,
        current_phase_id: located.phase.id,
        current_step_id: located.step.id,
        focus_session_id: session.id,
        status: located.step.status,
        last_updated_at: now,
      },
      sessions,
      branch,
      now,
    );

    return {
      summary: `Started step "${located.step.title}"`,
      eventType: 'step.started',
      payload: { stepId: located.step.id, sessionId: session.id },
      writePlan: plan,
      writeRuntime: nextRuntime,
      writeSessions: sessions,
      eventContext: {
        sessionId: session.id,
        stepId: located.step.id,
      },
    };
  });
}

export async function completeStep(
  root: string,
  stepId: string,
  actor: MutationActor & SessionContextInput,
  indexDbPath?: string,
) {
  return mutateProject(root, actor, indexDbPath, async ({ plan, runtime, sessions }) => {
    const located = locateStep(plan, stepId);
    if (!located) {
      throw new Error(`Unknown step "${stepId}"`);
    }

    const now = nowIso();
    const branch = actor.branch ?? (await readGitBranch(root));
    const session = ensureSessionRecord(sessions, actor, branch, actor, now);

    if (
      located.step.owner_session_id &&
      located.step.owner_session_id !== session.id &&
      !humanOverrideAllowed(actor.source)
    ) {
      throw new Error(`Step "${located.step.title}" is owned by another session`);
    }

    located.step.status = 'done';
    located.step.owner_session_id = null;
    located.step.completed_at = now;
    located.step.completed_by = actor.actor;

    const ownerSession = sessions.sessions.find((candidate) => candidate.id === session.id);
    if (ownerSession) {
      ownerSession.owned_step_id = null;
      ownerSession.last_updated_at = now;
    }

    const nextRuntime = refreshRuntimeState(
      plan,
      {
        ...runtime,
        focus_session_id: session.id,
        last_updated_at: now,
      },
      sessions,
      branch,
      now,
    );

    return {
      summary: `Completed step "${located.step.title}"`,
      eventType: 'step.completed',
      payload: { stepId: located.step.id, sessionId: session.id },
      writePlan: plan,
      writeRuntime: nextRuntime,
      writeSessions: sessions,
      eventContext: {
        sessionId: session.id,
        stepId: located.step.id,
      },
    };
  });
}

export async function addBlocker(
  root: string,
  blocker: string,
  actor: MutationActor & SessionContextInput,
  indexDbPath?: string,
) {
  return mutateProject(root, actor, indexDbPath, async ({ plan, runtime, sessions }) => {
    const now = nowIso();
    const branch = actor.branch ?? (await readGitBranch(root));
    const session = ensureSessionRecord(sessions, actor, branch, actor, now);
    const blockers = Array.from(new Set([...runtime.blockers, blocker]));
    const currentStepId = runtime.current_step_id;
    const current = currentStepId ? locateStep(plan, currentStepId) : null;

    if (current) {
      current.step.status = 'blocked';
      if (!current.step.owner_session_id) {
        current.step.owner_session_id = session.id;
      }
    }

    const nextRuntime = refreshRuntimeState(
      plan,
      {
        ...runtime,
        blockers,
        focus_session_id: session.id,
        last_updated_at: now,
      },
      sessions,
      branch,
      now,
    );

    return {
      summary: `Added blocker: ${blocker}`,
      eventType: 'blocker.added',
      payload: { blocker },
      writePlan: plan,
      writeRuntime: nextRuntime,
      writeSessions: sessions,
      eventContext: {
        sessionId: session.id,
        stepId: currentStepId,
      },
    };
  });
}

export async function clearBlocker(
  root: string,
  blocker: string | undefined,
  actor: MutationActor & SessionContextInput,
  indexDbPath?: string,
) {
  return mutateProject(root, actor, indexDbPath, async ({ plan, runtime, sessions }) => {
    const now = nowIso();
    const branch = actor.branch ?? (await readGitBranch(root));
    const session = ensureSessionRecord(sessions, actor, branch, actor, now);
    const blockers =
      blocker && blocker.length > 0
        ? runtime.blockers.filter((candidate) => candidate !== blocker)
        : [];
    const currentStepId = runtime.current_step_id;
    const current = currentStepId ? locateStep(plan, currentStepId) : null;

    if (current && blockers.length === 0 && current.step.status === 'blocked') {
      current.step.status = current.step.owner_session_id ? 'in_progress' : 'todo';
    }

    const nextRuntime = refreshRuntimeState(
      plan,
      {
        ...runtime,
        blockers,
        focus_session_id: session.id,
        last_updated_at: now,
      },
      sessions,
      branch,
      now,
    );

    return {
      summary: blocker ? `Cleared blocker: ${blocker}` : 'Cleared all blockers',
      eventType: 'blocker.cleared',
      payload: blocker ? { blocker } : { cleared: 'all' },
      writePlan: plan,
      writeRuntime: nextRuntime,
      writeSessions: sessions,
      eventContext: {
        sessionId: session.id,
        stepId: currentStepId,
      },
    };
  });
}

export async function addNote(
  root: string,
  note: string,
  actor: MutationActor & SessionContextInput,
  indexDbPath?: string,
) {
  return appendActivityEvent(
    root,
    {
      ...actor,
      summary: note,
      type: 'note.added',
      indexDbPath,
    },
    indexDbPath,
  );
}

export async function updateRuntime(input: RuntimePatchInput) {
  return mutateProject(input.root, input, input.indexDbPath, async ({ plan, runtime, sessions }) => {
    const now = nowIso();
    const nextRuntime = refreshRuntimeState(
      plan,
      {
        ...runtime,
        ...input.patch,
        last_updated_at: now,
      },
      sessions,
      input.patch.active_branch ?? runtime.active_branch ?? (await readGitBranch(input.root)),
      now,
    );

    return {
      summary: input.summary,
      eventType: input.eventType ?? 'runtime.updated',
      payload: input.patch as Record<string, unknown>,
      writeRuntime: nextRuntime,
      writeSessions: sessions,
      eventContext: {
        sessionId: nextRuntime.focus_session_id,
        stepId: nextRuntime.current_step_id,
      },
    };
  });
}

export async function appendActivityEvent(
  root: string,
  event: AppendActivityInput,
  indexDbPath?: string,
) {
  const actor: MutationActor = {
    actor: event.actor,
    source: event.source,
  };

  return mutateProject(root, actor, indexDbPath ?? event.indexDbPath, async ({ plan, runtime, sessions }) => {
    const now = nowIso();
    const branch = event.branch !== undefined ? event.branch : await readGitBranch(root);
    const shouldEnsureSession = event.source !== 'system' || Boolean(event.sessionId);
    const session = shouldEnsureSession
      ? ensureSessionRecord(
          sessions,
          actor,
          branch ?? null,
          {
            sessionId: event.sessionId,
            sessionTitle: event.sessionTitle,
            branch,
          },
          now,
        )
      : null;

    if (session && event.stepId) {
      const index = sessions.sessions.findIndex((candidate) => candidate.id === session.id);
      if (index >= 0) {
        sessions.sessions[index] = ensureObservedStep(sessions.sessions[index], event.stepId);
        sessions.sessions[index].last_updated_at = now;
      }
    }

    const nextRuntime = refreshRuntimeState(
      plan,
      {
        ...runtime,
        focus_session_id: session?.id ?? runtime.focus_session_id,
        last_updated_at: now,
      },
      sessions,
      branch ?? runtime.active_branch ?? null,
      now,
    );

    return {
      summary: event.summary,
      eventType: event.type,
      payload: event.payload ?? {},
      writeRuntime: nextRuntime,
      writeSessions: sessions,
      eventContext: {
        sessionId: session?.id ?? null,
        stepId: event.stepId ?? null,
        subtaskId: event.subtaskId ?? null,
      },
    };
  });
}

export async function proposeDecision(
  root: string,
  proposal: Pick<DecisionProposal, 'title' | 'context' | 'decision' | 'impact'>,
  actor: MutationActor & SessionContextInput,
  indexDbPath?: string,
) {
  return mutateProject(root, actor, indexDbPath, async ({ plan, runtime, sessions, proposals }) => {
    const now = nowIso();
    const branch = actor.branch ?? (await readGitBranch(root));
    const session = ensureSessionRecord(sessions, actor, branch, actor, now);
    const nextProposal = decisionProposalSchema.parse({
      id: crypto.randomUUID(),
      proposed_at: now,
      proposed_by: actor.actor,
      status: 'proposed',
      ...proposal,
    });

    const nextProposals = {
      ...proposals,
      proposals: [...proposals.proposals, nextProposal],
    };
    const nextRuntime = refreshRuntimeState(
      plan,
      {
        ...runtime,
        focus_session_id: session.id,
        last_updated_at: now,
      },
      sessions,
      branch,
      now,
    );

    return {
      summary: `Proposed decision "${proposal.title}"`,
      eventType: 'decision.proposed',
      payload: { proposalId: nextProposal.id },
      writeRuntime: nextRuntime,
      writeSessions: sessions,
      writeProposals: nextProposals,
      eventContext: {
        sessionId: session.id,
        stepId: runtime.current_step_id,
      },
    };
  });
}

export async function acceptDecision(
  root: string,
  proposalId: string,
  actor: MutationActor,
  indexDbPath?: string,
) {
  return withProjectLock(root, async () => {
    const [manifest, proposalFile, decisionsMarkdown] = await Promise.all([
      readManifest(root),
      readPendingProposals(root),
      readDecisionsMarkdown(root),
    ]);

    const target = proposalFile.proposals.find((proposal) => proposal.id === proposalId);
    if (!target) {
      throw new Error(`Unknown decision proposal "${proposalId}"`);
    }

    const remaining = proposalFile.proposals.filter((proposal) => proposal.id !== proposalId);
    await writeYamlAtomic(getWorkflowPaths(root).proposedDecisionsPath, {
      version: 1,
      proposals: remaining,
    });

    const accepted = parseAcceptedDecisions(decisionsMarkdown);
    accepted.push({
      date: target.proposed_at.slice(0, 10),
      title: target.title,
      context: target.context,
      decision: target.decision,
      impact: target.impact,
    });
    await writeTextAtomic(
      getWorkflowPaths(root).decisionsPath,
      buildAcceptedDecisionMarkdown(accepted),
    );

    await appendActivity(root, {
      timestamp: nowIso(),
      actor: actor.actor,
      source: actor.source,
      project_id: manifest.id,
      session_id: null,
      step_id: null,
      subtask_id: null,
      type: 'decision.accepted',
      summary: `Accepted decision "${target.title}"`,
      payload: { proposalId },
    });

    await refreshHandoffFile(root, indexDbPath);
    return getProject(root);
  });
}

export async function refreshHandoff(root: string, actor: MutationActor, indexDbPath?: string) {
  void actor;
  return withProjectLock(root, async () => {
    await refreshHandoffFile(root, indexDbPath);
    return getProject(root);
  });
}
