use std::{env, path::PathBuf, process};

use anyhow::{anyhow, bail, Result};
use parallel_workflow_core::{
    accept_decision, add_blocker, add_note, append_activity_event, clear_blocker, complete_step,
    ensure_session, get_project, init_project, list_projects, propose_decision, refresh_handoff,
    start_step, sync_plan, update_runtime, ActivitySource, AppendActivityInput,
    DecisionProposalInput, EnsureSessionInput, InitProjectInput, MutationActor, PlanSyncPhaseInput,
    PlanSyncStepInput, PlanSyncSubtaskInput, RuntimePatchInput, SessionContextInput, SyncPlanInput,
};
use serde_json::{Map, Value};

type JsonValue = Value;

#[derive(Debug, Default)]
struct ParsedArgs {
    positionals: Vec<String>,
    flags: std::collections::HashMap<String, String>,
    booleans: std::collections::HashSet<String>,
}

fn parse_args(argv: &[String]) -> ParsedArgs {
    let mut parsed = ParsedArgs::default();
    let mut index = 0;
    while index < argv.len() {
        let token = &argv[index];
        if !token.starts_with("--") {
            parsed.positionals.push(token.clone());
            index += 1;
            continue;
        }

        let trimmed = &token[2..];
        if let Some((name, value)) = trimmed.split_once('=') {
            parsed.flags.insert(name.to_string(), value.to_string());
            index += 1;
            continue;
        }

        let next = argv.get(index + 1);
        if next.is_none() || next.unwrap().starts_with("--") {
            parsed.booleans.insert(trimmed.to_string());
            index += 1;
            continue;
        }

        parsed.flags.insert(trimmed.to_string(), next.unwrap().clone());
        index += 2;
    }
    parsed
}

fn flag(parsed: &ParsedArgs, name: &str) -> Option<String> {
    parsed.flags.get(name).cloned()
}

fn required_flag(parsed: &ParsedArgs, name: &str) -> Result<String> {
    flag(parsed, name).ok_or_else(|| anyhow!("Missing required flag --{name}"))
}

fn resolve_source(raw: Option<String>) -> ActivitySource {
    match raw.as_deref().unwrap_or("cli") {
        "cli" => ActivitySource::Cli,
        "mcp" => ActivitySource::Mcp,
        "desktop" => ActivitySource::Desktop,
        "agent" => ActivitySource::Agent,
        "human" => ActivitySource::Human,
        "system" => ActivitySource::System,
        _ => ActivitySource::Cli,
    }
}

fn resolve_actor(parsed: &ParsedArgs) -> MutationActor {
    MutationActor {
        actor: flag(parsed, "actor").unwrap_or_else(|| "projectctl".to_string()),
        source: resolve_source(flag(parsed, "source")),
    }
}

fn resolve_session_context(parsed: &ParsedArgs) -> SessionContextInput {
    SessionContextInput {
        session_id: flag(parsed, "session-id"),
        session_title: flag(parsed, "session-title"),
        branch: flag(parsed, "branch"),
    }
}

fn resolve_root(parsed: &ParsedArgs) -> String {
    let root = flag(parsed, "root")
        .map(PathBuf::from)
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    root.canonicalize().unwrap_or(root).to_string_lossy().into_owned()
}

fn resolve_index_db(parsed: &ParsedArgs) -> Option<String> {
    flag(parsed, "index-db").or_else(|| env::var("PROJECT_WORKFLOW_INDEX_DB").ok())
}

fn resolve_roots(parsed: &ParsedArgs) -> Vec<String> {
    if parsed.positionals.len() > 1 {
        return parsed.positionals[1..]
            .iter()
            .map(|root| {
                let path = PathBuf::from(root);
                path.canonicalize().unwrap_or(path).to_string_lossy().into_owned()
            })
            .collect();
    }
    if let Ok(env_roots) = env::var("PROJECT_WORKFLOW_WATCH_ROOTS") {
        return env_roots
            .split(if cfg!(windows) { ';' } else { ':' })
            .map(str::trim)
            .filter(|root| !root.is_empty())
            .map(|root| {
                let path = PathBuf::from(root);
                path.canonicalize().unwrap_or(path).to_string_lossy().into_owned()
            })
            .collect();
    }
    vec![env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .to_string_lossy()
        .into_owned()]
}

