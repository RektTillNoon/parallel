import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  acceptDecision,
  addBlocker,
  addNote,
  appendActivityEvent,
  clearBlocker,
  completeStep,
  ensureSession,
  getProject,
  initProject,
  listProjects,
  planSchema,
  proposeDecision,
  runtimeSchema,
  syncPlan,
  startStep,
} from '../src';

async function createRepo(name: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
  await fs.mkdir(path.join(root, '.git'), { recursive: true });
  await fs.writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  return root;
}

async function createWorktreeStyleRepo(root: string) {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, '.git'), 'gitdir: /tmp/fake-worktree-gitdir\n', 'utf8');
}

describe('workflow core', () => {
  let repoRoot: string;
  let indexDbPath: string;

  beforeEach(async () => {
    repoRoot = await createRepo('parallel-project');
    indexDbPath = path.join(repoRoot, '.app', 'index.sqlite');
  });

  it('initializes the expected workflow files and gitignore entry', async () => {
    await initProject({
      root: repoRoot,
      actor: 'tester',
      source: 'cli',
      name: 'Parallel',
      indexDbPath,
    });

    const workflowDir = path.join(repoRoot, '.project-workflow');
    const gitignore = await fs.readFile(path.join(repoRoot, '.gitignore'), 'utf8');

    expect(await fs.stat(path.join(workflowDir, 'manifest.yaml'))).toBeTruthy();
    expect(await fs.stat(path.join(workflowDir, 'plan.yaml'))).toBeTruthy();
    expect(await fs.stat(path.join(workflowDir, 'decisions.md'))).toBeTruthy();
    expect(await fs.stat(path.join(workflowDir, 'local', 'runtime.yaml'))).toBeTruthy();
    expect(await fs.stat(path.join(workflowDir, 'local', 'activity.jsonl'))).toBeTruthy();
    expect(await fs.stat(path.join(workflowDir, 'local', 'decisions-proposed.yaml'))).toBeTruthy();
    expect(await fs.stat(path.join(workflowDir, 'local', 'handoff.md'))).toBeTruthy();
    expect(gitignore).toContain('.project-workflow/local/');
  });

  it('rejects malformed plan and runtime shapes', () => {
    expect(() =>
      planSchema.parse({
        version: 1,
        phases: [
          {
            id: 'phase-a',
            title: 'Phase A',
            steps: [
              {
                id: 'step-a',
                title: 'Step A',
                status: 'todo',
                acceptance: [],
                depends_on: ['missing-step'],
                notes: [],
              },
            ],
          },
        ],
      }),
    ).toThrow(/Unknown dependency/);

    expect(() =>
      runtimeSchema.parse({
        version: 1,
        current_phase_id: 'phase-a',
        current_step_id: 'step-a',
        next_action: 'Do the thing',
        status: 'invalid',
        blockers: [],
        last_updated_at: new Date().toISOString(),
        active_branch: 'main',
        active_session_ids: [],
      }),
    ).toThrow();
  });

  it('supports step mutation, blockers, notes, proposals, and acceptance', async () => {
    await initProject({
      root: repoRoot,
      actor: 'tester',
      source: 'cli',
      name: 'Parallel',
      indexDbPath,
    });

    const detail = await getProject(repoRoot);
    const firstStepId = detail.plan.phases[0].steps[0].id;

    await startStep(repoRoot, firstStepId, { actor: 'agent-1', source: 'agent' }, indexDbPath);
    await addBlocker(repoRoot, 'Need design sign-off', { actor: 'agent-1', source: 'agent' }, indexDbPath);
    await clearBlocker(repoRoot, 'Need design sign-off', { actor: 'agent-1', source: 'agent' }, indexDbPath);
    await addNote(repoRoot, 'Captured initial requirements', { actor: 'agent-1', source: 'agent' }, indexDbPath);
    await completeStep(repoRoot, firstStepId, { actor: 'agent-1', source: 'agent' }, indexDbPath);
    const afterCompletion = await proposeDecision(
      repoRoot,
      {
        title: 'Use Tauri shell',
        context: 'Need a desktop container',
        decision: 'Use Tauri with a React webview',
        impact: 'Keeps the shell thin and native enough for tray support',
      },
      { actor: 'agent-1', source: 'agent' },
      indexDbPath,
    );

    expect(afterCompletion.pendingProposals).toHaveLength(1);

    const accepted = await acceptDecision(
      repoRoot,
      afterCompletion.pendingProposals[0].id,
      { actor: 'human-reviewer', source: 'desktop' },
      indexDbPath,
    );

    expect(accepted.pendingProposals).toHaveLength(0);
    expect(accepted.decisions).toHaveLength(1);
    expect(accepted.decisions[0]?.title).toBe('Use Tauri shell');
  });

  it('serializes concurrent note writes through the project lock', async () => {
    await initProject({
      root: repoRoot,
      actor: 'tester',
      source: 'cli',
      indexDbPath,
    });

    await Promise.all([
      addNote(repoRoot, 'First note', { actor: 'agent-a', source: 'agent' }, indexDbPath),
      addNote(repoRoot, 'Second note', { actor: 'agent-b', source: 'agent' }, indexDbPath),
    ]);

    const detail = await getProject(repoRoot);
    const noteEvents = detail.recentActivity.filter((event) => event.type === 'note.added');
    expect(noteEvents).toHaveLength(2);
  });

  it('discovers initialized and uninitialized repos under watched roots', async () => {
    const watchedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'parallel-roots-'));
    const initializedRepo = path.join(watchedRoot, 'initialized');
    const uninitializedRepo = path.join(watchedRoot, 'uninitialized');
    const worktreeRepo = path.join(watchedRoot, 'worktree-repo');
    await fs.mkdir(path.join(initializedRepo, '.git'), { recursive: true });
    await fs.writeFile(path.join(initializedRepo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    await fs.mkdir(path.join(uninitializedRepo, '.git'), { recursive: true });
    await fs.writeFile(path.join(uninitializedRepo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    await createWorktreeStyleRepo(worktreeRepo);

    await initProject({
      root: initializedRepo,
      actor: 'tester',
      source: 'cli',
      name: 'Initialized Repo',
      indexDbPath,
    });

    const projects = await listProjects([watchedRoot], indexDbPath);
    const names = projects.map((project) => project.name);

    expect(names).toContain('Initialized Repo');
    expect(names).toContain('uninitialized');
    expect(names).toContain('worktree-repo');
    expect(projects.find((project) => project.root === uninitializedRepo)?.status).toBe('uninitialized');
    expect(projects.find((project) => project.root === worktreeRepo)?.status).toBe('uninitialized');
  });

  it('syncs a canonical plan with details and preserves step ids across edits', async () => {
    await initProject({
      root: repoRoot,
      actor: 'tester',
      source: 'cli',
      name: 'Parallel',
      indexDbPath,
    });

    const first = await syncPlan({
      root: repoRoot,
      actor: 'codex',
      source: 'agent',
      sessionTitle: 'Spec sync',
      phases: [
        {
          title: 'Build',
          steps: [
            {
              title: 'Build the Hyperliquid recorder',
              summary: 'Write raw venue-native events to disk.',
              details: ['Record book snapshots, trades, funding, premium, mark/oracle.'],
              subtasks: [{ title: 'Book snapshots' }, { title: 'Trades' }],
            },
            {
              title: 'Implement deterministic normalization jobs',
              summary: 'Transform raw events into normalized Stack A/B/C rows.',
            },
          ],
        },
      ],
      indexDbPath,
    });

    const originalFirstStepId = first.plan.phases[0].steps[0].id;

    const second = await syncPlan({
      root: repoRoot,
      actor: 'codex',
      source: 'agent',
      sessionTitle: 'Spec sync',
      phases: [
        {
          title: 'Build',
          steps: [
            {
              title: 'Build the Hyperliquid recorder',
              summary: 'Write raw venue-native events to disk.',
              details: ['Record book snapshots, trades, funding, premium, mark/oracle, and OI.'],
            },
            {
              title: 'Implement deterministic normalization jobs',
              summary: 'Transform raw events into normalized Stack A/B/C rows.',
            },
          ],
        },
      ],
      indexDbPath,
    });

    expect(second.plan.phases[0].steps[0].id).toBe(originalFirstStepId);
    expect(second.plan.phases[0].steps[0].details[0]).toContain('OI');
    expect(second.sessions).toHaveLength(1);
    expect(second.sessions[0]?.title).toBe('Spec sync');
  });

  it('auto-creates and resumes sessions, enforcing single-step ownership', async () => {
    await initProject({
      root: repoRoot,
      actor: 'tester',
      source: 'cli',
      name: 'Parallel',
      indexDbPath,
    });

    const synced = await syncPlan({
      root: repoRoot,
      actor: 'codex',
      source: 'agent',
      sessionTitle: 'Recorder build',
      phases: [
        {
          title: 'Build',
          steps: [
            { id: 'step-a', title: 'Build recorder', summary: 'Record venue-native events.' },
            {
              id: 'step-b',
              title: 'Normalize events',
              summary: 'Produce deterministic rows.',
              depends_on: ['step-a'],
            },
          ],
        },
      ],
      indexDbPath,
    });

    const started = await startStep(
      repoRoot,
      'step-a',
      { actor: 'codex', source: 'agent', branch: 'main' },
      indexDbPath,
    );
    const resumed = await ensureSession({
      root: repoRoot,
      actor: 'codex',
      source: 'agent',
      branch: 'main',
      indexDbPath,
    });

    expect(started.sessions).toHaveLength(1);
    const activeAgentSessions = started.sessions.filter(
      (session) => session.actor === 'codex' && session.status === 'active',
    );
    expect(activeAgentSessions).toHaveLength(1);
    expect(resumed.runtime.focus_session_id).toBe(activeAgentSessions[0]?.id ?? null);

    await expect(
      startStep(
        repoRoot,
        'step-a',
        { actor: 'claude', source: 'agent', branch: 'main' },
        indexDbPath,
      ),
    ).rejects.toThrow(/owned by another session/);

    expect(synced.runtime.current_step_id).toBe('step-a');
  });

  it('allows observer activity from a non-owning session and advances to the next step on completion', async () => {
    await initProject({
      root: repoRoot,
      actor: 'tester',
      source: 'cli',
      name: 'Parallel',
      indexDbPath,
    });

    await syncPlan({
      root: repoRoot,
      actor: 'codex',
      source: 'agent',
      sessionTitle: 'Plan sync',
      phases: [
        {
          title: 'Build',
          steps: [
            { id: 'step-a', title: 'Build recorder', summary: 'Record venue-native events.' },
            {
              id: 'step-b',
              title: 'Normalize events',
              summary: 'Produce deterministic rows.',
              depends_on: ['step-a'],
            },
          ],
        },
      ],
      indexDbPath,
    });

    const ownerState = await startStep(
      repoRoot,
      'step-a',
      { actor: 'codex', source: 'agent', branch: 'main', sessionTitle: 'Owner' },
      indexDbPath,
    );
    const ownerSessionId = ownerState.runtime.focus_session_id;
    expect(ownerSessionId).toBeTruthy();

    const observed = await appendActivityEvent(
      repoRoot,
      {
        actor: 'claude',
        source: 'agent',
        branch: 'main',
        sessionTitle: 'Observer',
        type: 'note.added',
        summary: 'Validated normalization edge cases.',
        stepId: 'step-a',
        indexDbPath,
      },
      indexDbPath,
    );

    const observerSession = observed.sessions.find((session) => session.actor === 'claude');
    expect(observerSession?.observed_step_ids).toContain('step-a');

    const completed = await completeStep(
      repoRoot,
      'step-a',
      { actor: 'codex', source: 'agent', branch: 'main', sessionId: ownerSessionId ?? undefined },
      indexDbPath,
    );

    expect(completed.runtime.current_step_id).toBe('step-b');
    expect(completed.runtime.next_action).toContain('Normalize events');
    expect(completed.recentActivity.at(-1)?.step_id).toBe('step-a');
  });
});
