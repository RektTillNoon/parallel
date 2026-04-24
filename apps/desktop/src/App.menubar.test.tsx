import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MenubarPopover, buildMenubarStats } from './App';
import type { ProjectSummaryWithLight } from './lib/project-light';

function makeProject(overrides: Partial<ProjectSummaryWithLight>): ProjectSummaryWithLight {
  return {
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
    currentStepId: null,
    currentStepTitle: null,
    blockerCount: 0,
    totalStepCount: 0,
    completedStepCount: 0,
    activeSessionCount: 1,
    focusSessionId: null,
    lastUpdatedAt: '2026-04-16T19:58:00.000Z',
    nextAction: null,
    activeBranch: 'main',
    pendingProposalCount: 0,
    discoverySource: 'parallel',
    discoveryPath: null,
    lightState: 'live',
    lightLabel: 'Live work',
    ...overrides,
  };
}

describe('MenubarPopover', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-16T20:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a prominent selected project identity separate from the dot rail', () => {
    const project = makeProject({
      name: 'baryon',
      root: '/Users/light/Projects/baryon',
      activeBranch: 'develop',
      lightState: 'resumable',
      lightLabel: 'Resumable',
      lastUpdatedAt: '2026-04-16T19:46:00.000Z',
    });
    const html = renderToStaticMarkup(
      <MenubarPopover
        projects={[makeProject({ name: 'parallel' }), project]}
        project={project}
        detail={null}
        session={null}
        summary="Write the initial problem statement."
        stats={buildMenubarStats({ rows: [] })}
        loading={false}
        error={null}
        onSync={() => {}}
        onSelectProject={() => {}}
        onCycleProject={() => {}}
        onOpenDashboard={() => {}}
        onHide={() => {}}
      />,
    );

    expect(html).toContain('menubar-project-identity');
    expect(html).toContain('Viewing project');
    expect(html).toContain('baryon');
    expect(html).toContain('develop');
    expect(html).toContain('2 of 2');
    expect(html).toContain('Updated 14 minutes ago');
    expect(html).toContain('Resumable');
    expect(html).toContain('data-status="resumable"');
    expect(html).toContain('Next');
    expect(html).toContain('Write the initial problem statement.');
    expect(html).toContain('Open dashboard');
    expect(html).not.toContain('>Quit<');
  });
});
