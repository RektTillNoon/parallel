use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::decisions::{build_accepted_decision_markdown, parse_accepted_decisions};
use crate::handoff::{generate_handoff, HandoffInput};
use crate::index_store::IndexStore;
use crate::models::{
    AcceptedDecision, ActivityEvent, ActivitySource, AppendActivityInput, DecisionProposal,
    DecisionProposalInput, DecisionProposalStatus, DecisionProposalsFile, EnsureSessionInput,
    InitProjectInput, Manifest, MutationActor, Phase, Plan, PlanSyncPhaseInput, ProjectDetail,
    ProjectIndexRecord, ProjectSummary, RuntimePatchInput, RuntimeState, SessionContextInput,
    SessionStatus, SessionsFile, Step, StepStatus, Subtask, SubtaskStatus, SyncPlanInput,
    WorkflowSession,
};
use crate::root_paths::{canonicalize_root, most_specific_watched_root, normalize_roots};
use crate::storage_yaml::{
    append_json_line, ensure_dir, get_workflow_paths, now_iso, path_exists, read_git_branch,
    read_json_lines, read_text_if_exists, read_yaml_file, slugify, with_project_lock,
    write_text_atomic, write_yaml_atomic,
};

fn create_default_plan() -> Plan {
    Plan {
        version: 2,
        phases: vec![Phase {
            id: "define".to_string(),
            title: "Define".to_string(),
            steps: vec![Step {
                id: "capture-requirements".to_string(),
                title: "Capture requirements".to_string(),
                summary: "Write the initial problem statement and success criteria.".to_string(),
                details: vec![
                    "Write the initial problem statement and success criteria.".to_string()
                ],
                depends_on: Vec::new(),
                subtasks: Vec::new(),
                status: StepStatus::Todo,
                owner_session_id: None,
                completed_at: None,
                completed_by: None,
            }],
        }],
    }
}

fn create_default_manifest(root: &str, input: &InitProjectInput, timestamp: &str) -> Manifest {
    let name = input.name.clone().unwrap_or_else(|| {
        Path::new(root)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("project")
            .to_string()
    });
    Manifest {
        version: 1,
        id: format!("{}-{}", slugify(&name), &Uuid::new_v4().to_string()[..8]),
        name,
        root: root.to_string(),
        kind: input.kind.clone().unwrap_or_else(|| "software".to_string()),
        owner: input.owner.clone().unwrap_or_else(|| input.actor.clone()),
        tags: input.tags.clone().unwrap_or_default(),
        created_at: timestamp.to_string(),
    }
}

fn get_all_steps(plan: &Plan) -> Vec<&Step> {
    plan.phases
        .iter()
        .flat_map(|phase| phase.steps.iter())
        .collect()
}

pub(crate) fn get_plan_progress(plan: &Plan) -> (i64, i64) {
    let steps = get_all_steps(plan);
    let total = steps.len() as i64;
    let completed = steps
        .iter()
        .filter(|step| step.status == StepStatus::Done)
        .count() as i64;
    (total, completed)
}

pub fn find_current_step_title(plan: &Plan, current_step_id: Option<&str>) -> Option<String> {
    current_step_id
        .and_then(|step_id| locate_step(plan, step_id).map(|(_, _, _, step)| step.title.clone()))
}

fn create_default_runtime(
    plan: &Plan,
    active_branch: Option<String>,
    timestamp: &str,
) -> RuntimeState {
    let first_step = get_next_actionable_step(plan);
    RuntimeState {
        version: 2,
        current_phase_id: first_step
            .as_ref()
            .map(|(phase_index, _, _, _)| plan.phases[*phase_index].id.clone()),
        current_step_id: first_step.as_ref().map(|(_, _, _, step)| step.id.clone()),
        focus_session_id: None,
        next_action: first_step
            .as_ref()
            .map(|(_, _, _, step)| format!("Start \"{}\"", step.title))
            .unwrap_or_else(|| "Add the first project step".to_string()),
        status: if first_step.is_some() {
            StepStatus::Todo
        } else {
            StepStatus::Done
        },
        blockers: Vec::new(),
        last_updated_at: timestamp.to_string(),
        active_branch,
        active_session_ids: Vec::new(),
    }
}

fn blank_sessions_file() -> SessionsFile {
    SessionsFile {
        version: 1,
        sessions: Vec::new(),
    }
}

fn read_manifest(root: &str) -> Result<Manifest> {
    read_yaml_file(get_workflow_paths(root).manifest_path)
}

fn read_plan(root: &str) -> Result<Plan> {
    let plan: Plan = read_yaml_file(get_workflow_paths(root).plan_path)?;
    validate_plan(&plan)?;
    Ok(plan)
}

fn read_runtime(root: &str) -> Result<RuntimeState> {
    read_yaml_file(get_workflow_paths(root).runtime_path)
}

fn read_sessions(root: &str) -> Result<SessionsFile> {
    let paths = get_workflow_paths(root);
    if !path_exists(&paths.sessions_path) {
        return Ok(blank_sessions_file());
    }
    read_yaml_file(paths.sessions_path)
}

fn read_pending_proposals(root: &str) -> Result<DecisionProposalsFile> {
    read_yaml_file(get_workflow_paths(root).proposed_decisions_path)
}

fn read_activity(root: &str) -> Result<Vec<ActivityEvent>> {
    read_json_lines(get_workflow_paths(root).activity_path)?
        .into_iter()
        .map(serde_json::from_value)
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

fn append_activity(root: &str, event: &ActivityEvent) -> Result<()> {
    append_json_line(
        get_workflow_paths(root).activity_path,
        &serde_json::to_value(event)?,
    )
}

fn read_decisions_markdown(root: &str) -> Result<String> {
    Ok(
        read_text_if_exists(get_workflow_paths(root).decisions_path)?
            .unwrap_or_else(|| "# Accepted Decisions\n".to_string()),
    )
}

fn ensure_project_files(root: &str, actor: &MutationActor) -> Result<()> {
    let paths = get_workflow_paths(root);
    ensure_dir(&paths.local_dir)?;

    if !path_exists(&paths.proposed_decisions_path) {
        write_yaml_atomic(
            &paths.proposed_decisions_path,
            &DecisionProposalsFile {
                version: 1,
                proposals: Vec::new(),
            },
        )?;
    }

    if !path_exists(&paths.sessions_path) {
        write_yaml_atomic(&paths.sessions_path, &blank_sessions_file())?;
    }

    if !path_exists(&paths.activity_path) {
        let event = ActivityEvent {
            timestamp: now_iso(),
            actor: actor.actor.clone(),
            source: actor.source,
            project_id: "pending-init".to_string(),
            session_id: None,
            step_id: None,
            subtask_id: None,
            event_type: "system.bootstrap".to_string(),
            summary: "Created workflow activity log".to_string(),
            payload: json!({}),
        };
        append_activity(root, &event)?;
    }

    Ok(())
}

fn ensure_gitignore_entry(root: &str) -> Result<()> {
    let gitignore_path = Path::new(root).join(".gitignore");
    let entry = ".project-workflow/local/";
    let current = read_text_if_exists(&gitignore_path)?.unwrap_or_default();
    if current.contains(entry) {
        return Ok(());
    }
    let next_body = if current.is_empty() || current.ends_with('\n') {
        current
    } else {
        format!("{current}\n")
    };
    write_text_atomic(gitignore_path, &format!("{next_body}{entry}\n"))
}

pub(crate) fn determine_project_stale(runtime: Option<&RuntimeState>, repo_exists: bool) -> bool {
    if !repo_exists {
        return true;
    }
    let Some(runtime) = runtime else {
        return false;
    };
    let parsed = chrono::DateTime::parse_from_rfc3339(&runtime.last_updated_at);
    let Ok(last_updated) = parsed else {
        return false;
    };
    let age = chrono::Utc::now().signed_duration_since(last_updated.with_timezone(&chrono::Utc));
    age >= chrono::Duration::days(7)
}

fn active_session_ids(sessions: &[WorkflowSession]) -> Vec<String> {
    sessions
        .iter()
        .filter(|session| session.status == SessionStatus::Active)
        .map(|session| session.id.clone())
        .collect()
}

fn human_override_allowed(source: ActivitySource) -> bool {
    matches!(source, ActivitySource::Human | ActivitySource::Desktop)
}

pub(crate) fn locate_step<'a>(
    plan: &'a Plan,
    step_id: &str,
) -> Option<(usize, usize, &'a Phase, &'a Step)> {
    for (phase_index, phase) in plan.phases.iter().enumerate() {
        for (step_index, step) in phase.steps.iter().enumerate() {
            if step.id == step_id {
                return Some((phase_index, step_index, phase, step));
            }
        }
    }
    None
}

