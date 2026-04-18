import type {
  AgentTargetStatus,
  BridgeRuntime,
  CliInstallStatus,
  LoadStatePayload,
  ProjectSummary,
} from './types';

export interface SelectionResolution {
  selectedRoot: string | null;
  selectedProject: ProjectSummary | null;
}

export interface BridgeStatusPresentation {
  tone: 'running' | 'starting' | 'error' | 'stopped';
  label: string;
  detail: string;
}

export interface CliInstallPresentation {
  tone: 'positive' | 'caution';
  label: string;
  detail: string | null;
  needsShellSetup: boolean;
}

export interface AgentDefaultsPresentation {
  tone: 'positive' | 'caution' | 'error';
  label: string;
  detail: string | null;
  canInstall: boolean;
  canUpdate: boolean;
  canReinstall: boolean;
}

export function resolveSelectionState(
  nextState: LoadStatePayload,
  explicitRoot?: string | null,
): SelectionResolution {
  const preferredRoot = explicitRoot ?? nextState.settings.lastFocusedProject ?? null;
  const selectedRoot =
    (preferredRoot &&
    nextState.projects.some((project) => project.root === preferredRoot)
      ? preferredRoot
      : nextState.projects[0]?.root) ?? null;

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

export function describeCliInstallStatus(status: CliInstallStatus | null): CliInstallPresentation {
  if (!status?.installed) {
    return {
      tone: 'caution',
      label: status ? 'Not installed' : 'Checking…',
      detail: null,
      needsShellSetup: false,
    };
  }

  if (status.installDirOnPath) {
    return {
      tone: 'positive',
      label: 'Ready',
      detail: null,
      needsShellSetup: false,
    };
  }

  if (status.shellProfileConfigured) {
    return {
      tone: 'positive',
      label: 'Configured, open a new Terminal',
      detail:
        'Your shell profile already adds this directory. Open a new Terminal window or source the profile if projectctl is still not found.',
      needsShellSetup: false,
    };
  }

  return {
    tone: 'caution',
    label: 'Installed, PATH update needed',
    detail: `Add the install directory to your shell path. Profile: ${status.shellProfile}`,
    needsShellSetup: true,
  };
}

export function describeAgentDefaultsStatus(status: AgentTargetStatus): AgentDefaultsPresentation {
  const detail = describeAgentDefaultsReasons(status.reasons);
  switch (status.status) {
    case 'installed':
      return {
        tone: 'positive',
        label: 'Installed',
        detail,
        canInstall: false,
        canUpdate: false,
        canReinstall: true,
      };
    case 'stale':
      return {
        tone: 'caution',
        label: 'Update needed',
        detail,
        canInstall: false,
        canUpdate: true,
        canReinstall: true,
      };
    case 'error':
      return {
        tone: 'error',
        label: 'Blocked',
        detail,
        canInstall: false,
        canUpdate: false,
        canReinstall: false,
      };
    default:
      return {
        tone: 'caution',
        label: 'Not installed',
        detail,
        canInstall: true,
        canUpdate: false,
        canReinstall: true,
      };
  }
}

function describeAgentDefaultsReasons(reasons: string[]) {
  if (reasons.includes('stable_projectctl_not_installed')) {
    return 'Install the projectctl CLI first so Claude Desktop can use a stable command path.';
  }
  if (reasons.includes('repo_manages_parallel_guidance')) {
    return 'This repo already carries its own Parallel guidance.';
  }
  if (reasons.includes('legacy_local_scope')) {
    return 'A legacy Claude Code local-scope server exists for this repo and should be promoted to user scope.';
  }
  if (reasons.includes('parallel_name_collision')) {
    return 'A differently named server already points at this Parallel endpoint or command.';
  }
  if (reasons.includes('shape_mismatch')) {
    return 'A Parallel entry already exists but does not match the canonical managed shape.';
  }
  if (reasons.includes('managed_block_outdated')) {
    return 'The managed Parallel instruction block is out of date.';
  }
  return reasons[0] ?? null;
}
