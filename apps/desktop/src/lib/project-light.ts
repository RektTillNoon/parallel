import type { BoardProjectDetail, ProjectSummary } from './types';

export type ProjectLightState = 'live' | 'resumable' | 'blocked' | 'done' | 'uninitialized';
export type ProjectSummaryWithLight = ProjectSummary & {
  lightState: ProjectLightState;
  lightLabel: string;
};

export function projectLightLabel(state: ProjectLightState) {
  switch (state) {
    case 'live':
      return 'Live work';
    case 'resumable':
      return 'Resumable';
    case 'blocked':
      return 'Blocked';
    case 'done':
      return 'Done';
    case 'uninitialized':
      return 'Uninitialized';
  }
}

export function deriveProjectLightState(
  project: ProjectSummary,
  boardProject?: BoardProjectDetail | null,
): ProjectLightState {
  if (!project.initialized || project.status === 'uninitialized') {
    return 'uninitialized';
  }

  if (boardProject?.blockers.length || project.status === 'blocked') {
    return 'blocked';
  }

  if (project.status === 'done') {
    return 'done';
  }

  const currentStepId = project.currentStepId;
  const ownsCurrentStep = Boolean(
    currentStepId &&
      boardProject?.sessions.some(
        (session) => session.status === 'active' && session.owned_step_id === currentStepId,
      ),
  );

  return ownsCurrentStep ? 'live' : 'resumable';
}