fn locate_step_indices(plan: &Plan, step_id: &str) -> Option<(usize, usize)> {
    for (phase_index, phase) in plan.phases.iter().enumerate() {
        for (step_index, step) in phase.steps.iter().enumerate() {
            if step.id == step_id {
                return Some((phase_index, step_index));
            }
        }
    }
    None
}

fn get_next_actionable_step(plan: &Plan) -> Option<(usize, usize, &Phase, &Step)> {
    let all_steps = get_all_steps(plan);
    for (phase_index, phase) in plan.phases.iter().enumerate() {
        for (step_index, step) in phase.steps.iter().enumerate() {
            if step.status == StepStatus::Done {
                continue;
            }
            let dependencies_met = step.depends_on.iter().all(|dependency| {
                all_steps
                    .iter()
                    .find(|candidate| candidate.id == *dependency)
                    .map(|candidate| candidate.status == StepStatus::Done)
                    .unwrap_or(false)
            });
            if dependencies_met {
                return Some((phase_index, step_index, phase, step));
            }
        }
    }
    None
}

fn normalize_plan_in_progress_states(plan: &mut Plan, active_step_id: Option<&str>) {
    for phase in &mut plan.phases {
        for step in &mut phase.steps {
            if active_step_id == Some(step.id.as_str()) {
                continue;
            }
            if matches!(step.status, StepStatus::InProgress | StepStatus::Blocked) {
                step.status = if step.completed_at.is_some() {
                    StepStatus::Done
                } else {
                    StepStatus::Todo
                };
            }
            if step.owner_session_id.is_some() && active_step_id != Some(step.id.as_str()) {
                step.owner_session_id = None;
            }
        }
    }
}

fn reconcile_sessions_and_plan(plan: &mut Plan, sessions: &mut SessionsFile) {
    let step_ids: HashSet<String> = get_all_steps(plan)
        .iter()
        .map(|step| step.id.clone())
        .collect();
    let session_ids: HashSet<String> = sessions
        .sessions
        .iter()
        .map(|session| session.id.clone())
        .collect();

    for session in &mut sessions.sessions {
        if let Some(owned_step_id) = &session.owned_step_id {
            if !step_ids.contains(owned_step_id) {
                session.owned_step_id = None;
            }
        }
        session
            .observed_step_ids
            .retain(|step_id| step_ids.contains(step_id));
    }

    for phase in &mut plan.phases {
        for step in &mut phase.steps {
            if let Some(owner_session_id) = &step.owner_session_id {
                if !session_ids.contains(owner_session_id) {
                    step.owner_session_id = None;
                }
            }
        }
    }
}

fn refresh_runtime_state(
    plan: &mut Plan,
    runtime: &RuntimeState,
    sessions: &mut SessionsFile,
    active_branch: Option<String>,
    now: &str,
) -> RuntimeState {
    reconcile_sessions_and_plan(plan, sessions);

    let current = runtime
        .current_step_id
        .as_deref()
        .and_then(|step_id| locate_step(plan, step_id))
        .filter(|(_, _, _, step)| step.status != StepStatus::Done)
        .or_else(|| get_next_actionable_step(plan));

    let focus_session_id = current
        .as_ref()
        .and_then(|(_, _, _, step)| step.owner_session_id.clone())
        .or_else(|| {
            runtime.focus_session_id.clone().filter(|session_id| {
                sessions
                    .sessions
                    .iter()
                    .any(|session| session.id == *session_id)
            })
        });

    let status = if !runtime.blockers.is_empty() {
        StepStatus::Blocked
    } else {
        current
            .as_ref()
            .map(|(_, _, _, step)| step.status)
            .unwrap_or(StepStatus::Done)
    };

    let next_action = if let Some((_, _, _, step)) = &current {
        if step.owner_session_id.is_some() {
            if !step.summary.is_empty() {
                step.summary.clone()
            } else if let Some(detail) = step.details.first() {
                detail.clone()
            } else {
                format!("Continue \"{}\"", step.title)
            }
        } else {
            format!("Start \"{}\"", step.title)
        }
    } else {
        "No remaining steps".to_string()
    };

    RuntimeState {
        version: 2,
        current_phase_id: current.as_ref().map(|(_, _, phase, _)| phase.id.clone()),
        current_step_id: current.as_ref().map(|(_, _, _, step)| step.id.clone()),
        focus_session_id,
        next_action,
        status,
        blockers: runtime.blockers.clone(),
        last_updated_at: now.to_string(),
        active_branch,
        active_session_ids: active_session_ids(&sessions.sessions),
    }
}

fn build_initialized_project_summary(root: &str) -> Result<ProjectSummary> {
    let manifest = read_manifest(root)?;
    let plan = read_plan(root)?;
    let runtime = read_runtime(root)?;
    let proposals = read_pending_proposals(root)?;
    let sessions = read_sessions(root)?;
    let repo_exists = path_exists(root);
    let located = runtime
        .current_step_id
        .as_deref()
        .and_then(|step_id| locate_step(&plan, step_id))
        .map(|(_, _, _, step)| step.title.clone());
    let (total, completed) = get_plan_progress(&plan);

    Ok(ProjectSummary {
        id: Some(manifest.id),
        name: manifest.name,
        root: root.to_string(),
        kind: Some(manifest.kind),
        owner: Some(manifest.owner),
        tags: manifest.tags,
        initialized: true,
        status: format!("{:?}", runtime.status)
            .to_lowercase()
            .replace("stepstatus::", ""),
        stale: determine_project_stale(Some(&runtime), repo_exists),
        missing: !repo_exists,
        current_step_id: runtime.current_step_id.clone(),
        current_step_title: located,
        blocker_count: runtime.blockers.len() as i64,
        total_step_count: total,
        completed_step_count: completed,
        active_session_count: sessions
            .sessions
            .iter()
            .filter(|session| session.status == SessionStatus::Active)
            .count() as i64,
        focus_session_id: runtime.focus_session_id.clone(),
        last_updated_at: Some(runtime.last_updated_at.clone()),
        next_action: Some(runtime.next_action.clone()),
        active_branch: runtime.active_branch.clone(),
        pending_proposal_count: proposals.proposals.len() as i64,
        last_seen_at: Some(now_iso()),
    })
}

fn build_uninitialized_project_summary(root: &str) -> Result<ProjectSummary> {
    let name = Path::new(root)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(root)
        .to_string();
    let repo_exists = path_exists(root);
    Ok(ProjectSummary {
        id: None,
        name,
        root: root.to_string(),
        kind: None,
        owner: None,
        tags: Vec::new(),
        initialized: false,
        status: "uninitialized".to_string(),
        stale: !repo_exists,
        missing: !repo_exists,
        current_step_id: None,
        current_step_title: None,
        blocker_count: 0,
        total_step_count: 0,
        completed_step_count: 0,
        active_session_count: 0,
        focus_session_id: None,
        last_updated_at: None,
        next_action: Some("Initialize workflow metadata".to_string()),
        active_branch: read_git_branch(root)?,
        pending_proposal_count: 0,
        last_seen_at: Some(now_iso()),
    })
}

fn build_project_summary(root: &str) -> Result<ProjectSummary> {
    if path_exists(get_workflow_paths(root).workflow_dir) {
        build_initialized_project_summary(root)
    } else {
        build_uninitialized_project_summary(root)
    }
}

fn resolve_project_watched_root(
    store: &IndexStore,
    root: &str,
    explicit_watched_root: Option<&str>,
) -> Result<String> {
    if let Some(watched_root) = explicit_watched_root.filter(|value| !value.trim().is_empty()) {
        return Ok(canonicalize_root(watched_root));
    }

    if let Some(watched_root) = store.project_watched_root(root)? {
        return Ok(watched_root);
    }

    let root = canonicalize_root(root);
    Ok(most_specific_watched_root(&root, &store.list_watched_roots()?))
}

pub fn refresh_project_index(
    root: &str,
    index_db_path: &str,
    watched_root: Option<&str>,
) -> Result<()> {
    let root = canonicalize_root(root);
    let summary = build_project_summary(&root)?;
    let store = IndexStore::new(index_db_path.to_string())?;
    let watched_root = resolve_project_watched_root(&store, &root, watched_root)?;
    store.sync_project(&ProjectIndexRecord {
        summary,
        watched_root,
    })
}