fn print_result(value: &impl serde::Serialize, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(value)?);
    } else {
        println!("{}", serde_json::to_string_pretty(value)?);
    }
    Ok(())
}

fn ensure_human_authority(parsed: &ParsedArgs) -> Result<()> {
    let source = flag(parsed, "source");
    if source.as_deref() == Some("human") || env::var("PROJECT_WORKFLOW_ALLOW_HUMAN_ACTIONS").ok().as_deref() == Some("1") {
        return Ok(());
    }
    bail!("decision accept requires explicit human authority via --source human")
}

fn phase_inputs_from_json(value: &Value) -> Result<Vec<PlanSyncPhaseInput>> {
    let phases = if let Some(array) = value.as_array() {
        array.clone()
    } else {
        value.get("phases")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| anyhow!("--plan must be a JSON array of phases or an object with phases"))?
    };

    phases
        .into_iter()
        .map(|phase| {
            let title = phase.get("title").and_then(Value::as_str).ok_or_else(|| anyhow!("phase title is required"))?;
            let steps = phase
                .get("steps")
                .and_then(Value::as_array)
                .ok_or_else(|| anyhow!("phase steps are required"))?
                .iter()
                .map(|step| {
                    let title = step.get("title").and_then(Value::as_str).ok_or_else(|| anyhow!("step title is required"))?;
                    let subtasks = step
                        .get("subtasks")
                        .and_then(Value::as_array)
                        .map(|items| {
                            items
                                .iter()
                                .map(|subtask| PlanSyncSubtaskInput {
                                    id: subtask.get("id").and_then(Value::as_str).map(ToString::to_string),
                                    title: subtask.get("title").and_then(Value::as_str).unwrap_or_default().to_string(),
                                    status: match subtask.get("status").and_then(Value::as_str) {
                                        Some("done") => Some(parallel_workflow_core::SubtaskStatus::Done),
                                        Some("todo") => Some(parallel_workflow_core::SubtaskStatus::Todo),
                                        _ => None,
                                    },
                                })
                                .collect::<Vec<_>>()
                        });
                    Ok(PlanSyncStepInput {
                        id: step.get("id").and_then(Value::as_str).map(ToString::to_string),
                        title: title.to_string(),
                        summary: step.get("summary").and_then(Value::as_str).map(ToString::to_string),
                        details: step.get("details").and_then(Value::as_array).map(|items| {
                            items.iter().filter_map(Value::as_str).map(ToString::to_string).collect()
                        }),
                        depends_on: step.get("depends_on").and_then(Value::as_array).map(|items| {
                            items.iter().filter_map(Value::as_str).map(ToString::to_string).collect()
                        }),
                        subtasks,
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            Ok(PlanSyncPhaseInput {
                id: phase.get("id").and_then(Value::as_str).map(ToString::to_string),
                title: title.to_string(),
                steps,
            })
        })
        .collect()
}

fn main() {
    if let Err(error) = run() {
        let argv: Vec<String> = env::args().skip(1).collect();
        let parsed = parse_args(&argv);
        if parsed.booleans.contains("json") {
            eprintln!("{}", serde_json::json!({ "error": error.to_string() }));
        } else {
            eprintln!("Error: {error}");
        }
        process::exit(1);
    }
}

fn run() -> Result<()> {
    let argv: Vec<String> = env::args().skip(1).collect();
    let parsed = parse_args(&argv);
    let command = parsed.positionals.get(0).cloned();
    let subcommand = parsed.positionals.get(1).cloned();
    let json = parsed.booleans.contains("json");
    let actor = resolve_actor(&parsed);
    let session_context = resolve_session_context(&parsed);
    let index_db_path = resolve_index_db(&parsed);

    match command.as_deref() {
        Some("init") => {
            let project = init_project(InitProjectInput {
                root: resolve_root(&parsed),
                actor: actor.actor,
                source: actor.source,
                name: flag(&parsed, "name"),
                kind: flag(&parsed, "kind").or_else(|| Some("software".to_string())),
                owner: flag(&parsed, "owner"),
                tags: flag(&parsed, "tags").map(|tags| tags.split(',').map(|tag| tag.trim().to_string()).filter(|tag| !tag.is_empty()).collect()),
                index_db_path,
            })?;
            print_result(&project, json)
        }
        Some("list") => {
            let projects = list_projects(&resolve_roots(&parsed), index_db_path.as_deref())?;
            print_result(&projects, json)
        }
        Some("show") => {
            let project = get_project(&resolve_root(&parsed))?;
            print_result(&project, json)
        }
        Some("step") => {
            let step_id = parsed.positionals.get(2).cloned().ok_or_else(|| anyhow!("Missing step id"))?;
            let result = if subcommand.as_deref() == Some("start") {
                start_step(&resolve_root(&parsed), &step_id, actor, session_context, index_db_path.as_deref())?
            } else {
                complete_step(&resolve_root(&parsed), &step_id, actor, session_context, index_db_path.as_deref())?
            };
            print_result(&result, json)
        }
        Some("blocker") => {
            let summary = if parsed.positionals.len() > 2 {
                parsed.positionals[2..].join(" ")
            } else {
                flag(&parsed, "summary").unwrap_or_default()
            };
            let result = if subcommand.as_deref() == Some("add") {
                if summary.trim().is_empty() {
                    bail!("Missing blocker summary");
                }
                add_blocker(&resolve_root(&parsed), &summary, actor, session_context, index_db_path.as_deref())?
            } else {
                clear_blocker(
                    &resolve_root(&parsed),
                    if summary.trim().is_empty() { None } else { Some(summary.as_str()) },
                    actor,
                    session_context,
                    index_db_path.as_deref(),
                )?
            };
            print_result(&result, json)
        }
        Some("note") => {
            let summary = if parsed.positionals.len() > 2 {
                parsed.positionals[2..].join(" ")
            } else {
                flag(&parsed, "summary").unwrap_or_default()
            };
            if summary.trim().is_empty() {
                bail!("Missing note summary");
            }
            let result = add_note(&resolve_root(&parsed), &summary, actor, session_context, index_db_path.as_deref())?;
            print_result(&result, json)
        }
        Some("session") => {
            if subcommand.as_deref() != Some("ensure") {
                bail!("Unknown session subcommand \"{}\"", subcommand.unwrap_or_default());
            }
            let result = ensure_session(EnsureSessionInput {
                root: resolve_root(&parsed),
                actor: actor.actor,
                source: actor.source,
                session_id: session_context.session_id,
                session_title: session_context.session_title,
                branch: session_context.branch,
                index_db_path,
            })?;
            print_result(&result, json)
        }
        Some("plan") => {
            if subcommand.as_deref() != Some("sync") {
                bail!("Unknown plan subcommand \"{}\"", subcommand.unwrap_or_default());
            }
            let plan_arg = required_flag(&parsed, "plan")?;
            let parsed_plan: JsonValue = serde_json::from_str(&plan_arg)?;
            let phases = phase_inputs_from_json(&parsed_plan)?;
            let result = sync_plan(SyncPlanInput {
                root: resolve_root(&parsed),
                actor: actor.actor,
                source: actor.source,
                session_id: session_context.session_id,
                session_title: session_context.session_title,
                branch: session_context.branch,
                phases,
                index_db_path,
            })?;
            print_result(&result, json)
        }
        Some("activity") => {
            if subcommand.as_deref() != Some("add") {
                bail!("Unknown activity subcommand \"{}\"", subcommand.unwrap_or_default());
            }
            let event_type = required_flag(&parsed, "type")?;
            let summary = if parsed.positionals.len() > 2 {
                parsed.positionals[2..].join(" ")
            } else {
                flag(&parsed, "summary").unwrap_or_default()
            };
            if summary.trim().is_empty() {
                bail!("Missing activity summary");
            }
            let payload = flag(&parsed, "payload")
                .map(|raw| serde_json::from_str(&raw))
                .transpose()?;
            let result = append_activity_event(
                &resolve_root(&parsed),
                AppendActivityInput {
                    actor: actor.actor,
                    source: actor.source,
                    session_id: session_context.session_id,
                    session_title: session_context.session_title,
                    branch: session_context.branch,
                    event_type,
                    summary,
                    payload,
                    step_id: flag(&parsed, "step-id"),
                    subtask_id: flag(&parsed, "subtask-id"),
                    index_db_path: index_db_path.clone(),
                },
                index_db_path.as_deref(),
            )?;
            print_result(&result, json)
        }
        Some("handoff") => {
            let result = refresh_handoff(&resolve_root(&parsed), actor, index_db_path.as_deref())?;
            print_result(&result, json)
        }
        Some("decision") => {
            if subcommand.as_deref() == Some("propose") {
                let result = propose_decision(
                    &resolve_root(&parsed),
                    DecisionProposalInput {
                        title: required_flag(&parsed, "title")?,
                        context: flag(&parsed, "context").unwrap_or_default(),
                        decision: flag(&parsed, "decision").unwrap_or_default(),
                        impact: flag(&parsed, "impact").unwrap_or_default(),
                    },
                    actor,
                    session_context,
                    index_db_path.as_deref(),
                )?;
                return print_result(&result, json);
            }
            if subcommand.as_deref() == Some("accept") {
                ensure_human_authority(&parsed)?;
                let proposal_id = parsed.positionals.get(2).cloned().or_else(|| flag(&parsed, "proposal-id")).ok_or_else(|| anyhow!("Missing proposal id"))?;
                let result = accept_decision(&resolve_root(&parsed), &proposal_id, actor, index_db_path.as_deref())?;
                return print_result(&result, json);
            }
            bail!("Unknown decision subcommand \"{}\"", subcommand.unwrap_or_default());
        }
        Some("runtime") => {
            let patch_raw = required_flag(&parsed, "patch")?;
            let patch_value: Value = serde_json::from_str(&patch_raw)?;
            let patch_map: Map<String, Value> = patch_value
                .as_object()
                .cloned()
                .ok_or_else(|| anyhow!("--patch JSON must be an object"))?;
            let result = update_runtime(RuntimePatchInput {
                root: resolve_root(&parsed),
                actor: actor.actor,
                source: actor.source,
                patch: patch_map,
                summary: flag(&parsed, "summary").unwrap_or_else(|| "Updated runtime state".to_string()),
                event_type: flag(&parsed, "event-type"),
                index_db_path,
            })?;
            print_result(&result, json)
        }
        _ => {
            let commands = serde_json::json!({
              "commands": [
                "projectctl init [--root PATH] [--name NAME]",
                "projectctl list [ROOT ...]",
                "projectctl show [--root PATH]",
                "projectctl step start <step-id> [--root PATH]",
                "projectctl step done <step-id> [--root PATH]",
                "projectctl session ensure [--root PATH]",
                "projectctl plan sync --plan JSON [--root PATH]",
                "projectctl activity add --type TYPE [--summary TEXT] [--root PATH]",
                "projectctl blocker add <summary> [--root PATH]",
                "projectctl blocker clear [summary] [--root PATH]",
                "projectctl note add <summary> [--root PATH]",
                "projectctl handoff refresh [--root PATH]",
                "projectctl decision propose --title TITLE --context TEXT --decision TEXT --impact TEXT [--root PATH]"
              ]
            });
            print_result(&commands, true)?;
            process::exit(if command.is_some() { 1 } else { 0 });
        }
    }
}
