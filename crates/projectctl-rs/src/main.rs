mod mcp;

use std::{env, path::PathBuf, process};

use anyhow::{anyhow, bail, Result};
use parallel_workflow_core::{
    accept_decision, add_blocker, add_note, append_activity_event, clear_blocker, complete_step,
    canonical_index_db_path, ensure_session, get_project, init_project, list_projects,
    propose_decision, refresh_handoff, resolve_index_db_path, resolve_watched_roots, start_step,
    sync_plan, update_runtime, ActivitySource, AppendActivityInput, RootResolutionSurface,
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

fn split_comma_values(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn positional_tail_or_flag(parsed: &ParsedArgs, start_index: usize, flag_name: &str) -> String {
    if parsed.positionals.len() > start_index {
        parsed.positionals[start_index..].join(" ")
    } else {
        flag(parsed, flag_name).unwrap_or_default()
    }
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

fn resolve_index_db(parsed: &ParsedArgs) -> Result<String> {
    resolve_index_db_path(
        flag(parsed, "index-db").as_deref(),
        env::var("PROJECT_WORKFLOW_INDEX_DB").ok().as_deref(),
    )
}

fn resolve_roots(parsed: &ParsedArgs, index_db_path: &str) -> Result<Vec<String>> {
    let explicit_roots = if parsed.positionals.len() > 1 {
        Some(
            parsed.positionals[1..]
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>(),
        )
    } else {
        None
    };
    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    resolve_watched_roots(
        RootResolutionSurface::Cli,
        explicit_roots.as_deref(),
        env::var("PROJECT_WORKFLOW_WATCH_ROOTS").ok().as_deref(),
        index_db_path,
        Some(cwd.to_string_lossy().as_ref()),
    )
}

fn print_result(value: &impl serde::Serialize) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn ensure_human_authority(parsed: &ParsedArgs) -> Result<()> {
    let source = flag(parsed, "source");
    if source.as_deref() == Some("human") || env::var("PROJECT_WORKFLOW_ALLOW_HUMAN_ACTIONS").ok().as_deref() == Some("1") {
        return Ok(());
    }
    bail!("decision accept requires explicit human authority via --source human")
}

fn help_payload() -> JsonValue {
    let default_index_db = canonical_index_db_path().map(|path| path.to_string_lossy().into_owned());
    serde_json::json!({
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
        "projectctl decision propose --title TITLE --context TEXT --decision TEXT --impact TEXT [--root PATH]",
        "projectctl mcp serve-http --port PORT --token TOKEN",
        "projectctl mcp proxy-stdio --url URL --token TOKEN"
      ],
      "indexDb": {
        "flag": "--index-db",
        "envVar": "PROJECT_WORKFLOW_INDEX_DB",
        "defaultPath": default_index_db,
        "precedence": [
          "--index-db",
          "PROJECT_WORKFLOW_INDEX_DB",
          "canonical default path"
        ]
      }
    })
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

fn resolve_serve_http_roots(parsed: &ParsedArgs) -> Vec<String> {
    flag(parsed, "roots")
        .map(|raw| split_comma_values(&raw))
        .or_else(|| {
            env::var("PROJECT_WORKFLOW_WATCH_ROOTS").ok().map(|raw| {
                raw.split(if cfg!(windows) { ';' } else { ':' })
                    .map(str::trim)
                    .filter(|root| !root.is_empty())
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
            })
        })
        .unwrap_or_default()
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
    let actor = resolve_actor(&parsed);
    let session_context = resolve_session_context(&parsed);
    let index_db_path = resolve_index_db(&parsed)?;

    match command.as_deref() {
        Some("mcp") => match subcommand.as_deref() {
            Some("serve-http") => {
                let port = required_flag(&parsed, "port")?.parse::<u16>()?;
                let token = required_flag(&parsed, "token")?;
                let watched_roots = resolve_serve_http_roots(&parsed);

                let runtime = tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .build()?;
                runtime.block_on(mcp::run_serve_http(mcp::ServeHttpConfig {
                    port,
                    token,
                    watched_roots,
                    index_db_path,
                }))
            }
            Some("proxy-stdio") => {
                let url = required_flag(&parsed, "url")?;
                let token = required_flag(&parsed, "token")?;
                mcp::run_proxy_stdio(mcp::ProxyStdioConfig { url, token })
            }
            _ => bail!("Unknown mcp subcommand \"{}\"", subcommand.unwrap_or_default()),
        },
        Some("init") => {
            let root = resolve_root(&parsed);
            let project = init_project(InitProjectInput {
                root,
                actor: actor.actor,
                source: actor.source,
                name: flag(&parsed, "name"),
                kind: flag(&parsed, "kind").or_else(|| Some("software".to_string())),
                owner: flag(&parsed, "owner"),
                tags: flag(&parsed, "tags").map(|tags| split_comma_values(&tags)),
                index_db_path,
            })?;
            print_result(&project)
        }
        Some("list") => {
            let projects = list_projects(&resolve_roots(&parsed, &index_db_path)?, &index_db_path)?;
            print_result(&projects)
        }
        Some("show") => {
            let root = resolve_root(&parsed);
            let project = get_project(&root)?;
            print_result(&project)
        }
        Some("step") => {
            let root = resolve_root(&parsed);
            let step_id = parsed.positionals.get(2).cloned().ok_or_else(|| anyhow!("Missing step id"))?;
            let result = if subcommand.as_deref() == Some("start") {
                start_step(&root, &step_id, actor, session_context, &index_db_path)?
            } else {
                complete_step(&root, &step_id, actor, session_context, &index_db_path)?
            };
            print_result(&result)
        }
        Some("blocker") => {
            let root = resolve_root(&parsed);
            let summary = positional_tail_or_flag(&parsed, 2, "summary");
            let result = if subcommand.as_deref() == Some("add") {
                if summary.trim().is_empty() {
                    bail!("Missing blocker summary");
                }
                add_blocker(&root, &summary, actor, session_context, &index_db_path)?
            } else {
                clear_blocker(
                    &root,
                    if summary.trim().is_empty() { None } else { Some(summary.as_str()) },
                    actor,
                    session_context,
                    &index_db_path,
                )?
            };
            print_result(&result)
        }
        Some("note") => {
            let root = resolve_root(&parsed);
            let summary = positional_tail_or_flag(&parsed, 2, "summary");
            if summary.trim().is_empty() {
                bail!("Missing note summary");
            }
            let result = add_note(&root, &summary, actor, session_context, &index_db_path)?;
            print_result(&result)
        }
        Some("session") => {
            if subcommand.as_deref() != Some("ensure") {
                bail!("Unknown session subcommand \"{}\"", subcommand.unwrap_or_default());
            }
            let root = resolve_root(&parsed);
            let result = ensure_session(EnsureSessionInput {
                root,
                actor: actor.actor,
                source: actor.source,
                session_id: session_context.session_id,
                session_title: session_context.session_title,
                branch: session_context.branch,
                index_db_path,
            })?;
            print_result(&result)
        }
        Some("plan") => {
            if subcommand.as_deref() != Some("sync") {
                bail!("Unknown plan subcommand \"{}\"", subcommand.unwrap_or_default());
            }
            let plan_arg = required_flag(&parsed, "plan")?;
            let parsed_plan: JsonValue = serde_json::from_str(&plan_arg)?;
            let phases = phase_inputs_from_json(&parsed_plan)?;
            let root = resolve_root(&parsed);
            let result = sync_plan(SyncPlanInput {
                root,
                actor: actor.actor,
                source: actor.source,
                session_id: session_context.session_id,
                session_title: session_context.session_title,
                branch: session_context.branch,
                phases,
                index_db_path,
            })?;
            print_result(&result)
        }
        Some("activity") => {
            if subcommand.as_deref() != Some("add") {
                bail!("Unknown activity subcommand \"{}\"", subcommand.unwrap_or_default());
            }
            let root = resolve_root(&parsed);
            let event_type = required_flag(&parsed, "type")?;
            let summary = positional_tail_or_flag(&parsed, 2, "summary");
            if summary.trim().is_empty() {
                bail!("Missing activity summary");
            }
            let payload = flag(&parsed, "payload")
                .map(|raw| serde_json::from_str(&raw))
                .transpose()?;
            let result = append_activity_event(
                &root,
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
            )?;
            print_result(&result)
        }
        Some("handoff") => {
            let root = resolve_root(&parsed);
            let result = refresh_handoff(&root, actor, &index_db_path)?;
            print_result(&result)
        }
        Some("decision") => {
            let root = resolve_root(&parsed);
            if subcommand.as_deref() == Some("propose") {
                let result = propose_decision(
                    &root,
                    DecisionProposalInput {
                        title: required_flag(&parsed, "title")?,
                        context: flag(&parsed, "context").unwrap_or_default(),
                        decision: flag(&parsed, "decision").unwrap_or_default(),
                        impact: flag(&parsed, "impact").unwrap_or_default(),
                    },
                    actor,
                    session_context,
                    &index_db_path,
                )?;
                return print_result(&result);
            }
            if subcommand.as_deref() == Some("accept") {
                ensure_human_authority(&parsed)?;
                let proposal_id = parsed.positionals.get(2).cloned().or_else(|| flag(&parsed, "proposal-id")).ok_or_else(|| anyhow!("Missing proposal id"))?;
                let result = accept_decision(&root, &proposal_id, actor, &index_db_path)?;
                return print_result(&result);
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
            let root = resolve_root(&parsed);
            let result = update_runtime(RuntimePatchInput {
                root,
                actor: actor.actor,
                source: actor.source,
                patch: patch_map,
                summary: flag(&parsed, "summary").unwrap_or_else(|| "Updated runtime state".to_string()),
                event_type: flag(&parsed, "event-type"),
                index_db_path,
            })?;
            print_result(&result)
        }
        _ => {
            print_result(&help_payload())?;
            process::exit(if command.is_some() { 1 } else { 0 });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_index_db_prefers_flag_then_env_then_canonical_default() {
        assert_eq!(
            resolve_index_db_path(
                Some("/tmp/from-flag.sqlite"),
                Some("/tmp/from-env.sqlite"),
            )
            .expect("flag path should resolve"),
            "/tmp/from-flag.sqlite".to_string()
        );

        assert_eq!(
            resolve_index_db_path(None, Some("/tmp/from-env.sqlite"))
                .expect("env path should resolve"),
            "/tmp/from-env.sqlite".to_string()
        );

        assert_eq!(
            resolve_index_db_path(None, None).expect("default path should resolve"),
            canonical_index_db_path()
                .expect("canonical default should exist")
                .to_string_lossy()
                .into_owned()
        );
    }

    #[test]
    fn help_payload_describes_index_db_contract() {
        let payload = help_payload();

        assert_eq!(payload["indexDb"]["flag"], "--index-db");
        assert_eq!(payload["indexDb"]["envVar"], "PROJECT_WORKFLOW_INDEX_DB");
        assert_eq!(payload["indexDb"]["precedence"][0], "--index-db");
        assert!(payload["indexDb"]["defaultPath"].is_string() || payload["indexDb"]["defaultPath"].is_null());
    }

    #[test]
    fn split_comma_values_trims_and_drops_empty_entries() {
        assert_eq!(
            split_comma_values(" alpha, beta ,, gamma "),
            vec!["alpha".to_string(), "beta".to_string(), "gamma".to_string()]
        );
    }

    #[test]
    fn positional_tail_or_flag_prefers_positional_tail() {
        let parsed = ParsedArgs {
            positionals: vec!["note".to_string(), "add".to_string(), "from".to_string(), "tail".to_string()],
            flags: [("summary".to_string(), "from flag".to_string())].into_iter().collect(),
            booleans: Default::default(),
        };

        assert_eq!(positional_tail_or_flag(&parsed, 2, "summary"), "from tail");
    }
}
