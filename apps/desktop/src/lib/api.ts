import { invoke } from '@tauri-apps/api/core';

import type { LoadStatePayload, ProjectDetail } from './types';

async function invokeJson<T>(command: string, args?: Record<string, unknown>) {
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
  return invokeJson<LoadStatePayload>('set_last_focused_project', { root });
}

export async function getProject(root: string) {
  return invokeJson<ProjectDetail>('get_project', { root });
}

export async function initProject(root: string, name: string) {
  return invokeJson<ProjectDetail>('init_project', { root, name });
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