fn refresh_handoff_file(root: &str, index_db_path: &str) -> Result<String> {
    let root = canonicalize_root(root);
    let detail = get_project(&root)?;
    let handoff = generate_handoff(&HandoffInput {
        manifest: detail.manifest.clone(),
        plan: detail.plan.clone(),
        runtime: detail.runtime.clone(),
        sessions: detail.sessions.clone(),
        activity: detail.recent_activity.clone(),
        proposals: detail.pending_proposals.clone(),
    });
    write_text_atomic(get_workflow_paths(&root).handoff_path, &handoff)?;
    refresh_project_index(&root, index_db_path, None)?;
    Ok(handoff)
}

fn matching_active_sessions<'a>(
    sessions: &'a SessionsFile,
    actor: &str,
    source: ActivitySource,
    branch: Option<&str>,
) -> Vec<&'a WorkflowSession> {
    sessions
        .sessions
        .iter()
        .filter(|session| {
            session.status == SessionStatus::Active
                && session.actor == actor
                && session.source == source
                && session.branch.as_deref() == branch
        })
        .collect()
}

fn create_session_record(
    actor: &MutationActor,
    branch: Option<String>,
    title: Option<String>,
    now: &str,
    preferred_id: Option<String>,
) -> WorkflowSession {
    let session_title = title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{} session", actor.actor));
    let slug = slugify(&session_title);
    WorkflowSession {
        id: preferred_id
            .unwrap_or_else(|| format!("{}-{}", slug, &Uuid::new_v4().to_string()[..8])),
        title: session_title,
        actor: actor.actor.clone(),
        source: actor.source,
        branch,
        status: SessionStatus::Active,
        owned_step_id: None,
        observed_step_ids: Vec::new(),
        started_at: now.to_string(),
        last_updated_at: now.to_string(),
    }
}

fn ensure_session_record(
    sessions: &mut SessionsFile,
    actor: &MutationActor,
    branch: Option<String>,
    context: &SessionContextInput,
    now: &str,
) -> WorkflowSession {
    if let Some(session_id) = &context.session_id {
        if let Some(existing) = sessions
            .sessions
            .iter_mut()
            .find(|session| session.id == *session_id)
        {
            if let Some(title) = &context.session_title {
                if !title.trim().is_empty() {
                    existing.title = title.trim().to_string();
                }
            }
            existing.branch = branch.clone();
            existing.status = SessionStatus::Active;
            existing.last_updated_at = now.to_string();
            return existing.clone();
        }

        let created = create_session_record(
            actor,
            branch,
            context.session_title.clone(),
            now,
            Some(session_id.clone()),
        );
        sessions.sessions.push(created.clone());
        return created;
    }

    let matches = matching_active_sessions(sessions, &actor.actor, actor.source, branch.as_deref());
    if matches.len() == 1 {
        let existing_id = matches[0].id.clone();
        if let Some(existing) = sessions
            .sessions
            .iter_mut()
            .find(|session| session.id == existing_id)
        {
            if let Some(title) = &context.session_title {
                if !title.trim().is_empty() {
                    existing.title = title.trim().to_string();
                }
            }
            existing.last_updated_at = now.to_string();
            return existing.clone();
        }
    }

    let created = create_session_record(actor, branch, context.session_title.clone(), now, None);
    sessions.sessions.push(created.clone());
    created
}

fn release_ownership(plan: &mut Plan, session_id: &str) {
    for phase in &mut plan.phases {
        for step in &mut phase.steps {
            if step.owner_session_id.as_deref() == Some(session_id) {
                step.owner_session_id = None;
                if matches!(step.status, StepStatus::InProgress | StepStatus::Blocked) {
                    step.status = StepStatus::Todo;
                }
            }
        }
    }
}

fn find_step_by_title<'a>(plan: &'a Plan, title: &str) -> Option<&'a Step> {
    get_all_steps(plan)
        .into_iter()
        .find(|step| step.title.eq_ignore_ascii_case(title))
}

fn unique_id(base: &str, used: &mut HashSet<String>) -> String {
    let mut candidate = base.to_string();
    let mut suffix = 2;
    while used.contains(&candidate) {
        candidate = format!("{base}-{suffix}");
        suffix += 1;
    }
    used.insert(candidate.clone());
    candidate
}

fn subtask_id_from_title(title: &str) -> String {
    let slug = slugify(title);
    if slug.is_empty() {
        "subtask".to_string()
    } else {
        slug
    }
}

fn step_id_from_title(title: &str) -> String {
    let slug = slugify(title);
    if slug.is_empty() {
        "step".to_string()
    } else {
        slug
    }
}

fn phase_id_from_title(title: &str) -> String {
    let slug = slugify(title);
    if slug.is_empty() {
        "phase".to_string()
    } else {
        slug
    }
}

fn ensure_observed_step(session: &mut WorkflowSession, step_id: Option<&str>) {
    let Some(step_id) = step_id else { return };
    if session.owned_step_id.as_deref() == Some(step_id)
        || session
            .observed_step_ids
            .iter()
            .any(|value| value == step_id)
    {
        return;
    }
    session.observed_step_ids.push(step_id.to_string());
}

fn build_synced_plan(previous_plan: &Plan, phases: &[PlanSyncPhaseInput]) -> Result<Plan> {
    let previous_steps = get_all_steps(previous_plan);
    let previous_by_id: HashMap<String, &Step> = previous_steps
        .iter()
        .map(|step| (step.id.clone(), *step))
        .collect();
    let previous_by_title: HashMap<String, &Step> = previous_steps
        .iter()
        .map(|step| (step.title.trim().to_lowercase(), *step))
        .collect();
    let mut used_phase_ids = HashSet::new();
    let mut used_step_ids = HashSet::new();

    let next_phases = phases
        .iter()
        .map(|phase_input| {
            let phase_id = unique_id(
                phase_input
                    .id
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or(&phase_id_from_title(&phase_input.title)),
                &mut used_phase_ids,
            );

            let steps = phase_input
                .steps
                .iter()
                .map(|step_input| {
                    let previous = step_input
                        .id
                        .as_ref()
                        .and_then(|id| previous_by_id.get(id))
                        .copied()
                        .or_else(|| {
                            previous_by_title
                                .get(&step_input.title.trim().to_lowercase())
                                .copied()
                        })
                        .or_else(|| find_step_by_title(previous_plan, &step_input.title));

                    let step_id = unique_id(
                        step_input
                            .id
                            .as_deref()
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                            .unwrap_or_else(|| {
                                previous.map(|step| step.id.as_str()).unwrap_or_else(|| "")
                            }),
                        &mut used_step_ids,
                    );
                    let step_id = if step_id.is_empty() {
                        unique_id(&step_id_from_title(&step_input.title), &mut used_step_ids)
                    } else {
                        step_id
                    };
                    let previous_subtasks: HashMap<String, &Subtask> = previous
                        .map(|step| {
                            step.subtasks
                                .iter()
                                .map(|subtask| (subtask.id.clone(), subtask))
                                .collect()
                        })
                        .unwrap_or_default();
                    let previous_subtasks_by_title: HashMap<String, &Subtask> = previous
                        .map(|step| {
                            step.subtasks
                                .iter()
                                .map(|subtask| (subtask.title.trim().to_lowercase(), subtask))
                                .collect()
                        })
                        .unwrap_or_default();
                    let mut used_subtask_ids = HashSet::new();
                    let subtasks = step_input
                        .subtasks
                        .clone()
                        .unwrap_or_default()
                        .into_iter()
                        .map(|subtask_input| {
                            let previous_subtask = subtask_input
                                .id
                                .as_ref()
                                .and_then(|id| previous_subtasks.get(id))
                                .copied()
                                .or_else(|| {
                                    previous_subtasks_by_title
                                        .get(&subtask_input.title.trim().to_lowercase())
                                        .copied()
                                });
                            let base = subtask_input
                                .id
                                .as_deref()
                                .map(str::trim)
                                .filter(|value| !value.is_empty())
                                .map(str::to_string)
                                .or_else(|| previous_subtask.map(|subtask| subtask.id.clone()))
                                .unwrap_or_else(|| subtask_id_from_title(&subtask_input.title));
                            Subtask {
                                id: unique_id(&base, &mut used_subtask_ids),
                                title: subtask_input.title,
                                status: subtask_input
                                    .status
                                    .or_else(|| previous_subtask.map(|subtask| subtask.status))
                                    .unwrap_or(SubtaskStatus::Todo),
                            }
                        })
                        .collect();

                    Step {
                        id: step_id,
                        title: step_input.title.clone(),
                        summary: step_input
                            .summary
                            .as_deref()
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                            .map(str::to_string)
                            .or_else(|| previous.map(|step| step.summary.clone()))
                            .unwrap_or_default(),
                        status: previous.map(|step| step.status).unwrap_or(StepStatus::Todo),
                        depends_on: step_input
                            .depends_on
                            .clone()
                            .or_else(|| previous.map(|step| step.depends_on.clone()))
                            .unwrap_or_default(),
                        details: step_input
                            .details
                            .clone()
                            .or_else(|| previous.map(|step| step.details.clone()))
                            .unwrap_or_default(),
                        subtasks,
                        owner_session_id: previous.and_then(|step| step.owner_session_id.clone()),
                        completed_at: previous.and_then(|step| step.completed_at.clone()),
                        completed_by: previous.and_then(|step| step.completed_by.clone()),
                    }
                })
                .collect::<Vec<_>>();

            Phase {
                id: phase_id,
                title: phase_input.title.clone(),
                steps,
            }
        })
        .collect::<Vec<_>>();

    let next_plan = Plan {
        version: 2,
        phases: next_phases,
    };
    validate_plan(&next_plan)?;
    Ok(next_plan)
}

