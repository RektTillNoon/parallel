# Parallel Session Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the repo-first dashboard with a session-first board that surfaces active work across repos while preserving the existing `parallel` light-mode / Nothing-inspired visual language.

**Architecture:** Keep the Tauri command surface stable and assemble the session board in the React app from existing `loadState()` and `getProject()` calls. Add one client-side derivation layer for cross-repo session rows and selected-context state, then replace the main dashboard composition with a ledger + detail rail. Preserve the bundled Doto font and current local/system font strategy; do not introduce remote font loading.

**Tech Stack:** React 19, TypeScript, Vite, Tauri 2, Vitest, CSS

---

## File Structure

**Create**

- `apps/desktop/src/lib/session-board.ts`
- `apps/desktop/src/lib/session-board.test.ts`
- `apps/desktop/src/components/SessionLedger.tsx`
- `apps/desktop/src/components/ContextRail.tsx`

**Modify**

- `apps/desktop/src/App.tsx`
- `apps/desktop/src/styles.css`
- `apps/desktop/src/styles.test.ts`
- `apps/desktop/src/lib/state.test.ts`

**Why**

- `session-board.ts` becomes the canonical client-side derivation path for session-first data. This avoids embedding board logic directly inside `App.tsx`.
- `SessionLedger.tsx` renders the new primary surface.
- `ContextRail.tsx` renders the quiet selected repo/session context.
- `App.tsx` becomes orchestration and data loading rather than a bag of old dashboard panels.
- `styles.css` carries the visual rewrite while preserving the existing design tokens and bundled Doto contract.

## Design Constraints To Preserve During Implementation

- No new Google Fonts. Use bundled `Doto` plus existing sans/mono stacks only.
- Start in light mode only.
- Keep the warm off-white canvas, soft rules, restrained red accent, and lowercase Doto wordmark.
- Apply Nothing-style reduction: fewer framed panels, stronger three-layer hierarchy, more whitespace, less duplicated metadata.

---

### Task 1: Add Session Board Derivation Layer

**Files:**
- Create: `apps/desktop/src/lib/session-board.ts`
- Test: `apps/desktop/src/lib/session-board.test.ts`

- [ ] **Step 1: Write the failing derivation tests**

```ts
import { describe, expect, it } from 'vitest';

import type { LoadStatePayload, ProjectDetail } from './types';
import {
  buildSessionBoard,
  chooseBoardSelection,
  type BoardProjectDetailMap,
} from './session-board';

const loadState: LoadStatePayload = {
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

const detailMap: BoardProjectDetailMap = new Map<string, ProjectDetail>([
  [
    '/Users/light/Projects/parallel',
    {
      manifest: {
        id: 'parallel-1',
        name: 'parallel',
        root: '/Users/light/Projects/parallel',
        kind: 'software',
        owner: 'desktop-user',
        tags: [],
        created_at: '2026-04-11T18:06:10.128Z',
      },
      plan: {
        phases: [
          {
            id: 'define',
            title: 'Define',
            steps: [
              {
                id: 'capture-requirements',
                title: 'Capture requirements',
                summary: 'Write the initial problem statement and success criteria.',
                status: 'in_progress',
                depends_on: [],
                details: ['Write the initial problem statement and success criteria.'],
                subtasks: [],
                owner_session_id: 'session-1',
                completed_at: null,
                completed_by: null,
              },
            ],
          },
        ],
      },
      runtime: {
        current_phase_id: 'define',
        current_step_id: 'capture-requirements',
        focus_session_id: 'session-1',
        next_action: 'Write the initial problem statement and success criteria.',
        status: 'in_progress',
        blockers: [],
        last_updated_at: '2026-04-16T19:24:12.870Z',
        active_branch: 'main',
        active_session_ids: ['session-1'],
      },
      sessions: [
        {
          id: 'session-1',
          title: 'Validate agent bridge from Codex',
          actor: 'codex',
          source: 'agent',
          branch: 'main',
          status: 'active',
          owned_step_id: 'capture-requirements',
          observed_step_ids: [],
          started_at: '2026-04-16T19:24:12.854Z',
          last_updated_at: '2026-04-16T19:24:12.870Z',
        },
      ],
      recentActivity: [],
      blockers: [],
      pendingProposals: [],
      handoff: '',
      decisions: [],
    },
  ],
]);

describe('buildSessionBoard', () => {
  it('builds cross-repo rows from active sessions', () => {
    const board = buildSessionBoard(loadState, detailMap);

    expect(board.rows).toHaveLength(1);
    expect(board.rows[0]).toMatchObject({
      sessionTitle: 'Validate agent bridge from Codex',
      repoName: 'parallel',
      stepTitle: 'Capture requirements',
      status: 'active',
    });
  });

  it('prefers focused session as the default board selection', () => {
    const board = buildSessionBoard(loadState, detailMap);

    expect(chooseBoardSelection(board, null)?.sessionId).toBe('session-1');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @parallel/desktop test -- session-board`

