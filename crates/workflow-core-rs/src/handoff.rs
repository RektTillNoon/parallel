use crate::models::{ActivityEvent, DecisionProposal, Manifest, Plan, RuntimeState, SessionStatus, WorkflowSession};
use crate::services::find_current_step_title;

pub struct HandoffInput {
    pub manifest: Manifest,
    pub plan: Plan,
    pub runtime: RuntimeState,
    pub sessions: Vec<WorkflowSession>,
    pub activity: Vec<ActivityEvent>,
    pub proposals: Vec<DecisionProposal>,
}

pub fn generate_handoff(input: &HandoffInput) -> String {
    let current_step = find_current_step_title(&input.plan, input.runtime.current_step_id.as_deref());
    let recent_activity: Vec<ActivityEvent> = input.activity.iter().rev().take(8).cloned().collect();
    let active_sessions: Vec<WorkflowSession> = input
        .sessions
        .iter()
        .filter(|session| session.status == SessionStatus::Active)
        .cloned()
        .collect();

    let mut lines = vec![
        "# Project Handoff".to_string(),
        String::new(),
        "## Current state".to_string(),
        format!("- Project: {}", input.manifest.name),
        format!("- Status: {:?}", input.runtime.status).to_lowercase().replace("stepstatus::", "- Status: "),
        format!("- Current step: {}", current_step.unwrap_or_else(|| "None".to_string())),
        format!(
            "- Next action: {}",
            if input.runtime.next_action.is_empty() {
                "No next action recorded."
            } else {
                &input.runtime.next_action
            }
        ),
        format!(
            "- Active branch: {}",
            input.runtime
                .active_branch
                .clone()
                .unwrap_or_else(|| "Unknown".to_string())
        ),
        format!("- Last updated: {}", input.runtime.last_updated_at),
        String::new(),
        "## Active sessions".to_string(),
    ];

    if active_sessions.is_empty() {
        lines.push("- None.".to_string());
    } else {
        for session in active_sessions {
            let owner = session
                .owned_step_id
                .as_ref()
                .map(|step_id| format!(" -> {step_id}"))
                .unwrap_or_default();
            lines.push(format!(
                "- {} ({}/{:?}){}",
                session.title,
                session.actor,
                session.source,
                owner
            ).replace("ActivitySource::", ""));
        }
    }

    lines.push(String::new());
    lines.push("## What changed".to_string());
    if recent_activity.is_empty() {
        lines.push("- No recent activity.".to_string());
    } else {
        for event in recent_activity {
            let mut context = Vec::new();
            if let Some(session_id) = event.session_id {
                context.push(session_id);
            }
            if let Some(step_id) = event.step_id {
                context.push(step_id);
            }
            let suffix = if context.is_empty() {
                String::new()
            } else {
                format!(" | {}", context.join(" / "))
            };
            lines.push(format!(
                "- {}: {} ({}/{:?}{})",
                event.timestamp,
                event.summary,
                event.actor,
                event.source,
                suffix
            ).replace("ActivitySource::", ""));
        }
    }

    lines.push(String::new());
    lines.push("## Blockers".to_string());
    if input.runtime.blockers.is_empty() {
        lines.push("- None.".to_string());
    } else {
        for blocker in &input.runtime.blockers {
            lines.push(format!("- {blocker}"));
        }
    }

    lines.push(String::new());
    lines.push("## Open questions".to_string());
    if input.proposals.is_empty() {
        lines.push("- None.".to_string());
    } else {
        for proposal in &input.proposals {
            lines.push(format!("- Review proposal: {}", proposal.title));
        }
    }

    format!("{}\n", lines.join("\n"))
}