struct MutateProjectState {
    plan: Plan,
    runtime: RuntimeState,
    sessions: SessionsFile,
    proposals: DecisionProposalsFile,
}

struct EventContext {
    session_id: Option<String>,
    step_id: Option<String>,
    subtask_id: Option<String>,
}

struct MutateProjectResult {
    summary: String,
    event_type: String,
    payload: Value,
    write_plan: Option<Plan>,
    write_runtime: Option<RuntimeState>,
    write_sessions: Option<SessionsFile>,
    write_proposals: Option<DecisionProposalsFile>,
    event_context: EventContext,
}

fn mutate_project<F>(
    root: &str,
    actor: &MutationActor,
    index_db_path: &str,
    mutate: F,
) -> Result<ProjectDetail>
where
    F: FnOnce(MutateProjectState) -> Result<MutateProjectResult>,
{
    let root = canonicalize_root(root);
    with_project_lock(&root, || {
        ensure_project_files(&root, actor)?;
        let manifest = read_manifest(&root)?;
        let plan = read_plan(&root)?;
        let runtime = read_runtime(&root)?;
        let sessions = read_sessions(&root)?;
        let proposals = read_pending_proposals(&root)?;

        let result = mutate(MutateProjectState {
            plan,
            runtime,
            sessions,
            proposals,
        })?;

        if let Some(plan) = &result.write_plan {
            write_yaml_atomic(get_workflow_paths(&root).plan_path, plan)?;
        }
        if let Some(runtime) = &result.write_runtime {
            write_yaml_atomic(get_workflow_paths(&root).runtime_path, runtime)?;
        }
        if let Some(sessions) = &result.write_sessions {
            write_yaml_atomic(get_workflow_paths(&root).sessions_path, sessions)?;
        }
        if let Some(proposals) = &result.write_proposals {
            write_yaml_atomic(get_workflow_paths(&root).proposed_decisions_path, proposals)?;
        }

        append_activity(
            &root,
            &ActivityEvent {
                timestamp: now_iso(),
                actor: actor.actor.clone(),
                source: actor.source,
                project_id: manifest.id,
                session_id: result.event_context.session_id,
                step_id: result.event_context.step_id,
                subtask_id: result.event_context.subtask_id,
                event_type: result.event_type,
                summary: result.summary,
                payload: result.payload,
            },
        )?;

        refresh_handoff_file(&root, index_db_path)?;
        get_project(&root)
    })
}

pub fn init_project(input: InitProjectInput) -> Result<ProjectDetail> {
    let root = canonicalize_root(&input.root);
    with_project_lock(&root, || {
        let timestamp = now_iso();
        let paths = get_workflow_paths(&root);
        let manifest = create_default_manifest(&root, &input, &timestamp);
        let plan = create_default_plan();
        let runtime = create_default_runtime(&plan, read_git_branch(&root)?, &timestamp);
        let sessions = blank_sessions_file();

        ensure_dir(&paths.local_dir)?;
        write_yaml_atomic(&paths.manifest_path, &manifest)?;
        write_yaml_atomic(&paths.plan_path, &plan)?;
        write_text_atomic(&paths.decisions_path, "# Accepted Decisions\n")?;
        write_yaml_atomic(&paths.runtime_path, &runtime)?;
        write_yaml_atomic(&paths.sessions_path, &sessions)?;
        write_yaml_atomic(
            &paths.proposed_decisions_path,
            &DecisionProposalsFile {
                version: 1,
                proposals: Vec::new(),
            },
        )?;
        write_text_atomic(&paths.activity_path, "")?;
        append_activity(
            &root,
            &ActivityEvent {
                timestamp: timestamp.clone(),
                actor: input.actor.clone(),
                source: input.source,
                project_id: manifest.id.clone(),
                session_id: None,
                step_id: runtime.current_step_id.clone(),
                subtask_id: None,
                event_type: "project.initialized".to_string(),
                summary: "Initialized project workflow files".to_string(),
                payload: json!({}),
            },
        )?;
        ensure_gitignore_entry(&root)?;
        let handoff = generate_handoff(&HandoffInput {
            manifest: manifest.clone(),
            plan: plan.clone(),
            runtime: runtime.clone(),
            sessions: sessions.sessions.clone(),
            activity: read_activity(&root)?,
            proposals: Vec::new(),
        });
        write_text_atomic(&paths.handoff_path, &handoff)?;
        refresh_project_index(&root, &input.index_db_path, Some(&root))?;
        get_project(&root)
    })
}

pub fn get_project(root: &str) -> Result<ProjectDetail> {
    let root = canonicalize_root(root);
    let paths = get_workflow_paths(&root);
    let manifest = read_yaml_file(&paths.manifest_path)?;
    let plan = read_plan(&root)?;
    let runtime: RuntimeState = read_yaml_file(&paths.runtime_path)?;
    let sessions = read_sessions(&root)?;
    let activity = read_activity(&root)?;
    let proposal_file = read_yaml_file::<DecisionProposalsFile>(&paths.proposed_decisions_path)?;
    let handoff = read_text_if_exists(&paths.handoff_path)?.unwrap_or_default();
    let decisions_markdown = read_decisions_markdown(&root)?;

    Ok(ProjectDetail {
        manifest,
        plan,
        runtime: runtime.clone(),
        sessions: sessions.sessions,
        recent_activity: activity,
        blockers: runtime.blockers.clone(),
        pending_proposals: proposal_file
            .proposals
            .into_iter()
            .filter(|proposal| proposal.status == DecisionProposalStatus::Proposed)
            .collect(),
        handoff,
        decisions: parse_accepted_decisions(&decisions_markdown),
    })
}

pub fn missing_watched_root_coverage(roots: &[String], index_db_path: &str) -> Result<Vec<String>> {
    let roots = normalize_roots(roots.iter().cloned());
    let store = IndexStore::new(index_db_path.to_string())?;
    store.missing_watched_root_coverage(&roots)
}

pub fn remove_watched_root_index_state(watched_root: &str, index_db_path: &str) -> Result<()> {
    let store = IndexStore::new(index_db_path.to_string())?;
    store.remove_watched_root(&canonicalize_root(watched_root))
}

pub fn list_watched_roots(index_db_path: &str) -> Result<Vec<String>> {
    let store = IndexStore::new(index_db_path.to_string())?;
    store.list_watched_roots()
}

pub fn add_watched_root_index_state(watched_root: &str, index_db_path: &str) -> Result<()> {
    let store = IndexStore::new(index_db_path.to_string())?;
    store.add_watched_root(&canonicalize_root(watched_root), &now_iso())
}

pub fn ensure_session(input: EnsureSessionInput) -> Result<ProjectDetail> {
    let actor = MutationActor {
        actor: input.actor.clone(),
        source: input.source,
    };
    let session_context = SessionContextInput {
        session_id: input.session_id.clone(),
        session_title: input.session_title.clone(),
        branch: input.branch.clone(),
    };
    mutate_project(&input.root, &actor, &input.index_db_path, |mut data| {
        let now = now_iso();
        let branch = session_context
            .branch
            .clone()
            .or_else(|| read_git_branch(&input.root).ok().flatten());
        let session = ensure_session_record(
            &mut data.sessions,
            &actor,
            branch.clone(),
            &session_context,
            &now,
        );
        let next_runtime = refresh_runtime_state(
            &mut data.plan,
            &RuntimeState {
                focus_session_id: Some(session.id.clone()),
                last_updated_at: now.clone(),
                ..data.runtime.clone()
            },
            &mut data.sessions,
            branch,
            &now,
        );
        Ok(MutateProjectResult {
            summary: format!("Ensured session \"{}\"", session.title),
            event_type: "session.ensured".to_string(),
            payload: json!({ "sessionId": session.id }),
            write_plan: None,
            write_runtime: Some(next_runtime),
            write_sessions: Some(data.sessions),
            write_proposals: None,
            event_context: EventContext {
                session_id: Some(session.id),
                step_id: None,
                subtask_id: None,
            },
        })
    })
}

