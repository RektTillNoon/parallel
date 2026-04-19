import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ProjectSwitcher, { compactDuration, sortProjectsByRecency } from './ProjectSwitcher';
import type { ProjectSummary } from '../lib/types';
import type { ProjectLightState } from '../lib/project-light';

type SwitcherProject = ProjectSummary & {
  lightState: ProjectLightState;
  lightLabel: string;
};

function makeProject(overrides: Partial<SwitcherProject>): SwitcherProject {
  return {
    id: null,
    name: 'project',
    root: '/tmp/project',
    kind: null,
    owner: null,
    tags: [],
    initialized: true,
    status: 'todo',
    stale: false,
    missing: false,
    currentStepId: null,
    currentStepTitle: null,
    blockerCount: 0,
    totalStepCount: 0,
    completedStepCount: 0,
    activeSessionCount: 0,
    focusSessionId: null,
    lastUpdatedAt: null,
    nextAction: null,
    activeBranch: null,
    pendingProposalCount: 0,
    discoverySource: 'parallel',
    discoveryPath: null,
    lightState: 'resumable',
    lightLabel: 'Resumable',
    ...overrides,
  };
}

describe('sortProjectsByRecency', () => {
  it('orders projects with the most recently touched first', () => {
    const projects = [
      makeProject({ name: 'stale', root: '/a', lastUpdatedAt: '2026-04-16T19:00:00Z' }),
      makeProject({ name: 'fresh', root: '/b', lastUpdatedAt: '2026-04-16T19:58:00Z' }),
      makeProject({ name: 'untouched', root: '/c', lastUpdatedAt: null }),
    ];

    expect(sortProjectsByRecency(projects).map((project) => project.name)).toEqual([
      'fresh',
      'stale',
      'untouched',
    ]);
  });
});

describe('compactDuration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-16T20:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders minute, hour, day, and dashed fallbacks', () => {
    expect(compactDuration('2026-04-16T19:46:00Z')).toBe('14m');
    expect(compactDuration('2026-04-16T17:00:00Z')).toBe('3h');
    expect(compactDuration('2026-04-14T20:00:00Z')).toBe('2d');
    expect(compactDuration(null)).toBe('—');
  });
});

describe('ProjectSwitcher', () => {
  it('renders minimal project rows with name, status dot, and relative time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-16T20:00:00Z'));

    const html = renderToStaticMarkup(
      <ProjectSwitcher
        projects={[
          makeProject({
            name: 'trading',
            root: '/Users/light/Projects/trading',
            status: 'in_progress',
            lightState: 'live',
            lightLabel: 'Live work',
            lastUpdatedAt: '2026-04-16T19:46:00Z',
          }),
        ]}
        selectedRoot="/Users/light/Projects/trading"
        onSelectProject={() => {}}
        onOpenSettings={() => {}}
        settingsOpen={false}
      />,
    );

    expect(html).toContain('trading');
    expect(html).toContain('14m');
    expect(html).toContain('data-status="live"');
    expect(html).toContain('aria-label="trading, Live work"');
    expect(html).toContain('title="trading, Live work"');
    expect(html).toContain('is-selected');
    expect(html).toContain('Settings');
    expect(html).not.toContain('switcher-compact-shell');
    expect(html).not.toContain('switcher-compact-select');
    expect(html).not.toContain('6H TOUCH');

    vi.useRealTimers();
  });

  it('renders projects in recency order even when the input array is unsorted', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-16T20:00:00Z'));

    const html = renderToStaticMarkup(
      <ProjectSwitcher
        projects={[
          makeProject({
            name: 'stale',
            root: '/Users/light/Projects/stale',
            status: 'todo',
            lastUpdatedAt: '2026-04-16T19:00:00Z',
          }),
          makeProject({
            name: 'fresh',
            root: '/Users/light/Projects/fresh',
            status: 'in_progress',
            lightState: 'live',
            lightLabel: 'Live work',
            lastUpdatedAt: '2026-04-16T19:58:00Z',
          }),
        ]}
        selectedRoot="/Users/light/Projects/fresh"
        onSelectProject={() => {}}
        onOpenSettings={() => {}}
        settingsOpen={false}
      />,
    );

    expect(html.indexOf('fresh')).toBeLessThan(html.indexOf('stale'));

    vi.useRealTimers();
  });
});
