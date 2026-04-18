mod decisions;
mod discovery;
mod handoff;
mod index_path;
mod index_store;
mod models;
mod read_model;
mod resolver;
mod root_paths;
mod services;
mod storage_yaml;

pub use index_path::{canonical_index_db_path, canonical_settings_path, CANONICAL_INDEX_DB_FILE};
pub use models::{
    AcceptedDecision, ActivityEvent, ActivitySource, AppendActivityInput, BoardProjectDetail,
    BoardStepDetail, DecisionProposal, DecisionProposalInput, DecisionProposalStatus,
    EnsureSessionInput, InitProjectInput, Manifest, MutationActor, Phase, Plan, PlanSyncPhaseInput,
    PlanSyncStepInput, PlanSyncSubtaskInput, ProjectDetail, ProjectSummary, RuntimePatchInput,
    RuntimeState, SessionContextInput, SessionStatus, SessionsFile, Step, StepStatus, Subtask,
    SubtaskStatus, SyncPlanInput, WorkflowSession,
};
pub use read_model::{
    board_project_detail as get_board_project_detail, list_indexed_projects, list_projects,
};
pub use resolver::{
    migrate_legacy_watched_roots, resolve_index_db_path, resolve_watched_roots,
    RootResolutionSurface,
};
pub use services::{
    accept_decision, add_blocker, add_note, add_watched_root_index_state, append_activity_event,
    clear_blocker, complete_step, ensure_session, get_project, init_project, list_watched_roots,
    missing_watched_root_coverage, propose_decision, refresh_handoff,
    remove_watched_root_index_state, start_step, sync_plan, update_runtime,
};