pub fn sync_plan(input: SyncPlanInput) -> Result<ProjectDetail> {
    let actor = MutationActor {
        actor: input.actor.clone(),
        source: input.source,
    };
    let session_context = SessionContextInput {
        session_id: input.session_id.clone(),
        session_title: input.session_title.clone(),
        branch: input.branch.clone(),
    };
    mutate_project(&input.root, &actor, &input.index_db_path, |mut data| {
        let now = now_iso();
        let branch = session_context
            .branch
            .clone()
            .or_else(|| read_git_branch(&input.root).ok().flatten());
        let next_plan = build_synced_plan(&data.plan, &input.phases)?;
        let session = ensure_session_record(
            &mut data.sessions,
            &actor,
            branch.clone(),
            &session_context,
            &now,
        );
        let mut next_plan = next_plan;
        reconcile_sessions_and_plan(&mut next_plan, &mut data.sessions);
        let next_runtime = refresh_runtime_state(
            &mut next_plan,
            &RuntimeState {
                focus_session_id: Some(session.id.clone()),
                last_updated_at: now.clone(),
                ..data.runtime.clone()
            },
            &mut data.sessions,
            branch,
            &now,
        );
        Ok(MutateProjectResult {
            summary: "Synced canonical project plan".to_string(),
            event_type: "plan.synced".to_string(),
            payload: json!({ "phaseCount": next_plan.phases.len() }),
            write_plan: Some(next_plan),
            write_runtime: Some(next_runtime.clone()),
            write_sessions: Some(data.sessions),
            write_proposals: None,
            event_context: EventContext {
                session_id: Some(session.id),
                step_id: next_runtime.current_step_id.clone(),
                subtask_id: None,
            },
        })
    })
}

pub fn start_step(
    root: &str,
    step_id: &str,
    actor: MutationActor,
    context: SessionContextInput,
    index_db_path: &str,
) -> Result<ProjectDetail> {
    mutate_project(root, &actor, index_db_path, |mut data| {
        let Some((phase_index, _step_index, _, current_step)) = locate_step(&data.plan, step_id)
        else {
            bail!("Unknown step \"{step_id}\"");
        };

        for dependency in &current_step.depends_on {
            let dependency_done = locate_step(&data.plan, dependency)
                .map(|(_, _, _, step)| step.status == StepStatus::Done)
                .unwrap_or(false);
            if !dependency_done {
                bail!("Cannot start \"{step_id}\" until \"{dependency}\" is done");
            }
        }

        let now = now_iso();
        let branch = context
            .branch
            .clone()
            .or_else(|| read_git_branch(root).ok().flatten());
        let session =
            ensure_session_record(&mut data.sessions, &actor, branch.clone(), &context, &now);

        if let Some(owner_session_id) = current_step.owner_session_id.as_deref() {
            if owner_session_id != session.id {
                bail!(
                    "Step \"{}\" is owned by another session",
                    current_step.title
                );
            }
        }

        release_ownership(&mut data.plan, &session.id);
        normalize_plan_in_progress_states(&mut data.plan, Some(step_id));
        let (phase_index_mut, step_index_mut) = locate_step_indices(&data.plan, step_id).unwrap();
        {
            let step = &mut data.plan.phases[phase_index_mut].steps[step_index_mut];
            step.owner_session_id = Some(session.id.clone());
            step.status = if data.runtime.blockers.is_empty() {
                StepStatus::InProgress
            } else {
                StepStatus::Blocked
            };
            step.completed_at = None;
            step.completed_by = None;
        }
        if let Some(session_mut) = data
            .sessions
            .sessions
            .iter_mut()
            .find(|candidate| candidate.id == session.id)
        {
            session_mut.owned_step_id = Some(step_id.to_string());
            session_mut.last_updated_at = now.clone();
        }

        let step_status = locate_step(&data.plan, step_id).unwrap().3.status;
        let current_phase_id = data.plan.phases[phase_index].id.clone();
        let next_runtime = refresh_runtime_state(
            &mut data.plan,
            &RuntimeState {
                current_phase_id: Some(current_phase_id),
                current_step_id: Some(step_id.to_string()),
                focus_session_id: Some(session.id.clone()),
                status: step_status,
                last_updated_at: now.clone(),
                ..data.runtime.clone()
            },
            &mut data.sessions,
            branch,
            &now,
        );

        Ok(MutateProjectResult {
            summary: format!(
                "Started step \"{}\"",
                locate_step(&data.plan, step_id).unwrap().3.title
            ),
            event_type: "step.started".to_string(),
            payload: json!({ "stepId": step_id, "sessionId": session.id }),
            write_plan: Some(data.plan),
            write_runtime: Some(next_runtime),
            write_sessions: Some(data.sessions),
            write_proposals: None,
            event_context: EventContext {
                session_id: Some(session.id),
                step_id: Some(step_id.to_string()),
                subtask_id: None,
            },
        })
    })
}

pub fn complete_step(
    root: &str,
    step_id: &str,
    actor: MutationActor,
    context: SessionContextInput,
    index_db_path: &str,
) -> Result<ProjectDetail> {
    mutate_project(root, &actor, index_db_path, |mut data| {
        let current_title = locate_step(&data.plan, step_id)
            .map(|(_, _, _, step)| step.title.clone())
            .ok_or_else(|| anyhow!("Unknown step \"{step_id}\""))?;

        let now = now_iso();
        let branch = context
            .branch
            .clone()
            .or_else(|| read_git_branch(root).ok().flatten());
        let session =
            ensure_session_record(&mut data.sessions, &actor, branch.clone(), &context, &now);

        if let Some(owner_session_id) = locate_step(&data.plan, step_id)
            .unwrap()
            .3
            .owner_session_id
            .clone()
        {
            if owner_session_id != session.id && !human_override_allowed(actor.source) {
                bail!("Step \"{}\" is owned by another session", current_title);
            }
        }

        let (phase_index_mut, step_index_mut) = locate_step_indices(&data.plan, step_id).unwrap();
        {
            let step = &mut data.plan.phases[phase_index_mut].steps[step_index_mut];
            step.status = StepStatus::Done;
            step.owner_session_id = None;
            step.completed_at = Some(now.clone());
            step.completed_by = Some(actor.actor.clone());
        }
        if let Some(owner_session) = data
            .sessions
            .sessions
            .iter_mut()
            .find(|candidate| candidate.id == session.id)
        {
            owner_session.owned_step_id = None;
            owner_session.last_updated_at = now.clone();
        }

        let next_runtime = refresh_runtime_state(
            &mut data.plan,
            &RuntimeState {
                focus_session_id: Some(session.id.clone()),
                last_updated_at: now.clone(),
                ..data.runtime.clone()
            },
            &mut data.sessions,
            branch,
            &now,
        );

        Ok(MutateProjectResult {
            summary: format!("Completed step \"{current_title}\""),
            event_type: "step.completed".to_string(),
            payload: json!({ "stepId": step_id, "sessionId": session.id }),
            write_plan: Some(data.plan),
            write_runtime: Some(next_runtime),
            write_sessions: Some(data.sessions),
            write_proposals: None,
            event_context: EventContext {
                session_id: Some(session.id),
                step_id: Some(step_id.to_string()),
                subtask_id: None,
            },
        })
    })
}

pub fn add_blocker(
    root: &str,
    blocker: &str,
    actor: MutationActor,
    context: SessionContextInput,
    index_db_path: &str,
) -> Result<ProjectDetail> {
    mutate_project(root, &actor, index_db_path, |mut data| {
        let now = now_iso();
        let branch = context
            .branch
            .clone()
            .or_else(|| read_git_branch(root).ok().flatten());
        let session =
            ensure_session_record(&mut data.sessions, &actor, branch.clone(), &context, &now);
        let mut blockers = data.runtime.blockers.clone();
        if !blockers.iter().any(|candidate| candidate == blocker) {
            blockers.push(blocker.to_string());
        }
        let current_step_id = data.runtime.current_step_id.clone();
        if let Some(step_id) = &current_step_id {
            if let Some((phase_index, step_index)) = locate_step_indices(&data.plan, step_id) {
                let step = &mut data.plan.phases[phase_index].steps[step_index];
                step.status = StepStatus::Blocked;
                if step.owner_session_id.is_none() {
                    step.owner_session_id = Some(session.id.clone());
                }
            }
        }
        let next_runtime = refresh_runtime_state(
            &mut data.plan,
            &RuntimeState {
                blockers,
                focus_session_id: Some(session.id.clone()),
                last_updated_at: now.clone(),
                ..data.runtime.clone()
            },
            &mut data.sessions,
            branch,
            &now,
        );
        Ok(MutateProjectResult {
            summary: format!("Added blocker: {blocker}"),
            event_type: "blocker.added".to_string(),
            payload: json!({ "blocker": blocker }),
            write_plan: Some(data.plan),
            write_runtime: Some(next_runtime),
            write_sessions: Some(data.sessions),
            write_proposals: None,
            event_context: EventContext {
                session_id: Some(session.id),
                step_id: current_step_id,
                subtask_id: None,
            },
        })
    })
}

