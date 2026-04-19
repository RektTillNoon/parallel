import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import FocusView, { resolveLastTouchedPhrase } from './FocusView';
import type { BoardProjectDetail, ProjectSummary } from '../lib/types';
import type { SessionBoardRow } from '../lib/session-board';

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
  lastUpdatedAt: '2026-04-16T19:46:00Z',
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
      timestamp: '2026-04-16T19:46:00Z',
      actor: 'codex',
      source: 'agent',
      project_id: 'trading-1',
      session_id: 'session-1',
      step_id: null,
      subtask_id: null,
      type: 'note',
      summary: 'Fixed backfill-hyperliquid run TTY output',
      payload: {},
    },
    {
      timestamp: '2026-04-16T19:40:00Z',
      actor: 'codex',
      source: 'agent',
      project_id: 'trading-1',
      session_id: 'session-1',
      step_id: null,
      subtask_id: null,
      type: 'note',
      summary: 'Verified top-level backfill output',
      payload: {},
    },
  ],
  activeStepLookup: {},
} satisfies BoardProjectDetail;

const session: SessionBoardRow = {
  sessionId: 'session-1',
  sessionTitle: 'projectctl session',
  projectRoot: '/Users/light/Projects/trading',
  projectName: 'trading',
  branch: 'main',
  source: 'agent',
  stepId: null,
  stepTitle: 'No step claimed',
  summary: 'Write the initial problem statement and success criteria.',
  status: 'active',
  displayState: 'needs-step',
  displayLabel: 'unclaimed',
  stepState: 'unclaimed',
  lastUpdatedAt: '2026-04-16T19:46:00Z',
};

describe('resolveLastTouchedPhrase', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-16T20:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders humane relative phrasing', () => {
    expect(resolveLastTouchedPhrase('2026-04-16T19:59:45Z')).toBe('just now');
    expect(resolveLastTouchedPhrase('2026-04-16T19:46:00Z')).toBe('14 minutes ago');
    expect(resolveLastTouchedPhrase('2026-04-16T17:00:00Z')).toBe('3 hours ago');
    expect(resolveLastTouchedPhrase('2026-04-15T20:00:00Z')).toBe('yesterday');
    expect(resolveLastTouchedPhrase(null)).toBe('Never touched');
    expect(resolveLastTouchedPhrase('broken-timestamp')).toBe('Never touched');
  });
});

describe('FocusView', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-16T20:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('leads with when and what, then lists recent activity', () => {
    const html = renderToStaticMarkup(
      <FocusView
        project={project}
        detail={detail}
        session={session}
        summary="Write the initial problem statement and success criteria."
      />,
    );

    expect(html).toContain('Last touched');
    expect(html).toContain('14 minutes ago');
    expect(html).toContain('trading');
    expect(html).toContain('main');
    expect(html).toContain('unclaimed');
    expect(html).toContain('Working on');
    expect(html).toContain('Write the initial problem statement and success criteria.');
    expect(html).toContain('Recent activity');
    expect(html).toContain('Fixed backfill-hyperliquid run TTY output');
    expect(html).toContain('Verified top-level backfill output');
    expect(html).toContain('focus-feed-dot');
    expect(html).toContain('/Users/light/Projects/trading');
    expect(html).not.toContain('Project pulse');
    expect(html).not.toContain('live sessions');
    expect(html).not.toContain('steps done');
  });

  it('hides the status badge when the session is active', () => {
    const html = renderToStaticMarkup(
      <FocusView
        project={project}
        detail={detail}
        session={{ ...session, displayState: 'active', displayLabel: 'active' }}
        summary="Write the initial problem statement and success criteria."
      />,
    );

    expect(html).not.toContain('focus-badge-active');
  });

  it('shows an empty feed state when no activity has been recorded', () => {
    const html = renderToStaticMarkup(
      <FocusView
        project={project}
        detail={{ ...detail, recentActivity: [] }}
        session={null}
        summary="Initialize workflow metadata"
      />,
    );

    expect(html).toContain('Nothing logged yet.');
  });
});