Expected: FAIL with module-not-found or missing export errors for `./session-board`

- [ ] **Step 3: Write the minimal derivation implementation**

```ts
import type { LoadStatePayload, ProjectDetail, WorkflowSession } from './types';

export type BoardProjectDetailMap = Map<string, ProjectDetail>;

export type SessionBoardRow = {
  sessionId: string;
  sessionTitle: string;
  repoRoot: string;
  repoName: string;
  stepId: string | null;
  stepTitle: string;
  summary: string;
  status: WorkflowSession['status'] | 'blocked';
  lastUpdatedAt: string;
};

export type SessionBoardData = {
  rows: SessionBoardRow[];
};

export function buildSessionBoard(
  state: LoadStatePayload,
  detailMap: BoardProjectDetailMap,
): SessionBoardData {
  const rows: SessionBoardRow[] = [];

  for (const project of state.projects) {
    const detail = detailMap.get(project.root);
    if (!detail) continue;

    for (const session of detail.sessions) {
      if (session.status !== 'active') continue;
      const step = detail.plan.phases.flatMap((phase) => phase.steps).find((candidate) => candidate.id === session.owned_step_id);
      rows.push({
        sessionId: session.id,
        sessionTitle: session.title,
        repoRoot: project.root,
        repoName: project.name,
        stepId: session.owned_step_id,
        stepTitle: step?.title ?? 'No owned step',
        summary: step?.summary ?? detail.runtime.next_action,
        status: detail.runtime.blockers.length > 0 ? 'blocked' : session.status,
        lastUpdatedAt: session.last_updated_at,
      });
    }
  }

  rows.sort((left, right) => Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt));
  return { rows };
}

export function chooseBoardSelection(board: SessionBoardData, selectedSessionId: string | null) {
  return board.rows.find((row) => row.sessionId === selectedSessionId) ?? board.rows[0] ?? null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @parallel/desktop test -- session-board`

Expected: PASS with `buildSessionBoard` and `chooseBoardSelection` tests green

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/session-board.ts apps/desktop/src/lib/session-board.test.ts
git commit -m "test(ui): add session board derivation coverage"
```

---

### Task 2: Load Board Data In App And Switch Default View To Session-First

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Test: `apps/desktop/src/lib/state.test.ts`

- [ ] **Step 1: Add the failing selection/load tests**

```ts
import { describe, expect, it } from 'vitest';

import type { LoadStatePayload } from './types';
import { resolveSelectionState } from './state';

describe('resolveSelectionState for session board mode', () => {
  it('still keeps the last focused repo selected for contextual detail', () => {
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
    } satisfies LoadStatePayload;

    const result = resolveSelectionState(state);
    expect(result.selectedRoot).toBe('/Users/light/Projects/parallel');
    expect(result.shouldLoadDetail).toBe(true);
  });
});
```

- [ ] **Step 2: Run the current desktop tests**

Run: `pnpm --filter @parallel/desktop test`

Expected: PASS for existing tests and FAIL only if the new selection behavior test exposes a regression

- [ ] **Step 3: Refactor `App.tsx` to keep a detail map for live repos**

```ts
const [detailMap, setDetailMap] = useState<Map<string, ProjectDetail>>(new Map());
const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

