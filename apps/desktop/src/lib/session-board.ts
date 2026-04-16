import type { LoadStatePayload, Phase, ProjectDetail, Step, WorkflowSession } from './types';

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

function buildStepLookup(phases: Phase[]) {
  const lookup = new Map<string, Step>();

  for (const phase of phases) {
    for (const step of phase.steps) {
      lookup.set(step.id, step);
    }
  }

  return lookup;
}

function toSortTimestamp(value: string) {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
}

export function buildSessionBoard(
  state: LoadStatePayload,
  detailMap: BoardProjectDetailMap,
): SessionBoardData {
  const rows: SessionBoardRow[] = [];

  for (const project of state.projects) {
    const detail = detailMap.get(project.root);
    if (!detail) continue;

    const stepLookup = buildStepLookup(detail.plan.phases);

    for (const session of detail.sessions) {
      if (session.status !== 'active') continue;

      const step = session.owned_step_id ? stepLookup.get(session.owned_step_id) ?? null : null;

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

  rows.sort((left, right) => toSortTimestamp(right.lastUpdatedAt) - toSortTimestamp(left.lastUpdatedAt));

  return { rows };
}

export function chooseBoardSelection(
  board: SessionBoardData,
  selectedSessionId: string | null,
): SessionBoardRow | null {
  return board.rows.find((row) => row.sessionId === selectedSessionId) ?? board.rows[0] ?? null;
}
