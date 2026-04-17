use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    #[default]
    Todo,
    InProgress,
    Blocked,
    Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SubtaskStatus {
    #[default]
    Todo,
    Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    #[default]
    Active,
    Paused,
    Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivitySource {
    Cli,
    Mcp,
    Desktop,
    Agent,
    Human,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Manifest {
    #[serde(default = "default_manifest_version")]
    pub version: u32,
    pub id: String,
    pub name: String,
    pub root: String,
    pub kind: String,
    pub owner: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Subtask {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub status: SubtaskStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Step {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub status: StepStatus,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub details: Vec<String>,
    #[serde(default)]
    pub subtasks: Vec<Subtask>,
    #[serde(default)]
    pub owner_session_id: Option<String>,
    #[serde(default)]
    pub completed_at: Option<String>,
    #[serde(default)]
    pub completed_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Phase {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub steps: Vec<Step>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Plan {
    #[serde(default = "default_plan_version")]
    pub version: u32,
    pub phases: Vec<Phase>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeState {
    #[serde(default = "default_runtime_version")]
    pub version: u32,
    #[serde(default)]
    pub current_phase_id: Option<String>,
    #[serde(default)]
    pub current_step_id: Option<String>,
    #[serde(default)]
    pub focus_session_id: Option<String>,
    pub next_action: String,
    pub status: StepStatus,
    #[serde(default)]
    pub blockers: Vec<String>,
    pub last_updated_at: String,
    #[serde(default)]
    pub active_branch: Option<String>,
    #[serde(default)]
    pub active_session_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkflowSession {
    pub id: String,
    #[serde(default)]
    pub title: String,
    pub actor: String,
    pub source: ActivitySource,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub status: SessionStatus,
    #[serde(default)]
    pub owned_step_id: Option<String>,
    #[serde(default)]
    pub observed_step_ids: Vec<String>,
    pub started_at: String,
    pub last_updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionsFile {
    #[serde(default = "default_sessions_version")]
    pub version: u32,
    #[serde(default)]
    pub sessions: Vec<WorkflowSession>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ActivityEvent {
    pub timestamp: String,
    pub actor: String,
    pub source: ActivitySource,
    pub project_id: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub step_id: Option<String>,
    #[serde(default)]
    pub subtask_id: Option<String>,
    #[serde(rename = "type")]
    pub event_type: String,
    pub summary: String,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DecisionProposal {
    pub id: String,
    pub proposed_at: String,
    pub proposed_by: String,
    pub title: String,
    #[serde(default)]
    pub context: String,
    #[serde(default)]
    pub decision: String,
    #[serde(default)]
    pub impact: String,
    pub status: DecisionProposalStatus,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DecisionProposalStatus {
    Proposed,
    Accepted,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DecisionProposalsFile {
    #[serde(default = "default_decisions_version")]
    pub version: u32,
    #[serde(default)]
    pub proposals: Vec<DecisionProposal>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AcceptedDecision {
    pub date: String,
    pub title: String,
    pub context: String,
    pub decision: String,
    pub impact: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: Option<String>,
    pub name: String,
    pub root: String,
    pub kind: Option<String>,
    pub owner: Option<String>,
    pub tags: Vec<String>,
    pub initialized: bool,
    pub status: String,
    pub stale: bool,
    pub missing: bool,
    pub current_step_id: Option<String>,
    pub current_step_title: Option<String>,
    pub blocker_count: i64,
    pub total_step_count: i64,
    pub completed_step_count: i64,
    pub active_session_count: i64,
    pub focus_session_id: Option<String>,
    pub last_updated_at: Option<String>,
    pub next_action: Option<String>,
    pub active_branch: Option<String>,
    pub pending_proposal_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectIndexRecord {
    #[serde(flatten)]
    pub summary: ProjectSummary,
    pub watched_root: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BoardStepDetail {
    pub title: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoardProjectDetail {
    pub root: String,
    pub sessions: Vec<WorkflowSession>,
    pub runtime_next_action: String,
    pub blockers: Vec<String>,
    pub recent_activity: Vec<ActivityEvent>,
    pub active_step_lookup: BTreeMap<String, BoardStepDetail>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDetail {
    pub manifest: Manifest,
    pub plan: Plan,
    pub runtime: RuntimeState,
    pub sessions: Vec<WorkflowSession>,
    pub recent_activity: Vec<ActivityEvent>,
    pub blockers: Vec<String>,
    pub pending_proposals: Vec<DecisionProposal>,
    pub handoff: String,
    pub decisions: Vec<AcceptedDecision>,
}

#[derive(Debug, Clone)]
pub struct MutationActor {
    pub actor: String,
    pub source: ActivitySource,
}

#[derive(Debug, Clone, Default)]
pub struct SessionContextInput {
    pub session_id: Option<String>,
    pub session_title: Option<String>,
    pub branch: Option<String>,
}

#[derive(Debug, Clone)]
pub struct InitProjectInput {
    pub root: String,
    pub actor: String,
    pub source: ActivitySource,
    pub name: Option<String>,
    pub kind: Option<String>,
    pub owner: Option<String>,
    pub tags: Option<Vec<String>>,
    pub index_db_path: Option<String>,
}

#[derive(Debug, Clone)]
pub struct EnsureSessionInput {
    pub root: String,
    pub actor: String,
    pub source: ActivitySource,
    pub session_id: Option<String>,
    pub session_title: Option<String>,
    pub branch: Option<String>,
    pub index_db_path: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RuntimePatchInput {
    pub root: String,
    pub actor: String,
    pub source: ActivitySource,
    pub patch: Map<String, Value>,
    pub summary: String,
    pub event_type: Option<String>,
    pub index_db_path: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AppendActivityInput {
    pub actor: String,
    pub source: ActivitySource,
    pub session_id: Option<String>,
    pub session_title: Option<String>,
    pub branch: Option<String>,
    pub event_type: String,
    pub summary: String,
    pub payload: Option<Value>,
    pub step_id: Option<String>,
    pub subtask_id: Option<String>,
    pub index_db_path: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PlanSyncSubtaskInput {
    pub id: Option<String>,
    pub title: String,
    pub status: Option<SubtaskStatus>,
}

#[derive(Debug, Clone)]
pub struct PlanSyncStepInput {
    pub id: Option<String>,
    pub title: String,
    pub summary: Option<String>,
    pub details: Option<Vec<String>>,
    pub depends_on: Option<Vec<String>>,
    pub subtasks: Option<Vec<PlanSyncSubtaskInput>>,
}

#[derive(Debug, Clone)]
pub struct PlanSyncPhaseInput {
    pub id: Option<String>,
    pub title: String,
    pub steps: Vec<PlanSyncStepInput>,
}

#[derive(Debug, Clone)]
pub struct SyncPlanInput {
    pub root: String,
    pub actor: String,
    pub source: ActivitySource,
    pub session_id: Option<String>,
    pub session_title: Option<String>,
    pub branch: Option<String>,
    pub phases: Vec<PlanSyncPhaseInput>,
    pub index_db_path: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DecisionProposalInput {
    pub title: String,
    pub context: String,
    pub decision: String,
    pub impact: String,
}

pub fn default_manifest_version() -> u32 {
    1
}

pub fn default_plan_version() -> u32 {
    2
}

pub fn default_runtime_version() -> u32 {
    2
}

pub fn default_sessions_version() -> u32 {
    1
}

pub fn default_decisions_version() -> u32 {
    1
}
