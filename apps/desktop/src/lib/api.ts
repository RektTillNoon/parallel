import { invoke, isTauri } from '@tauri-apps/api/core';

import type {
  AgentInstallAction,
  AgentTargetStatus,
  BridgeSnippet,
  BridgeDoctorReport,
  CliInstallStatus,
  LoadStatePayload,
  ProjectDetail,
} from './types';

function ensureTauriRuntime(command: string) {
  if (!isTauri()) {
    throw new Error(`${command} requires the Tauri desktop runtime.`);
  }
}

async function invokeJson<T>(command: string, args?: Record<string, unknown>) {
  ensureTauriRuntime(command);
  const payload = await invoke<string>(command, args);
  if (!payload) {
    throw new Error(`${command} returned no payload`);
  }

  try {
    return JSON.parse(payload) as T;
  } catch (error) {
    throw new Error(
      `${command} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function loadState() {
  return invokeJson<LoadStatePayload>('load_state');
}

export async function refreshProjects() {
  return invokeJson<LoadStatePayload>('refresh_projects');
}

export async function addWatchRoot(root: string) {
  return invokeJson<LoadStatePayload>('add_watch_root', { root });
}

export async function removeWatchRoot(root: string) {
  return invokeJson<LoadStatePayload>('remove_watch_root', { root });
}

export async function setLastFocusedProject(root: string | null) {
  ensureTauriRuntime('set_last_focused_project');
  await invoke('set_last_focused_project', { root });
}

export async function initProject(root: string, name: string) {
  return invokeJson<LoadStatePayload>('init_project', { root, name });
}

export async function startStep(root: string, stepId: string) {
  return invokeJson<ProjectDetail>('start_step_cmd', { root, stepId });
}

export async function completeStep(root: string, stepId: string) {
  return invokeJson<ProjectDetail>('complete_step_cmd', { root, stepId });
}

export async function addBlocker(root: string, blocker: string) {
  return invokeJson<ProjectDetail>('add_blocker_cmd', { root, blocker });
}

export async function clearBlocker(root: string, blocker?: string) {
  return invokeJson<ProjectDetail>('clear_blocker_cmd', { root, blocker });
}

export async function addNote(root: string, note: string) {
  return invokeJson<ProjectDetail>('add_note_cmd', { root, note });
}

export async function proposeDecision(
  root: string,
  payload: { title: string; context: string; decision: string; impact: string },
) {
  return invokeJson<ProjectDetail>('propose_decision_cmd', { root, ...payload });
}

export async function setBridgeEnabled(enabled: boolean) {
  return invokeJson<LoadStatePayload>('set_bridge_enabled', { payload: { enabled } });
}

export async function restartBridge() {
  return invokeJson<LoadStatePayload>('restart_bridge_cmd');
}

export async function getBridgeStatus() {
  return invokeJson<{
    reason: string;
    mcp: LoadStatePayload['settings']['mcp'];
    mcpRuntime: LoadStatePayload['mcpRuntime'];
  }>('get_bridge_status');
}

export async function getBridgeDoctor() {
  return invokeJson<BridgeDoctorReport>('get_bridge_doctor');
}

export async function regenerateBridgeToken() {
  return invokeJson<LoadStatePayload>('regenerate_bridge_token');
}

export async function getBridgeClientSnippets(kind: string, root?: string | null) {
  return invokeJson<BridgeSnippet[]>('get_bridge_client_snippets', { args: { kind, root } });
}

export async function getAgentDefaultsStatus(root?: string | null) {
  return invokeJson<AgentTargetStatus[]>('get_agent_defaults_status', { args: { root } });
}

export async function applyAgentDefaults(
  kind: string,
  action: AgentInstallAction,
  root?: string | null,
) {
  return invokeJson<AgentTargetStatus>('apply_agent_defaults_cmd', {
    args: { kind, action, root },
  });
}

export async function getCliInstallStatus() {
  return invokeJson<CliInstallStatus>('get_cli_install_status');
}

export async function installCli() {
  return invokeJson<CliInstallStatus>('install_cli_cmd');
}
