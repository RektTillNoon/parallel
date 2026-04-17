import type { BridgeRuntime, LoadStatePayload, ProjectSummary } from './types';

export interface SelectionResolution {
  selectedRoot: string | null;
  selectedProject: ProjectSummary | null;
}

export interface BridgeStatusPresentation {
  tone: 'running' | 'starting' | 'error' | 'stopped';
  label: string;
  detail: string;
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
  };
}

export function shouldReconcileBridgeStatus(state: LoadStatePayload | null) {
  return Boolean(state?.settings.mcp.enabled && state.mcpRuntime.status === 'starting');
}

export async function runBootstrapTasks(
  registerListeners: () => Promise<void>,
  loadInitialState: () => Promise<void>,
) {
  const listenerRegistration = registerListeners();
  await loadInitialState();
  await listenerRegistration;
}

export function describeBridgeStatus(
  runtime: BridgeRuntime,
  enabled: boolean,
): BridgeStatusPresentation {
  switch (runtime.status) {
    case 'running':
      return {
        tone: 'running',
        label: 'Ready',
        detail: 'Accepting local MCP requests on localhost.',
      };
    case 'starting':
      return {
        tone: 'starting',
        label: 'Starting',
        detail: 'Waiting for the local bridge to confirm readiness.',
      };
    case 'error':
      return {
        tone: 'error',
        label: 'Error',
        detail: 'The bridge failed to start cleanly. Review the error below.',
      };
    default:
      return {
        tone: 'stopped',
        label: enabled ? 'Stopped' : 'Off',
        detail: enabled
          ? 'The bridge is enabled but not accepting requests right now.'
          : 'Turn this on to expose the local MCP bridge.',
      };
  }
}