const loadBoardDetails = useCallback(async (nextState: LoadStatePayload) => {
  const rootsToLoad = nextState.projects
    .filter((project) => project.initialized && (project.activeSessionCount > 0 || project.root === selectedRootRef.current))
    .map((project) => project.root);

  const entries = await Promise.all(
    rootsToLoad.map(async (root) => [root, await getProject(root)] as const),
  );

  setDetailMap(new Map(entries));
}, []);
```

```ts
const board = useMemo(() => buildSessionBoard(state ?? emptyState, detailMap), [state, detailMap]);
const selectedBoardRow = useMemo(
  () => chooseBoardSelection(board, selectedSessionId),
  [board, selectedSessionId],
);
```

```ts
useEffect(() => {
  if (!state) return;
  void loadBoardDetails(state);
}, [state, loadBoardDetails]);
```

- [ ] **Step 4: Remove repo-first main-surface assumptions**

```ts
// Delete default rendering paths that require FocusPanel/SessionsPanel/TimelinePanel
// as the main information hierarchy. Keep selectedRoot for contextual detail only.
```

- [ ] **Step 5: Run the test suite**

Run: `pnpm --filter @parallel/desktop test`

Expected: PASS with updated selection logic and no regressions in bridge/state helpers

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/App.tsx apps/desktop/src/lib/state.test.ts
git commit -m "feat(ui): switch app state to session-first board loading"
```

---

### Task 3: Build The Session Ledger And Context Rail Components

**Files:**
- Create: `apps/desktop/src/components/SessionLedger.tsx`
- Create: `apps/desktop/src/components/ContextRail.tsx`
- Modify: `apps/desktop/src/App.tsx`

- [ ] **Step 1: Write the minimal presentational components**

```tsx
import { memo } from 'react';

import type { SessionBoardRow } from '../lib/session-board';

type SessionLedgerProps = {
  rows: SessionBoardRow[];
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  formatRelativeTime: (value: string | null | undefined) => string;
};

export default memo(function SessionLedger({
  rows,
  selectedSessionId,
  onSelectSession,
  formatRelativeTime,
}: SessionLedgerProps) {
  return (
    <section className="session-ledger" aria-label="Active sessions">
      {rows.map((row) => (
        <button
          key={row.sessionId}
          type="button"
          className={`session-ledger-row ${row.sessionId === selectedSessionId ? 'is-selected' : ''}`}
          onClick={() => onSelectSession(row.sessionId)}
        >
          <div className="session-ledger-copy">
            <div className="session-ledger-title">
              <strong>{row.sessionTitle}</strong>
              <span className={`session-ledger-status status-${row.status}`}>{row.status}</span>
            </div>
            <div className="session-ledger-meta">{row.repoName} · {row.stepTitle}</div>
            <div className="session-ledger-summary">{row.summary}</div>
          </div>
          <span className="session-ledger-time">{formatRelativeTime(row.lastUpdatedAt)}</span>
        </button>
      ))}
    </section>
  );
});
```

```tsx
import { memo } from 'react';

import type { ProjectDetail } from '../lib/types';

type ContextRailProps = {
  detail: ProjectDetail | null;
  currentStepTitle: string;
};

export default memo(function ContextRail({ detail, currentStepTitle }: ContextRailProps) {
  if (!detail) {
    return null;
  }

  return (
    <aside className="context-rail">
      <section>
        <label>Selected repo</label>
        <h2>{detail.manifest.name}</h2>
        <p>{detail.manifest.root}</p>
      </section>
      <section>
        <label>Current step</label>
        <h3>{currentStepTitle}</h3>
        <p>{detail.runtime.next_action}</p>
      </section>
      <section>
        <label>Recent activity</label>
        <div className="context-activity-list">
          {detail.recentActivity.slice(0, 3).map((event) => (
            <article key={`${event.timestamp}-${event.summary}`}>
              <strong>{event.summary}</strong>
            </article>
          ))}
        </div>
      </section>
    </aside>
  );
});
```

- [ ] **Step 2: Wire the components into `App.tsx`**

```tsx
<section className="board-topline">
  <div>
    <h2>Active sessions</h2>
    <p className="muted">Cross-repo board. Selected repo detail is secondary.</p>
  </div>
  <div className="board-stats">
    <span>{board.rows.length} active</span>
    <span>{state?.projects.filter((project) => project.blockerCount > 0).length ?? 0} blocked</span>
    <span>{state?.projects.filter((project) => project.activeSessionCount > 0).length ?? 0} repos live</span>
  </div>
</section>

<section className="session-board-layout">
  <SessionLedger
    rows={board.rows}
    selectedSessionId={selectedBoardRow?.sessionId ?? null}
    onSelectSession={setSelectedSessionId}
    formatRelativeTime={formatRelativeTime}
  />
  <ContextRail
    detail={selectedBoardRow ? detailMap.get(selectedBoardRow.repoRoot) ?? null : detail}
    currentStepTitle={selectedBoardRow?.stepTitle ?? 'No current step'}
  />
</section>
```

- [ ] **Step 3: Remove old dashboard-first rendering blocks**

