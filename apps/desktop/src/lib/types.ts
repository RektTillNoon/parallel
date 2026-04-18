export interface SettingsPayload {
  watchedRoots: string[];
  lastFocusedProject: string | null;
  mcp: BridgeSettings;
}

export interface BridgeSettings {
  enabled: boolean;
  port: number;
  token: string;
}

export interface BridgeRuntime {
  status: string;
  boundPort: number | null;
  pid: number | null;
  startedAt: string | null;
  lastError: string | null;
  setupStale: boolean;
  staleReasons: string[];
  staleClients: string[];
}

export interface BridgeSnippet {
  kind: string;
  label: string;
  content: string;
  copyLabel: string;
  notes: string;
  stale: boolean;
}

export interface BridgeStateEvent {
  reason: string;
  mcp: BridgeSettings;
  mcpRuntime: BridgeRuntime;
}

export interface CliInstallStatus {
  bundledPath: string;
  installPath: string;
  installed: boolean;
  installDirOnPath: boolean;
  shellProfileConfigured: boolean;
  shellExport: string;
  shellProfile: string;
  persistCommand: string;
}

export interface ProjectSummary {
  id: string | null;
  name: string;
  root: string;
  kind: string | null;
  owner: string | null;
  tags: string[];
  initialized: boolean;
  status: string;
  stale: boolean;
  missing: boolean;
  currentStepId: string | null;
  currentStepTitle: string | null;
  blockerCount: number;
  totalStepCount: number;
  completedStepCount: number;
  activeSessionCount: number;
  focusSessionId: string | null;
  lastUpdatedAt: string | null;
  nextAction: string | null;
  activeBranch: string | null;
  pendingProposalCount: number;
  discoverySource: 'parallel' | 'codex' | 'claude' | null;
  discoveryPath: string | null;
}

export interface Manifest {
  id: string;
  name: string;
  root: string;
  kind: string;
  owner: string;
  tags: string[];
  created_at: string;
}

export interface Subtask {
  id: string;
  title: string;
  status: 'todo' | 'done';
}

export interface Step {
  id: string;
  title: string;
  summary: string;
  status: 'todo' | 'in_progress' | 'blocked' | 'done';
  depends_on: string[];
  details: string[];
  subtasks: Subtask[];
  owner_session_id: string | null;
  completed_at: string | null;
  completed_by: string | null;
}

export interface Phase {
  id: string;
  title: string;
  steps: Step[];
}

export interface RuntimeState {
  current_phase_id: string | null;
  current_step_id: string | null;
  focus_session_id: string | null;
  next_action: string;
  status: string;
  blockers: string[];
  last_updated_at: string;
  active_branch: string | null;
  active_session_ids: string[];
}

export interface WorkflowSession {
  id: string;
  title: string;
  actor: string;
  source: 'cli' | 'mcp' | 'desktop' | 'agent' | 'human' | 'system';
  branch: string | null;
  status: 'active' | 'paused' | 'done';
  owned_step_id: string | null;
  observed_step_ids: string[];
  started_at: string;
  last_updated_at: string;
}

export interface ActivityEvent {
  timestamp: string;
  actor: string;
  source: 'cli' | 'mcp' | 'desktop' | 'agent' | 'human' | 'system';
  project_id: string;
  session_id: string | null;
  step_id: string | null;
  subtask_id: string | null;
  type: string;
  summary: string;
  payload: Record<string, unknown>;
}

export interface DecisionProposal {
  id: string;
  proposed_at: string;
  proposed_by: string;
  title: string;
  context: string;
  decision: string;
  impact: string;
  status: 'proposed' | 'accepted' | 'rejected';
}

export interface AcceptedDecision {
  date: string;
  title: string;
  context: string;
  decision: string;
  impact: string;
}

export interface ProjectDetail {
  manifest: Manifest;
  plan: {
    phases: Phase[];
  };
  runtime: RuntimeState;
  sessions: WorkflowSession[];
  recentActivity: ActivityEvent[];
  blockers: string[];
  pendingProposals: DecisionProposal[];
  handoff: string;
  decisions: AcceptedDecision[];
}

export interface BoardStepDetail {
  title: string;
  summary: string;
}

export interface BoardProjectDetail {
  root: string;
  sessions: WorkflowSession[];
  runtimeNextAction: string;
  blockers: string[];
  recentActivity: ActivityEvent[];
  activeStepLookup: Record<string, BoardStepDetail>;
}

export interface LoadStatePayload {
  settings: SettingsPayload;
  projects: ProjectSummary[];
  boardProjects: BoardProjectDetail[];
  mcpRuntime: BridgeRuntime;
}
