import type { BoardProjectDetail, LoadStatePayload, WorkflowSession } from './types';

export type SessionBoardDisplayState = 'active' | 'blocked' | 'needs-step';
export type SessionBoardStepState = 'owned' | 'unclaimed';

export type SessionBoardRow = {
  sessionId: string;
  sessionTitle: string;
  projectRoot: string;
  projectName: string;
  branch: string | null;
  source: WorkflowSession['source'];
  stepId: string | null;
  stepTitle: string;
  summary: string;
  status: WorkflowSession['status'] | 'blocked';
  displayState: SessionBoardDisplayState;
  displayLabel: string;
  stepState: SessionBoardStepState;
  lastUpdatedAt: string;
};

export type SessionBoardData = {
  rows: SessionBoardRow[];
};

function toSortTimestamp(value: string) {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
}

function buildBoardProjectLookup(boardProjects: BoardProjectDetail[]) {
  return new Map(boardProjects.map((project) => [project.root, project] as const));
}

function deriveDisplayState(
  blocked: boolean,
  stepState: SessionBoardStepState,
): SessionBoardDisplayState {
  if (blocked) {
    return 'blocked';
  }

  return stepState === 'owned' ? 'active' : 'needs-step';
}

function formatDisplayLabel(displayState: SessionBoardDisplayState) {
  switch (displayState) {
    case 'needs-step':
      return 'unclaimed';
    default:
      return displayState;
  }
}

export function buildSessionBoard(
  state: LoadStatePayload,
): SessionBoardData {
  const rows: SessionBoardRow[] = [];
  const boardProjectLookup = buildBoardProjectLookup(state.boardProjects);

  for (const project of state.projects) {
    const detail = boardProjectLookup.get(project.root);
    if (!detail) continue;

    for (const session of detail.sessions) {
      if (session.status !== 'active') continue;

      const step = session.owned_step_id ? detail.activeStepLookup[session.owned_step_id] ?? null : null;
      const stepState: SessionBoardStepState = step ? 'owned' : 'unclaimed';
      const displayState = deriveDisplayState(detail.blockers.length > 0, stepState);

      rows.push({
        sessionId: session.id,
        sessionTitle: session.title,
        projectRoot: project.root,
        projectName: project.name,
        branch: session.branch,
        source: session.source,
        stepId: session.owned_step_id,
        stepTitle: step?.title ?? 'No step claimed',
        summary: step?.summary ?? detail.runtimeNextAction,
        status: detail.blockers.length > 0 ? 'blocked' : session.status,
        displayState,
        displayLabel: formatDisplayLabel(displayState),
        stepState,
        lastUpdatedAt: session.last_updated_at,
      });
    }
  }

  rows.sort((left, right) => toSortTimestamp(right.lastUpdatedAt) - toSortTimestamp(left.lastUpdatedAt));

  return { rows };
}

export function chooseBoardSelection(
  board: SessionBoardData,
  selectedSessionId: string | null,
): SessionBoardRow | null {
  return board.rows.find((row) => row.sessionId === selectedSessionId) ?? board.rows[0] ?? null;
}