```tsx
// Delete FocusPanel, PlanPanel, SessionsPanel, TimelinePanel usage from the default
// workspace view. Keep any repo-specific plan/detail helpers only if the context rail
// still needs them.
```

- [ ] **Step 4: Run the desktop tests**

Run: `pnpm --filter @parallel/desktop test`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/App.tsx apps/desktop/src/components/SessionLedger.tsx apps/desktop/src/components/ContextRail.tsx
git commit -m "feat(ui): add session ledger and context rail"
```

---

### Task 4: Rewrite Styles To The Approved House-Style Direction

**Files:**
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/src/styles.test.ts`

- [ ] **Step 1: Add the failing style contract assertions**

```ts
it('keeps the app in a light Nothing-style surface system', () => {
  expect(styles).toMatch(/--page:\s*#f[0-9a-f]{5}/i);
  expect(styles).toMatch(/--surface:\s*#f[0-9a-f]{5}|#fff/i);
  expect(styles).toMatch(/--font-display:\s*"Doto"/);
});

it('does not reintroduce heavy dashboard chrome', () => {
  expect(styles).not.toMatch(/backdrop-filter:\s*blur/i);
  expect(styles).not.toMatch(/box-shadow:\s*0 24px 80px/i);
});
```

- [ ] **Step 2: Replace the dashboard layout rules with board-specific styles**

```css
.main {
  display: grid;
  gap: 1.5rem;
  padding: 1.5rem;
}

.board-topline {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1rem;
  padding-bottom: 0.9rem;
  border-bottom: 1px solid var(--border);
}

.session-board-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) minmax(280px, 0.82fr);
  gap: 1.75rem;
}

.session-ledger {
  display: grid;
  gap: 0;
  border: 1px solid rgba(18, 18, 18, 0.08);
  border-radius: 24px;
  background: rgba(255, 255, 255, 0.68);
}

.session-ledger-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 1rem;
  padding: 1.1rem 1.2rem;
  border-bottom: 1px solid rgba(18, 18, 18, 0.08);
  background: transparent;
  border-radius: 0;
}

.context-rail {
  display: grid;
  gap: 1.1rem;
  padding-left: 1.1rem;
  border-left: 1px solid var(--border);
}
```

- [ ] **Step 3: Prune stale styles**

```css
/* Delete dashboard-era selectors that are no longer rendered:
   .focus-panel
   .plan-panel
   .session-panel
   .timeline-panel
   .workspace-grid
   .workspace-main
   .workspace-side
*/
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @parallel/desktop test`

Expected: PASS, including the bundled Doto font contract and no remote-font regressions

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/styles.css apps/desktop/src/styles.test.ts
git commit -m "feat(ui): restyle desktop app as session-first board"
```

---

### Task 5: Verify The New Default Experience End-To-End

**Files:**
- Modify if needed: `apps/desktop/src/App.tsx`

- [ ] **Step 1: Run the full desktop test suite**

Run: `pnpm --filter @parallel/desktop test`

Expected: PASS

- [ ] **Step 2: Start the app locally**

Run: `pnpm dev:desktop`

Expected: Desktop window opens with the session board as first paint

- [ ] **Step 3: Verify the approved UX manually**

Checklist:

```text
- The first thing visible is active sessions across repos
- The Doto wordmark and current light-mode identity remain intact
- The selected repo context sits in a quiet right rail
- The app no longer feels like four equal dashboard cards competing
- No remote fonts are requested
```

- [ ] **Step 4: If visual polish issues remain, make one final pass**

```text
Limit changes to spacing, hierarchy, and copy density. Do not add new features during polish.
```

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/App.tsx apps/desktop/src/components apps/desktop/src/lib apps/desktop/src/styles.css apps/desktop/src/styles.test.ts
git commit -m "feat(ui): ship session-first parallel desktop layout"
```

---

## Self-Review

### Spec coverage

- Session-first default board: covered by Tasks 2 and 3
- Quiet contextual rail: covered by Task 3
- Preserve `parallel` identity and Nothing-style reduction: covered by Task 4
- No new feature expansion: enforced in Task 5 checklist

### Placeholder scan

- No `TODO`, `TBD`, or “implement later” placeholders remain
- Each task includes exact file paths and executable commands

### Type consistency

- `SessionBoardRow`, `BoardProjectDetailMap`, and `chooseBoardSelection` are introduced in Task 1 and referenced consistently later

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-16-parallel-session-board.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
