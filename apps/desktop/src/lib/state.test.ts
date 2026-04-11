import { describe, expect, it } from 'vitest';

import type { LoadStatePayload } from './types';
import { resolveSelectionState } from './state';

const baseState: LoadStatePayload = {
  settings: {
    watchedRoots: ['/Users/light/Projects'],
    lastFocusedProject: null,
  },
  projects: [
    {
      id: null,
      name: 'baryon',
      root: '/Users/light/Projects/baryon',
      kind: null,
      owner: null,
      tags: [],
      initialized: false,
      status: 'uninitialized',
      stale: false,
      missing: false,
      currentStepId: null,
      currentStepTitle: null,
      blockerCount: 0,
      lastUpdatedAt: null,
      nextAction: 'Initialize workflow metadata',
      activeBranch: 'main',
      pendingProposalCount: 0,
    },
  ],
};

describe('resolveSelectionState', () => {
  it('does not request detail for an auto-selected uninitialized repo', () => {
    const result = resolveSelectionState(baseState);

    expect(result.selectedRoot).toBe('/Users/light/Projects/baryon');
    expect(result.selectedProject?.initialized).toBe(false);
    expect(result.shouldLoadDetail).toBe(false);
  });

  it('requests detail for an initialized selected repo', () => {
    const initializedState: LoadStatePayload = {
      ...baseState,
      projects: [
        {
          ...baseState.projects[0],
          initialized: true,
          status: 'todo',
        },
      ],
    };

    const result = resolveSelectionState(initializedState);
    expect(result.shouldLoadDetail).toBe(true);
  });
});