pub fn clear_blocker(
    root: &str,
    blocker: Option<&str>,
    actor: MutationActor,
    context: SessionContextInput,
    index_db_path: &str,
) -> Result<ProjectDetail> {
    mutate_project(root, &actor, index_db_path, |mut data| {
        let now = now_iso();
        let branch = context
            .branch
            .clone()
            .or_else(|| read_git_branch(root).ok().flatten());
        let session =
            ensure_session_record(&mut data.sessions, &actor, branch.clone(), &context, &now);
        let blockers = if let Some(blocker) = blocker.filter(|value| !value.is_empty()) {
            data.runtime
                .blockers
                .iter()
                .filter(|candidate| candidate.as_str() != blocker)
                .cloned()
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        let current_step_id = data.runtime.current_step_id.clone();
        if let Some(step_id) = &current_step_id {
            if let Some((phase_index, step_index)) = locate_step_indices(&data.plan, step_id) {
                let step = &mut data.plan.phases[phase_index].steps[step_index];
                if blockers.is_empty() && step.status == StepStatus::Blocked {
                    step.status = if step.owner_session_id.is_some() {
                        StepStatus::InProgress
                    } else {
                        StepStatus::Todo
                    };
                }
            }
        }
        let next_runtime = refresh_runtime_state(
            &mut data.plan,
            &RuntimeState {
                blockers,
                focus_session_id: Some(session.id.clone()),
                last_updated_at: now.clone(),
                ..data.runtime.clone()
            },
            &mut data.sessions,
            branch,
            &now,
        );
        Ok(MutateProjectResult {
            summary: blocker
                .filter(|value| !value.is_empty())
                .map(|value| format!("Cleared blocker: {value}"))
                .unwrap_or_else(|| "Cleared all blockers".to_string()),
            event_type: "blocker.cleared".to_string(),
            payload: blocker
                .filter(|value| !value.is_empty())
                .map(|value| json!({ "blocker": value }))
                .unwrap_or_else(|| json!({ "cleared": "all" })),
            write_plan: Some(data.plan),
            write_runtime: Some(next_runtime),
            write_sessions: Some(data.sessions),
            write_proposals: None,
            event_context: EventContext {
                session_id: Some(session.id),
                step_id: current_step_id,
                subtask_id: None,
            },
        })
    })
}

pub fn add_note(
    root: &str,
    note: &str,
    actor: MutationActor,
    context: SessionContextInput,
    index_db_path: &str,
) -> Result<ProjectDetail> {
    append_activity_event(
        root,
        AppendActivityInput {
            actor: actor.actor,
            source: actor.source,
            session_id: context.session_id,
            session_title: context.session_title,
            branch: context.branch,
            event_type: "note.added".to_string(),
            summary: note.to_string(),
            payload: None,
            step_id: None,
            subtask_id: None,
            index_db_path: index_db_path.to_string(),
        },
    )
}

fn merge_runtime_patch(target: &mut Value, patch: &Value) {
    match (target, patch) {
        (Value::Object(target_map), Value::Object(patch_map)) => {
            for (key, value) in patch_map {
                merge_runtime_patch(target_map.entry(key.clone()).or_insert(Value::Null), value);
            }
        }
        (target_slot, value) => {
            *target_slot = value.clone();
        }
    }
}

pub fn update_runtime(input: RuntimePatchInput) -> Result<ProjectDetail> {
    let actor = MutationActor {
        actor: input.actor.clone(),
        source: input.source,
    };
    mutate_project(&input.root, &actor, &input.index_db_path, |mut data| {
        let now = now_iso();
        let mut runtime_value = serde_json::to_value(&data.runtime)?;
        merge_runtime_patch(&mut runtime_value, &Value::Object(input.patch.clone()));
        if let Value::Object(map) = &mut runtime_value {
            map.insert("last_updated_at".to_string(), Value::String(now.clone()));
        }
        let patched_runtime: RuntimeState = serde_json::from_value(runtime_value)?;
        let next_runtime = refresh_runtime_state(
            &mut data.plan,
            &patched_runtime,
            &mut data.sessions,
            patched_runtime
                .active_branch
                .clone()
                .or_else(|| data.runtime.active_branch.clone())
                .or_else(|| read_git_branch(&input.root).ok().flatten()),
            &now,
        );
        Ok(MutateProjectResult {
            summary: input.summary.clone(),
            event_type: input
                .event_type
                .clone()
                .unwrap_or_else(|| "runtime.updated".to_string()),
            payload: Value::Object(input.patch.clone()),
            write_plan: None,
            write_runtime: Some(next_runtime.clone()),
            write_sessions: Some(data.sessions),
            write_proposals: None,
            event_context: EventContext {
                session_id: next_runtime.focus_session_id.clone(),
                step_id: next_runtime.current_step_id.clone(),
                subtask_id: None,
            },
        })
    })
}

pub fn append_activity_event(root: &str, event: AppendActivityInput) -> Result<ProjectDetail> {
    let actor = MutationActor {
        actor: event.actor.clone(),
        source: event.source,
    };
    mutate_project(root, &actor, &event.index_db_path, |mut data| {
        let now = now_iso();
        let branch = if event.branch.is_some() {
            event.branch.clone()
        } else {
            read_git_branch(root).ok().flatten()
        };
        let should_ensure_session =
            event.source != ActivitySource::System || event.session_id.is_some();
        let session = if should_ensure_session {
            Some(ensure_session_record(
                &mut data.sessions,
                &actor,
                branch.clone(),
                &SessionContextInput {
                    session_id: event.session_id.clone(),
                    session_title: event.session_title.clone(),
                    branch: branch.clone(),
                },
                &now,
            ))
        } else {
            None
        };

        if let (Some(session), Some(step_id)) = (&session, event.step_id.as_deref()) {
            if let Some(session_mut) = data
                .sessions
                .sessions
                .iter_mut()
                .find(|candidate| candidate.id == session.id)
            {
                ensure_observed_step(session_mut, Some(step_id));
                session_mut.last_updated_at = now.clone();
            }
        }

        let next_runtime = refresh_runtime_state(
            &mut data.plan,
            &RuntimeState {
                focus_session_id: session
                    .as_ref()
                    .map(|session| session.id.clone())
                    .or_else(|| data.runtime.focus_session_id.clone()),
                last_updated_at: now.clone(),
                ..data.runtime.clone()
            },
            &mut data.sessions,
            branch.or_else(|| data.runtime.active_branch.clone()),
            &now,
        );

        Ok(MutateProjectResult {
            summary: event.summary.clone(),
            event_type: event.event_type.clone(),
            payload: event.payload.clone().unwrap_or_else(|| json!({})),
            write_plan: None,
            write_runtime: Some(next_runtime),
            write_sessions: Some(data.sessions),
            write_proposals: None,
            event_context: EventContext {
                session_id: session.map(|session| session.id),
                step_id: event.step_id.clone(),
                subtask_id: event.subtask_id.clone(),
            },
        })
    })
}

pub fn propose_decision(
    root: &str,
    proposal: DecisionProposalInput,
    actor: MutationActor,
    context: SessionContextInput,
    index_db_path: &str,
) -> Result<ProjectDetail> {
    mutate_project(root, &actor, index_db_path, |mut data| {
        let now = now_iso();
        let branch = context
            .branch
            .clone()
            .or_else(|| read_git_branch(root).ok().flatten());
        let session =
            ensure_session_record(&mut data.sessions, &actor, branch.clone(), &context, &now);
        let next_proposal = DecisionProposal {
            id: Uuid::new_v4().to_string(),
            proposed_at: now.clone(),
            proposed_by: actor.actor.clone(),
            title: proposal.title.clone(),
            context: proposal.context.clone(),
            decision: proposal.decision.clone(),
            impact: proposal.impact.clone(),
            status: DecisionProposalStatus::Proposed,
        };
        let mut next_proposals = data.proposals.clone();
        next_proposals.proposals.push(next_proposal.clone());
        let next_runtime = refresh_runtime_state(
            &mut data.plan,
            &RuntimeState {
                focus_session_id: Some(session.id.clone()),
                last_updated_at: now.clone(),
                ..data.runtime.clone()
            },
            &mut data.sessions,
            branch,
            &now,
        );
        Ok(MutateProjectResult {
            summary: format!("Proposed decision \"{}\"", proposal.title),
            event_type: "decision.proposed".to_string(),
            payload: json!({ "proposalId": next_proposal.id }),
            write_plan: None,
            write_runtime: Some(next_runtime.clone()),
            write_sessions: Some(data.sessions),
            write_proposals: Some(next_proposals),
            event_context: EventContext {
                session_id: Some(session.id),
                step_id: next_runtime.current_step_id.clone(),
                subtask_id: None,
            },
        })
    })
}

pub fn accept_decision(
    root: &str,
    proposal_id: &str,
    actor: MutationActor,
    index_db_path: &str,
) -> Result<ProjectDetail> {
    with_project_lock(root, || {
        let manifest = read_manifest(root)?;
        let proposal_file = read_pending_proposals(root)?;
        let decisions_markdown = read_decisions_markdown(root)?;

        let target = proposal_file
            .proposals
            .iter()
            .find(|proposal| proposal.id == proposal_id)
            .cloned()
            .ok_or_else(|| anyhow!("Unknown decision proposal \"{proposal_id}\""))?;
        let remaining = proposal_file
            .proposals
            .into_iter()
            .filter(|proposal| proposal.id != proposal_id)
            .collect::<Vec<_>>();
        write_yaml_atomic(
            get_workflow_paths(root).proposed_decisions_path,
            &DecisionProposalsFile {
                version: 1,
                proposals: remaining,
            },
        )?;

        let mut accepted = parse_accepted_decisions(&decisions_markdown);
        accepted.push(AcceptedDecision {
            date: target.proposed_at.chars().take(10).collect(),
            title: target.title.clone(),
            context: target.context.clone(),
            decision: target.decision.clone(),
            impact: target.impact.clone(),
        });
        write_text_atomic(
            get_workflow_paths(root).decisions_path,
            &build_accepted_decision_markdown(&accepted),
        )?;

        append_activity(
            root,
            &ActivityEvent {
                timestamp: now_iso(),
                actor: actor.actor,
                source: actor.source,
                project_id: manifest.id,
                session_id: None,
                step_id: None,
                subtask_id: None,
                event_type: "decision.accepted".to_string(),
                summary: format!("Accepted decision \"{}\"", target.title),
                payload: json!({ "proposalId": proposal_id }),
            },
        )?;

        refresh_handoff_file(root, index_db_path)?;
        get_project(root)
    })
}

pub fn refresh_handoff(
    root: &str,
    _actor: MutationActor,
    index_db_path: &str,
) -> Result<ProjectDetail> {
    with_project_lock(root, || {
        refresh_handoff_file(root, index_db_path)?;
        get_project(root)
    })
}

fn validate_plan(plan: &Plan) -> Result<()> {
    if plan.phases.is_empty() {
        bail!("plan must contain at least one phase");
    }

    let mut phase_ids = HashSet::new();
    let mut step_ids = HashSet::new();
    for phase in &plan.phases {
        if phase.id.trim().is_empty() {
            bail!("phase id cannot be empty");
        }
        if !phase_ids.insert(phase.id.clone()) {
            bail!("Duplicate phase id \"{}\"", phase.id);
        }
        for step in &phase.steps {
            if step.id.trim().is_empty() {
                bail!("step id cannot be empty");
            }
            if !step_ids.insert(step.id.clone()) {
                bail!("Duplicate step id \"{}\"", step.id);
            }
        }
    }

    for phase in &plan.phases {
        for step in &phase.steps {
            for dependency in &step.depends_on {
                if !step_ids.contains(dependency) {
                    bail!("Unknown dependency \"{}\"", dependency);
                }
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index_store::IndexStore;
    use crate::PlanSyncStepInput;
    use crate::{get_board_project_detail, list_indexed_projects, list_projects, BoardStepDetail};
    use std::fs;
    use tempfile::tempdir;

    fn create_real_repo(name: &str) -> Result<String> {
        let dir = tempdir()?;
        let root = dir.keep().join(name);
        fs::create_dir_all(root.join(".git"))?;
        fs::write(root.join(".git/HEAD"), "ref: refs/heads/main\n")?;
        Ok(root.display().to_string())
    }

    #[test]
    fn initializes_expected_files() -> Result<()> {
        let repo = create_real_repo("parallel-project")?;
        let index_db = Path::new(&repo)
            .join(".app/index.sqlite")
            .display()
            .to_string();
        init_project(InitProjectInput {
            root: repo.clone(),
            actor: "tester".to_string(),
            source: ActivitySource::Cli,
            name: Some("Parallel".to_string()),
            kind: None,
            owner: None,
            tags: None,
            index_db_path: index_db,
        })?;
        let workflow_dir = Path::new(&repo).join(".project-workflow");
        assert!(workflow_dir.join("manifest.yaml").exists());
        assert!(workflow_dir.join("plan.yaml").exists());
        assert!(workflow_dir.join("decisions.md").exists());
        assert!(workflow_dir.join("local/runtime.yaml").exists());
        assert!(workflow_dir.join("local/activity.jsonl").exists());
        assert!(workflow_dir.join("local/decisions-proposed.yaml").exists());
        assert!(workflow_dir.join("local/handoff.md").exists());
        assert!(fs::read_to_string(Path::new(&repo).join(".gitignore"))?
            .contains(".project-workflow/local/"));
        Ok(())
    }

    #[test]
    fn supports_step_and_blocker_flow() -> Result<()> {
        let repo = create_real_repo("parallel-project")?;
        let index_db = Path::new(&repo)
            .join(".app/index.sqlite")
            .display()
            .to_string();
        init_project(InitProjectInput {
            root: repo.clone(),
            actor: "tester".to_string(),
            source: ActivitySource::Cli,
            name: Some("Parallel".to_string()),
            kind: None,
            owner: None,
            tags: None,
            index_db_path: index_db.clone(),
        })?;
        let detail = get_project(&repo)?;
        let first_step_id = detail.plan.phases[0].steps[0].id.clone();
        let ctx = SessionContextInput::default();
        start_step(
            &repo,
            &first_step_id,
            MutationActor {
                actor: "agent-1".to_string(),
                source: ActivitySource::Agent,
            },
            ctx.clone(),
            &index_db,
        )?;
        add_blocker(
            &repo,
            "Need sign-off",
            MutationActor {
                actor: "agent-1".to_string(),
                source: ActivitySource::Agent,
            },
            ctx.clone(),
            &index_db,
        )?;
        clear_blocker(
            &repo,
            Some("Need sign-off"),
            MutationActor {
                actor: "agent-1".to_string(),
                source: ActivitySource::Agent,
            },
            ctx.clone(),
            &index_db,
        )?;
        add_note(
            &repo,
            "Captured initial requirements",
            MutationActor {
                actor: "agent-1".to_string(),
                source: ActivitySource::Agent,
            },
            ctx.clone(),
            &index_db,
        )?;
        let completed = complete_step(
            &repo,
            &first_step_id,
            MutationActor {
                actor: "agent-1".to_string(),
                source: ActivitySource::Agent,
            },
            ctx,
            &index_db,
        )?;
        assert_eq!(completed.plan.phases[0].steps[0].status, StepStatus::Done);
        Ok(())
    }

    #[test]
    fn preserves_step_ids_on_sync() -> Result<()> {
        let repo = create_real_repo("parallel-project")?;
        let index_db = Path::new(&repo)
            .join(".app/index.sqlite")
            .display()
            .to_string();
        init_project(InitProjectInput {
            root: repo.clone(),
            actor: "tester".to_string(),
            source: ActivitySource::Cli,
            name: Some("Parallel".to_string()),
            kind: None,
            owner: None,
            tags: None,
            index_db_path: index_db.clone(),
        })?;
        let first = sync_plan(SyncPlanInput {
            root: repo.clone(),
            actor: "codex".to_string(),
            source: ActivitySource::Agent,
            session_id: None,
            session_title: Some("Spec sync".to_string()),
            branch: None,
            phases: vec![PlanSyncPhaseInput {
                id: None,
                title: "Build".to_string(),
                steps: vec![PlanSyncStepInput {
                    id: None,
                    title: "Build recorder".to_string(),
                    summary: Some("Record venue-native events.".to_string()),
                    details: Some(vec!["Record snapshots.".to_string()]),
                    depends_on: None,
                    subtasks: None,
                }],
            }],
            index_db_path: index_db.clone(),
        })?;
        let step_id = first.plan.phases[0].steps[0].id.clone();
        let second = sync_plan(SyncPlanInput {
            root: repo.clone(),
            actor: "codex".to_string(),
            source: ActivitySource::Agent,
            session_id: None,
            session_title: Some("Spec sync".to_string()),
            branch: None,
            phases: vec![PlanSyncPhaseInput {
                id: None,
                title: "Build".to_string(),
                steps: vec![PlanSyncStepInput {
                    id: None,
                    title: "Build recorder".to_string(),
                    summary: Some("Record venue-native events.".to_string()),
                    details: Some(vec!["Record snapshots and trades.".to_string()]),
                    depends_on: None,
                    subtasks: None,
                }],
            }],
            index_db_path: index_db,
        })?;
        assert_eq!(second.plan.phases[0].steps[0].id, step_id);
        Ok(())
    }

    #[test]
    fn snapshot_only_returns_indexed_projects_until_refresh_runs() -> Result<()> {
        let watched_root_dir = tempdir()?;
        let watched_root = watched_root_dir.path().join("watched");
        fs::create_dir_all(&watched_root)?;

        let repo_one = watched_root.join("repo-one");
        fs::create_dir_all(repo_one.join(".git"))?;
        fs::write(repo_one.join(".git/HEAD"), "ref: refs/heads/main\n")?;

        let index_db = watched_root.join(".app/index.sqlite").display().to_string();
        init_project(InitProjectInput {
            root: repo_one.display().to_string(),
            actor: "tester".to_string(),
            source: ActivitySource::Cli,
            name: Some("Repo One".to_string()),
            kind: None,
            owner: None,
            tags: None,
            index_db_path: index_db.clone(),
        })?;

        let roots = vec![watched_root.display().to_string()];
        let canonical_roots = vec![fs::canonicalize(&watched_root)?
            .to_string_lossy()
            .into_owned()];
        assert_eq!(
            missing_watched_root_coverage(&roots, &index_db)?,
            canonical_roots
        );

        let refreshed = list_projects(&roots, &index_db)?;
        assert_eq!(refreshed.len(), 1);
        assert!(missing_watched_root_coverage(&roots, &index_db)?.is_empty());

        let repo_two = watched_root.join("repo-two");
        fs::create_dir_all(repo_two.join(".git"))?;
        fs::write(repo_two.join(".git/HEAD"), "ref: refs/heads/main\n")?;

        let snapshot = list_indexed_projects(&roots, &index_db)?;
        assert_eq!(snapshot.len(), 1);
        assert!(snapshot[0].root.ends_with("/watched/repo-one"));

        let codex_home = watched_root_dir.path().join(".codex");
        fs::create_dir_all(&codex_home)?;
        let codex_db = codex_home.join("state_9.sqlite");
        let connection = rusqlite::Connection::open(&codex_db)?;
        connection.execute_batch(
            r#"
            CREATE TABLE threads (
              cwd TEXT,
              archived INTEGER NOT NULL DEFAULT 0
            );
            "#,
        )?;
        connection.execute(
            "INSERT INTO threads (cwd, archived) VALUES (?1, 0)",
            rusqlite::params![repo_two.display().to_string()],
        )?;

        let prior_home = std::env::var_os("HOME");
        std::env::set_var("HOME", watched_root_dir.path());
        let refreshed_again = list_projects(&roots, &index_db);
        if let Some(value) = prior_home {
            std::env::set_var("HOME", value);
        } else {
            std::env::remove_var("HOME");
        }
        let refreshed_again = refreshed_again?;
        assert_eq!(refreshed_again.len(), 2);
        assert!(refreshed_again
            .iter()
            .any(|summary| summary.root.ends_with("/watched/repo-two")));
        Ok(())
    }

    #[test]
    fn board_projection_filters_active_sessions_and_trims_recent_activity() -> Result<()> {
        let repo = create_real_repo("parallel-project")?;
        let index_db = Path::new(&repo)
            .join(".app/index.sqlite")
            .display()
            .to_string();
        init_project(InitProjectInput {
            root: repo.clone(),
            actor: "tester".to_string(),
            source: ActivitySource::Cli,
            name: Some("Parallel".to_string()),
            kind: None,
            owner: None,
            tags: None,
            index_db_path: index_db.clone(),
        })?;

        let detail = get_project(&repo)?;
        let first_step_id = detail.plan.phases[0].steps[0].id.clone();
        let active = start_step(
            &repo,
            &first_step_id,
            MutationActor {
                actor: "agent-1".to_string(),
                source: ActivitySource::Agent,
            },
            SessionContextInput::default(),
            &index_db,
        )?;
        add_blocker(
            &repo,
            "Need sign-off",
            MutationActor {
                actor: "agent-1".to_string(),
                source: ActivitySource::Agent,
            },
            SessionContextInput::default(),
            &index_db,
        )?;

        let paths = get_workflow_paths(&repo);
        write_text_atomic(&paths.activity_path, "")?;
        for minute in [1, 6, 3, 5, 2, 4] {
            append_json_line(
                &paths.activity_path,
                &json!({
                    "timestamp": format!("2026-04-16T19:{minute:02}:00Z"),
                    "actor": "agent-1",
                    "source": "agent",
                    "project_id": active.manifest.id,
                    "session_id": active.sessions.first().map(|session| session.id.clone()),
                    "step_id": first_step_id,
                    "subtask_id": null,
                    "type": "note",
                    "summary": format!("Event {minute}"),
                    "payload": {}
                }),
            )?;
        }

        let mut paused = read_sessions(&repo)?;
        if let Some(session) = paused.sessions.first_mut() {
            session.status = SessionStatus::Paused;
        }
        paused.sessions.push(WorkflowSession {
            id: "active-session".to_string(),
            title: "Active session".to_string(),
            actor: "agent-2".to_string(),
            source: ActivitySource::Agent,
            branch: Some("main".to_string()),
            status: SessionStatus::Active,
            owned_step_id: Some(first_step_id.clone()),
            observed_step_ids: Vec::new(),
            started_at: "2026-04-16T19:00:00Z".to_string(),
            last_updated_at: "2026-04-16T19:07:00Z".to_string(),
        });
        write_yaml_atomic(paths.sessions_path, &paused)?;

        let board = get_board_project_detail(&repo)?;
        assert_eq!(
            board.root,
            fs::canonicalize(&repo)?.to_string_lossy().into_owned()
        );
        assert_eq!(board.sessions.len(), 1);
        assert_eq!(board.sessions[0].id, "active-session");
        assert_eq!(board.blockers, vec!["Need sign-off"]);
        assert_eq!(
            board.runtime_next_action,
            "Write the initial problem statement and success criteria."
        );
        assert_eq!(board.recent_activity.len(), 5);
        assert_eq!(
            board
                .recent_activity
                .iter()
                .map(|event| event.summary.clone())
                .collect::<Vec<_>>(),
            vec!["Event 6", "Event 5", "Event 4", "Event 3", "Event 2"]
        );
        assert_eq!(
            board.active_step_lookup.get(&first_step_id),
            Some(&BoardStepDetail {
                title: "Capture requirements".to_string(),
                summary: "Write the initial problem statement and success criteria.".to_string(),
            })
        );
        Ok(())
    }

    #[test]
    fn mutation_refresh_preserves_parent_watched_root_membership() -> Result<()> {
        let watched_root_dir = tempdir()?;
        let watched_root = watched_root_dir.path().join("watched");
        fs::create_dir_all(&watched_root)?;

        let repo = watched_root.join("repo-one");
        fs::create_dir_all(repo.join(".git"))?;
        fs::write(repo.join(".git/HEAD"), "ref: refs/heads/main\n")?;

        let index_db = watched_root.join(".app/index.sqlite").display().to_string();
        init_project(InitProjectInput {
            root: repo.display().to_string(),
            actor: "tester".to_string(),
            source: ActivitySource::Cli,
            name: Some("Repo One".to_string()),
            kind: None,
            owner: None,
            tags: None,
            index_db_path: index_db.clone(),
        })?;

        let roots = vec![watched_root.display().to_string()];
        assert_eq!(list_projects(&roots, &index_db)?.len(), 1);

        add_note(
            repo.display().to_string().as_str(),
            "Preserve watched root ownership",
            MutationActor {
                actor: "tester".to_string(),
                source: ActivitySource::Cli,
            },
            SessionContextInput::default(),
            &index_db,
        )?;

        let store = IndexStore::new(index_db)?;
        let canonical_repo = fs::canonicalize(&repo)?.to_string_lossy().into_owned();
        let canonical_watched_root = fs::canonicalize(&watched_root)?
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            store.project_watched_root(&canonical_repo)?,
            Some(canonical_watched_root)
        );
        Ok(())
    }
}
