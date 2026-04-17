import type { BoardProjectDetail, LoadStatePayload, WorkflowSession } from './types';

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

function toSortTimestamp(value: string) {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
}

function buildBoardProjectLookup(boardProjects: BoardProjectDetail[]) {
  return new Map(boardProjects.map((project) => [project.root, project] as const));
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

      rows.push({
        sessionId: session.id,
        sessionTitle: session.title,
        repoRoot: project.root,
        repoName: project.name,
        stepId: session.owned_step_id,
        stepTitle: step?.title ?? 'No owned step',
        summary: step?.summary ?? detail.runtimeNextAction,
        status: detail.blockers.length > 0 ? 'blocked' : session.status,
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
