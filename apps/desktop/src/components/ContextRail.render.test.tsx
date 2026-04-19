import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import ContextRail from './ContextRail';
import type { BoardProjectDetail, ProjectSummary } from '../lib/types';

const project = {
  id: 'trading-1',
  name: 'trading',
  root: '/Users/light/Projects/trading',
  kind: 'software',
  owner: 'light',
  tags: [],
  initialized: true,
  status: 'in_progress',
  stale: false,
  missing: false,
  currentStepId: null,
  currentStepTitle: null,
  blockerCount: 0,
  totalStepCount: 3,
  completedStepCount: 0,
  activeSessionCount: 2,
  focusSessionId: 'session-1',
  lastUpdatedAt: '2026-04-18T23:34:53.000Z',
  nextAction: 'Write the initial problem statement and success criteria.',
  activeBranch: 'main',
  pendingProposalCount: 0,
  discoverySource: 'parallel',
  discoveryPath: null,
} satisfies ProjectSummary;

const detail = {
  root: '/Users/light/Projects/trading',
  sessions: [],
  runtimeNextAction: 'Write the initial problem statement and success criteria.',
  blockers: [],
  recentActivity: [
    {
      timestamp: '2026-04-18T23:20:00.000Z',
      actor: 'codex',
      source: 'agent',
      project_id: 'trading-1',
      session_id: 'session-1',
      step_id: null,
      subtask_id: null,
      type: 'note',
      summary: 'Ensured session "projectctl session"',
      payload: {},
    },
    {
      timestamp: '2026-04-18T23:19:00.000Z',
      actor: 'codex',
      source: 'agent',
      project_id: 'trading-1',
      session_id: 'session-1',
      step_id: null,
      subtask_id: null,
      type: 'note',
      summary: 'Verified current Leo CLI ergonomics',
      payload: {},
    },
    {
      timestamp: '2026-04-18T23:18:00.000Z',
      actor: 'codex',
      source: 'agent',
      project_id: 'trading-1',
      session_id: 'session-1',
      step_id: null,
      subtask_id: null,
      type: 'note',
      summary: 'Started step "Capture requirements"',
      payload: {},
    },
    {
      timestamp: '2026-04-18T23:17:00.000Z',
      actor: 'codex',
      source: 'agent',
      project_id: 'trading-1',
      session_id: 'session-1',
      step_id: null,
      subtask_id: null,
      type: 'note',
      summary: 'Ensured session "Leo interactive CLI workflow"',
      payload: {},
    },
    {
      timestamp: '2026-04-18T23:16:00.000Z',
      actor: 'codex',
      source: 'agent',
      project_id: 'trading-1',
      session_id: 'session-1',
      step_id: null,
      subtask_id: null,
      type: 'note',
      summary: 'Reviewed Hyperliquid historical-data options',
      payload: {},
    },
  ],
  activeStepLookup: {},
} satisfies BoardProjectDetail;

describe('ContextRail', () => {
  it('renders session-first context with compact recent activity marginalia', () => {
    const html = renderToStaticMarkup(
      <ContextRail
        project={project}
        detail={detail}
        sessionTitle="projectctl session"
        sessionDisplayState="needs-step"
        sessionStatusLabel="unclaimed"
        currentStepTitle="No step claimed"
        currentStepSummary="Write the initial problem statement and success criteria."
        currentStepOwned={false}
      />,
    );

    expect(html).toContain('Session');
    expect(html).toContain('projectctl session');
    expect(html).toContain('unclaimed');
    expect(html).toContain('trading');
    expect(html).toContain('/Users/light/Projects/trading');
    expect(html).toContain('Step');
    expect(html).toContain('No step claimed');
    expect(html).toContain('Next: Write the initial problem statement and success criteria.');
    expect(html).toContain('Recent');
    expect(html).not.toContain('Selected session');
    expect(html).not.toContain('Managed by Parallel');
    expect(html).toContain('Ensured session &quot;projectctl session&quot;');
    expect(html).toContain('Verified current Leo CLI ergonomics');
    expect(html).toContain('context-activity-compact-dot');
    expect(html).toContain('+1 more');
    expect(html).not.toContain('Reviewed Hyperliquid historical-data options');
  });
});
