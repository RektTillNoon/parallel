import type { LoadStatePayload, ProjectSummary } from './types';

export interface SelectionResolution {
  selectedRoot: string | null;
  selectedProject: ProjectSummary | null;
  shouldLoadDetail: boolean;
}

export function resolveSelectionState(
  nextState: LoadStatePayload,
  explicitRoot?: string | null,
): SelectionResolution {
  const selectedRoot =
    explicitRoot ??
    nextState.settings.lastFocusedProject ??
    nextState.projects[0]?.root ??
    null;

  const selectedProject =
    selectedRoot ? nextState.projects.find((project) => project.root === selectedRoot) ?? null : null;

  return {
    selectedRoot,
    selectedProject,
    shouldLoadDetail: Boolean(selectedRoot && selectedProject?.initialized),
  };
}
