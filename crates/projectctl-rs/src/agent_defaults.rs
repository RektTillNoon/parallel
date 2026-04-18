use std::{
    collections::BTreeSet,
    env, fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use toml_edit::{value, DocumentMut, Item, Table};

const MANAGED_BLOCK_START: &str = "<!-- parallel-agent-defaults:v1:start -->";
const MANAGED_BLOCK_END: &str = "<!-- parallel-agent-defaults:v1:end -->";
const CODEX_TOKEN_ENV_VAR: &str = "PARALLEL_MCP_TOKEN";
const PARALLEL_SERVER_NAME: &str = "parallel";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ClientKind {
    Codex,
    ClaudeCode,
    ClaudeDesktop,
}

impl ClientKind {
    pub const ALL: [ClientKind; 3] = [
        ClientKind::Codex,
        ClientKind::ClaudeCode,
        ClientKind::ClaudeDesktop,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ClientKind::Codex => "codex",
            ClientKind::ClaudeCode => "claudeCode",
            ClientKind::ClaudeDesktop => "claudeDesktop",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            ClientKind::Codex => "Codex",
            ClientKind::ClaudeCode => "Claude Code",
            ClientKind::ClaudeDesktop => "Claude Desktop",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallScope {
    Global,
    Repo,
    Both,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallStatus {
    Installed,
    Missing,
    Stale,
    Unsupported,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallAction {
    Install,
    Update,
    Reinstall,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentScopeStatus {
    pub scope: String,
    pub status: InstallStatus,
    pub reasons: Vec<String>,
    pub changed_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentTargetStatus {
    pub kind: String,
    pub label: String,
    pub status: InstallStatus,
    pub reasons: Vec<String>,
    pub global: Option<AgentScopeStatus>,
    pub repo: Option<AgentScopeStatus>,
    pub changed_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BridgeSnippet {
    pub kind: String,
    pub label: String,
    pub content: String,
    pub copy_label: String,
    pub notes: String,
    pub stale: bool,
}

#[derive(Debug, Clone, Default)]
pub struct AgentDefaultsContext {
    pub repo_root: Option<PathBuf>,
    pub bridge_url: Option<String>,
    pub bridge_token: Option<String>,
    pub projectctl_command_path: Option<PathBuf>,
    pub path_env: Option<String>,
    pub home_dir: Option<PathBuf>,
    pub appdata_dir: Option<PathBuf>,
}

#[derive(Debug, Clone)]
struct SurfaceStatus {
    status: InstallStatus,
    reasons: Vec<String>,
}

fn installed() -> SurfaceStatus {
    SurfaceStatus {
        status: InstallStatus::Installed,
        reasons: Vec::new(),
    }
}

fn missing() -> SurfaceStatus {
    SurfaceStatus {
        status: InstallStatus::Missing,
        reasons: Vec::new(),
    }
}

fn stale(reason: &str) -> SurfaceStatus {
    SurfaceStatus {
        status: InstallStatus::Stale,
        reasons: vec![reason.to_string()],
    }
}

fn error(reason: &str) -> SurfaceStatus {
    SurfaceStatus {
        status: InstallStatus::Error,
        reasons: vec![reason.to_string()],
    }
}

pub fn stable_projectctl_install_path(path_env: Option<&str>, home_dir: &Path) -> PathBuf {
    let binary_name = if cfg!(target_os = "windows") {
        "projectctl.exe"
    } else {
        "projectctl"
    };
    let home_bin = home_dir.join("bin");
    if path_entries(path_env).iter().any(|entry| entry == &home_bin) {
        return home_bin.join(binary_name);
    }

    let local_bin = home_dir.join(".local").join("bin");
    if path_entries(path_env).iter().any(|entry| entry == &local_bin) {
        return local_bin.join(binary_name);
    }

    if cfg!(target_os = "macos") {
        return home_bin.join(binary_name);
    }

    local_bin.join(binary_name)
}

pub fn inspect_agent_defaults(
    context: &AgentDefaultsContext,
    kind: ClientKind,
    scope: InstallScope,
) -> Result<AgentTargetStatus, String> {
    let repo_root = resolved_repo_root(context, scope)?;
    let global = match scope {
        InstallScope::Global | InstallScope::Both => Some(inspect_global(context, kind, repo_root.as_deref())?),
        InstallScope::Repo => None,
    };
    let repo = match scope {
        InstallScope::Repo | InstallScope::Both => Some(inspect_repo(context, repo_root.as_deref())?),
        InstallScope::Global => None,
    };
    Ok(build_target_status(kind, global, repo))
}

pub fn apply_agent_defaults(
    context: &AgentDefaultsContext,
    kind: ClientKind,
    scope: InstallScope,
    action: InstallAction,
) -> Result<AgentTargetStatus, String> {
    let repo_root = resolved_repo_root(context, scope)?;
    let initial = inspect_agent_defaults(context, kind, scope)?;

    if matches!(scope, InstallScope::Global | InstallScope::Both) {
        if let Some(global) = &initial.global {
            if should_apply(global.status, action) {
                apply_global(context, kind, repo_root.as_deref())?;
            }
        }
    }

    if matches!(scope, InstallScope::Repo | InstallScope::Both) {
        if let Some(repo_status) = &initial.repo {
            if should_apply(repo_status.status, action) {
                apply_repo(context, repo_root.as_deref())?;
            }
        }
    }

    let mut next = inspect_agent_defaults(context, kind, scope)?;
    next.changed_paths = changed_paths_for(kind, scope, context, repo_root.as_deref())?;
    if let Some(global) = next.global.as_mut() {
        if matches!(scope, InstallScope::Global | InstallScope::Both)
            && should_apply(initial.global.as_ref().map(|item| item.status).unwrap_or(InstallStatus::Installed), action)
        {
            global.changed_paths = global_paths_for(kind, context, repo_root.as_deref())?;
        }
    }
    if let Some(repo_status) = next.repo.as_mut() {
        if matches!(scope, InstallScope::Repo | InstallScope::Both)
            && should_apply(initial.repo.as_ref().map(|item| item.status).unwrap_or(InstallStatus::Installed), action)
        {
            repo_status.changed_paths = repo_paths_for(context, repo_root.as_deref())?;
        }
    }
    Ok(next)
}

pub fn build_client_snippet(
    kind: ClientKind,
    bridge_url: &str,
    bridge_token: &str,
    projectctl_path: &Path,
    stale: bool,
) -> Result<BridgeSnippet, String> {
    match kind {
        ClientKind::Codex => Ok(BridgeSnippet {
            kind: kind.as_str().to_string(),
            label: "Codex setup".to_string(),
            copy_label: "Copy Codex setup".to_string(),
            notes: "Direct streamable HTTP MCP setup for Codex.".to_string(),
            stale,
            content: format!(
                "export PARALLEL_MCP_TOKEN='{bridge_token}'\ncodex mcp add parallel --url {bridge_url} --bearer-token-env-var PARALLEL_MCP_TOKEN"
            ),
        }),
        ClientKind::ClaudeCode => Ok(BridgeSnippet {
            kind: kind.as_str().to_string(),
            label: "Claude Code setup".to_string(),
            copy_label: "Copy Claude Code setup".to_string(),
            notes: "Direct streamable HTTP MCP setup for Claude Code.".to_string(),
            stale,
            content: format!(
                "claude mcp add --scope user --transport http parallel {bridge_url} --header \"Authorization: Bearer {bridge_token}\""
            ),
        }),
        ClientKind::ClaudeDesktop => Ok(BridgeSnippet {
            kind: kind.as_str().to_string(),
            label: "Claude Desktop setup".to_string(),
            copy_label: "Copy Claude Desktop setup".to_string(),
            notes: "Use the stable projectctl proxy command.".to_string(),
            stale,
            content: serde_json::to_string_pretty(&serde_json::json!({
                "mcpServers": {
                    "parallel": {
                        "command": projectctl_path.display().to_string(),
                        "args": ["mcp", "proxy-stdio", "--url", bridge_url, "--token", bridge_token]
                    }
                }
            }))
            .map_err(|error| error.to_string())?,
        }),
    }
}

fn should_apply(status: InstallStatus, action: InstallAction) -> bool {
    match action {
        InstallAction::Install => status == InstallStatus::Missing,
        InstallAction::Update => status == InstallStatus::Stale,
        InstallAction::Reinstall => status != InstallStatus::Error,
    }
}

fn resolved_repo_root(
    context: &AgentDefaultsContext,
    scope: InstallScope,
) -> Result<Option<PathBuf>, String> {
    if matches!(scope, InstallScope::Repo | InstallScope::Both) && context.repo_root.is_none() {
        return Err("--repo is required for repo or both scope".to_string());
    }
    Ok(context.repo_root.as_ref().map(|path| canonicalize(path)))
}

fn inspect_global(
    context: &AgentDefaultsContext,
    kind: ClientKind,
    repo_root: Option<&Path>,
) -> Result<AgentScopeStatus, String> {
    let surface_statuses = match kind {
        ClientKind::Codex => inspect_codex_global(context)?,
        ClientKind::ClaudeCode => inspect_claude_code_global(context, repo_root)?,
        ClientKind::ClaudeDesktop => inspect_claude_desktop_global(context)?,
    };
    Ok(to_scope_status("global", surface_statuses))
}

fn inspect_repo(
    _context: &AgentDefaultsContext,
    repo_root: Option<&Path>,
) -> Result<AgentScopeStatus, String> {
    let repo_root = repo_root.ok_or_else(|| "--repo is required".to_string())?;
    if is_parallel_product_repo(repo_root)? {
        return Ok(AgentScopeStatus {
            scope: "repo".to_string(),
            status: InstallStatus::Installed,
            reasons: vec!["repo_manages_parallel_guidance".to_string()],
            changed_paths: Vec::new(),
        });
    }

    let agents_path = repo_root.join("AGENTS.md");
    let body = fs::read_to_string(&agents_path).ok();
    let text_status = inspect_managed_text(body.as_deref(), repo_text_body());
    Ok(AgentScopeStatus {
        scope: "repo".to_string(),
        status: text_status.status,
        reasons: text_status.reasons,
        changed_paths: Vec::new(),
    })
}

fn apply_global(
    context: &AgentDefaultsContext,
    kind: ClientKind,
    repo_root: Option<&Path>,
) -> Result<(), String> {
    match kind {
        ClientKind::Codex => apply_codex_global(context),
        ClientKind::ClaudeCode => apply_claude_code_global(context, repo_root),
        ClientKind::ClaudeDesktop => apply_claude_desktop_global(context),
    }
}

fn apply_repo(_context: &AgentDefaultsContext, repo_root: Option<&Path>) -> Result<(), String> {
    let repo_root = repo_root.ok_or_else(|| "--repo is required".to_string())?;
    if is_parallel_product_repo(repo_root)? {
        return Ok(());
    }
    let path = repo_root.join("AGENTS.md");
    write_managed_text(&path, repo_text_body())
}

fn inspect_codex_global(context: &AgentDefaultsContext) -> Result<Vec<SurfaceStatus>, String> {
    let home = home_dir(context)?;
    let url = required_bridge_url(context)?;
    let config_path = home.join(".codex").join("config.toml");
    let config_status = inspect_codex_config(&config_path, url)?;
    let agents_path = home.join(".codex").join("AGENTS.md");
    let text_status = inspect_managed_text(fs::read_to_string(&agents_path).ok().as_deref(), global_text_body());
    Ok(vec![config_status, text_status])
}

fn inspect_claude_code_global(
    context: &AgentDefaultsContext,
    repo_root: Option<&Path>,
) -> Result<Vec<SurfaceStatus>, String> {
    let home = home_dir(context)?;
    let url = required_bridge_url(context)?;
    let token = required_bridge_token(context)?;
    let config_path = home.join(".claude.json");
    let config_status = inspect_claude_code_config(&config_path, repo_root, url, token)?;
    let instructions_path = home.join(".claude").join("CLAUDE.md");
    let text_status =
        inspect_managed_text(fs::read_to_string(&instructions_path).ok().as_deref(), global_text_body());
    Ok(vec![config_status, text_status])
}

fn inspect_claude_desktop_global(context: &AgentDefaultsContext) -> Result<Vec<SurfaceStatus>, String> {
    let url = required_bridge_url(context)?;
    let token = required_bridge_token(context)?;
    let projectctl_path = required_projectctl_command_path(context)?;
    let mut statuses = Vec::new();
    if !projectctl_path.exists() {
        statuses.push(stale("stable_projectctl_not_installed"));
    } else {
        let config_path = claude_desktop_config_path(context)?;
        statuses.push(inspect_claude_desktop_config(
            &config_path,
            url,
            token,
            &projectctl_path,
        )?);
    }
    Ok(statuses)
}

fn apply_codex_global(context: &AgentDefaultsContext) -> Result<(), String> {
    let home = home_dir(context)?;
    let url = required_bridge_url(context)?;
    let config_path = home.join(".codex").join("config.toml");
    write_codex_config(&config_path, url)?;
    write_managed_text(&home.join(".codex").join("AGENTS.md"), global_text_body())
}

fn apply_claude_code_global(
    context: &AgentDefaultsContext,
    repo_root: Option<&Path>,
) -> Result<(), String> {
    let home = home_dir(context)?;
    let url = required_bridge_url(context)?;
    let token = required_bridge_token(context)?;
    let config_path = home.join(".claude.json");
    write_claude_code_config(&config_path, repo_root, url, token)?;
    write_managed_text(&home.join(".claude").join("CLAUDE.md"), global_text_body())
}

fn apply_claude_desktop_global(context: &AgentDefaultsContext) -> Result<(), String> {
    let url = required_bridge_url(context)?;
    let token = required_bridge_token(context)?;
    let projectctl_path = required_projectctl_command_path(context)?;
    if !projectctl_path.exists() {
        return Err("Stable projectctl install is required for Claude Desktop".to_string());
    }
    let config_path = claude_desktop_config_path(context)?;
    write_claude_desktop_config(&config_path, url, token, &projectctl_path)
}

fn inspect_codex_config(path: &Path, expected_url: &str) -> Result<SurfaceStatus, String> {
    if !path.exists() {
        return Ok(missing());
    }
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let doc = raw.parse::<DocumentMut>().map_err(|error| error.to_string())?;
    let Some(servers) = doc.get("mcp_servers").and_then(Item::as_table_like) else {
        return Ok(missing());
    };

    for (name, item) in servers.iter() {
        if name == PARALLEL_SERVER_NAME {
            continue;
        }
        let Some(url) = item
            .as_table_like()
            .and_then(|table| table.get("url"))
            .and_then(Item::as_str)
        else {
            continue;
        };
        if url == expected_url {
            return Ok(error("parallel_name_collision"));
        }
    }

    let Some(parallel) = servers.get(PARALLEL_SERVER_NAME).and_then(Item::as_table_like) else {
        return Ok(missing());
    };
    let url = parallel.get("url").and_then(Item::as_str);
    let env_var = parallel
        .get("bearer_token_env_var")
        .and_then(Item::as_str);
    if url == Some(expected_url) && env_var == Some(CODEX_TOKEN_ENV_VAR) {
        return Ok(installed());
    }
    Ok(stale("shape_mismatch"))
}

fn write_codex_config(path: &Path, expected_url: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let raw = fs::read_to_string(path).unwrap_or_default();
    let mut doc = if raw.trim().is_empty() {
        DocumentMut::new()
    } else {
        raw.parse::<DocumentMut>().map_err(|error| error.to_string())?
    };
    if doc.get("mcp_servers").is_none() {
        doc["mcp_servers"] = Item::Table(Table::new());
    }
    if doc["mcp_servers"]
        .as_table_like()
        .and_then(|table| table.get(PARALLEL_SERVER_NAME))
        .and_then(Item::as_table_like)
        .is_none()
    {
        doc["mcp_servers"][PARALLEL_SERVER_NAME] = Item::Table(Table::new());
    }
    doc["mcp_servers"][PARALLEL_SERVER_NAME]["url"] = value(expected_url);
    doc["mcp_servers"][PARALLEL_SERVER_NAME]["bearer_token_env_var"] = value(CODEX_TOKEN_ENV_VAR);
    fs::write(path, doc.to_string()).map_err(|error| error.to_string())
}

fn inspect_claude_code_config(
    path: &Path,
    repo_root: Option<&Path>,
    expected_url: &str,
    expected_token: &str,
) -> Result<SurfaceStatus, String> {
    if !path.exists() {
        return Ok(missing());
    }
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let value: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    let root = value
        .as_object()
        .ok_or_else(|| "Expected ~/.claude.json to contain a JSON object".to_string())?;

    if has_matching_named_collision(
        root.get("mcpServers").and_then(Value::as_object),
        expected_url,
        None,
    ) {
        return Ok(error("parallel_name_collision"));
    }

    if let Some(user_entry) = root
        .get("mcpServers")
        .and_then(Value::as_object)
        .and_then(|servers| servers.get(PARALLEL_SERVER_NAME))
    {
        return if matches_claude_code_entry(user_entry, expected_url, expected_token) {
            Ok(installed())
        } else {
            Ok(stale("shape_mismatch"))
        };
    }

    if let Some(repo_root) = repo_root {
        if let Some(local_entry) = find_claude_project(root.get("projects"), repo_root)
            .and_then(|project| project.get("mcpServers"))
            .and_then(Value::as_object)
            .and_then(|servers| servers.get(PARALLEL_SERVER_NAME))
        {
            return if matches_claude_code_entry(local_entry, expected_url, expected_token) {
                Ok(stale("legacy_local_scope"))
            } else {
                Ok(stale("shape_mismatch"))
            };
        }
    }

    Ok(missing())
}

fn write_claude_code_config(
    path: &Path,
    repo_root: Option<&Path>,
    expected_url: &str,
    expected_token: &str,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let raw = fs::read_to_string(path).unwrap_or_else(|_| "{}".to_string());
    let mut value: Value = if raw.trim().is_empty() {
        Value::Object(Map::new())
    } else {
        serde_json::from_str(&raw).map_err(|error| error.to_string())?
    };

    ensure_json_object(&mut value)?;
    let servers = ensure_child_object(&mut value, "mcpServers")?;
    servers.insert(
        PARALLEL_SERVER_NAME.to_string(),
        canonical_claude_code_entry(expected_url, expected_token),
    );

    if let Some(repo_root) = repo_root {
        remove_claude_local_entry(&mut value, repo_root);
    }

    fs::write(path, format_json(&value)?).map_err(|error| error.to_string())
}

fn inspect_claude_desktop_config(
    path: &Path,
    expected_url: &str,
    expected_token: &str,
    projectctl_path: &Path,
) -> Result<SurfaceStatus, String> {
    if !path.exists() {
        return Ok(missing());
    }
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let value: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    let root = value
        .as_object()
        .ok_or_else(|| "Expected Claude Desktop config to contain a JSON object".to_string())?;
    let expected_args = canonical_claude_desktop_args(expected_url, expected_token);

    if has_matching_named_collision(
        root.get("mcpServers").and_then(Value::as_object),
        "",
        Some((&projectctl_path.to_string_lossy(), &expected_args)),
    ) {
        return Ok(error("parallel_name_collision"));
    }

    let Some(parallel) = root
        .get("mcpServers")
        .and_then(Value::as_object)
        .and_then(|servers| servers.get(PARALLEL_SERVER_NAME))
    else {
        return Ok(missing());
    };
    if matches_claude_desktop_entry(parallel, projectctl_path, &expected_args) {
        return Ok(installed());
    }
    Ok(stale("shape_mismatch"))
}

fn write_claude_desktop_config(
    path: &Path,
    expected_url: &str,
    expected_token: &str,
    projectctl_path: &Path,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let raw = fs::read_to_string(path).unwrap_or_else(|_| "{}".to_string());
    let mut value: Value = if raw.trim().is_empty() {
        Value::Object(Map::new())
    } else {
        serde_json::from_str(&raw).map_err(|error| error.to_string())?
    };
    ensure_json_object(&mut value)?;
    let servers = ensure_child_object(&mut value, "mcpServers")?;
    servers.insert(
        PARALLEL_SERVER_NAME.to_string(),
        serde_json::json!({
            "command": projectctl_path.display().to_string(),
            "args": canonical_claude_desktop_args(expected_url, expected_token),
        }),
    );
    fs::write(path, format_json(&value)?).map_err(|error| error.to_string())
}

fn has_matching_named_collision(
    servers: Option<&Map<String, Value>>,
    expected_url: &str,
    expected_command: Option<(&str, &Vec<String>)>,
) -> bool {
    let Some(servers) = servers else {
        return false;
    };
    servers.iter().any(|(name, entry)| {
        if name == PARALLEL_SERVER_NAME {
            return false;
        }
        if !expected_url.is_empty()
            && entry
                .get("url")
                .and_then(Value::as_str)
                .map(|url| url == expected_url)
                .unwrap_or(false)
        {
            return true;
        }
        if let Some((expected_command, expected_args)) = expected_command {
            let command_matches = entry
                .get("command")
                .and_then(Value::as_str)
                .map(|command| command == expected_command)
                .unwrap_or(false);
            let args_matches = entry
                .get("args")
                .and_then(Value::as_array)
                .map(|args| {
                    args.iter()
                        .filter_map(Value::as_str)
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                        == *expected_args
                })
                .unwrap_or(false);
            if command_matches && args_matches {
                return true;
            }
        }
        false
    })
}

fn matches_claude_code_entry(entry: &Value, expected_url: &str, expected_token: &str) -> bool {
    entry
        .get("type")
        .and_then(Value::as_str)
        .map(|kind| kind == "http")
        .unwrap_or(false)
        && entry
            .get("url")
            .and_then(Value::as_str)
            .map(|url| url == expected_url)
            .unwrap_or(false)
        && entry
            .get("headers")
            .and_then(Value::as_object)
            .and_then(|headers| headers.get("Authorization"))
            .and_then(Value::as_str)
            .map(|header| header == format!("Bearer {expected_token}"))
            .unwrap_or(false)
}

fn canonical_claude_code_entry(expected_url: &str, expected_token: &str) -> Value {
    serde_json::json!({
        "type": "http",
        "url": expected_url,
        "headers": {
            "Authorization": format!("Bearer {expected_token}")
        }
    })
}

fn canonical_claude_desktop_args(expected_url: &str, expected_token: &str) -> Vec<String> {
    vec![
        "mcp".to_string(),
        "proxy-stdio".to_string(),
        "--url".to_string(),
        expected_url.to_string(),
        "--token".to_string(),
        expected_token.to_string(),
    ]
}

fn matches_claude_desktop_entry(
    entry: &Value,
    projectctl_path: &Path,
    expected_args: &[String],
) -> bool {
    entry
        .get("command")
        .and_then(Value::as_str)
        .map(|command| command == projectctl_path.to_string_lossy())
        .unwrap_or(false)
        && entry
            .get("args")
            .and_then(Value::as_array)
            .map(|args| {
                args.iter()
                    .filter_map(Value::as_str)
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    == expected_args
            })
            .unwrap_or(false)
}

fn remove_claude_local_entry(value: &mut Value, repo_root: &Path) {
    let Some(projects) = value.get_mut("projects").and_then(Value::as_object_mut) else {
        return;
    };
    let Some(project_key) = projects
        .keys()
        .find(|key| canonicalize(Path::new(key)) == repo_root)
        .cloned()
    else {
        return;
    };
    let Some(project) = projects.get_mut(&project_key).and_then(Value::as_object_mut) else {
        return;
    };
    let Some(servers) = project.get_mut("mcpServers").and_then(Value::as_object_mut) else {
        return;
    };
    servers.remove(PARALLEL_SERVER_NAME);
}

fn find_claude_project<'a>(
    projects: Option<&'a Value>,
    repo_root: &Path,
) -> Option<&'a Map<String, Value>> {
    projects
        .and_then(Value::as_object)
        .and_then(|projects| {
            projects
                .iter()
                .find(|(path, _)| canonicalize(Path::new(path)) == repo_root)
                .map(|(_, value)| value)
        })
        .and_then(Value::as_object)
}

fn to_scope_status(scope: &str, surfaces: Vec<SurfaceStatus>) -> AgentScopeStatus {
    let status = combine_surface_statuses(&surfaces);
    let reasons = surfaces
        .into_iter()
        .flat_map(|surface| surface.reasons)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    AgentScopeStatus {
        scope: scope.to_string(),
        status,
        reasons,
        changed_paths: Vec::new(),
    }
}

fn build_target_status(
    kind: ClientKind,
    global: Option<AgentScopeStatus>,
    repo: Option<AgentScopeStatus>,
) -> AgentTargetStatus {
    let statuses = [global.as_ref(), repo.as_ref()]
        .into_iter()
        .flatten()
        .map(|item| item.status)
        .collect::<Vec<_>>();
    let status = combine_statuses(&statuses);
    let reasons = [global.as_ref(), repo.as_ref()]
        .into_iter()
        .flatten()
        .flat_map(|item| item.reasons.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    AgentTargetStatus {
        kind: kind.as_str().to_string(),
        label: kind.label().to_string(),
        status,
        reasons,
        global,
        repo,
        changed_paths: Vec::new(),
    }
}

fn combine_surface_statuses(statuses: &[SurfaceStatus]) -> InstallStatus {
    combine_statuses(&statuses.iter().map(|status| status.status).collect::<Vec<_>>())
}

fn combine_statuses(statuses: &[InstallStatus]) -> InstallStatus {
    if statuses.iter().any(|status| *status == InstallStatus::Error) {
        return InstallStatus::Error;
    }
    if statuses.iter().any(|status| *status == InstallStatus::Stale) {
        return InstallStatus::Stale;
    }
    if statuses.iter().any(|status| *status == InstallStatus::Missing) {
        return InstallStatus::Missing;
    }
    if statuses.iter().any(|status| *status == InstallStatus::Unsupported) {
        return InstallStatus::Unsupported;
    }
    InstallStatus::Installed
}

fn inspect_managed_text(existing: Option<&str>, body: &str) -> SurfaceStatus {
    let Some(existing) = existing else {
        return missing();
    };
    let expected = managed_block(body);
    match find_managed_block(existing) {
        Some(block) if block == expected => installed(),
        Some(_) => stale("managed_block_outdated"),
        None => missing(),
    }
}

fn write_managed_text(path: &Path, body: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let next = upsert_managed_block(fs::read_to_string(path).ok().as_deref(), body);
    fs::write(path, next).map_err(|error| error.to_string())
}

fn managed_block(body: &str) -> String {
    format!(
        "{MANAGED_BLOCK_START}\n{}\n{MANAGED_BLOCK_END}\n",
        body.trim_end()
    )
}

fn find_managed_block(existing: &str) -> Option<String> {
    let start = existing.find(MANAGED_BLOCK_START)?;
    let end = existing.find(MANAGED_BLOCK_END)?;
    let end_index = end + MANAGED_BLOCK_END.len();
    let mut block = existing[start..end_index].to_string();
    block.push('\n');
    Some(block)
}

fn upsert_managed_block(existing: Option<&str>, body: &str) -> String {
    let expected = managed_block(body);
    let Some(existing) = existing else {
        return expected;
    };
    let Some(start) = existing.find(MANAGED_BLOCK_START) else {
        let mut next = existing.trim_end().to_string();
        if !next.is_empty() {
            next.push_str("\n\n");
        }
        next.push_str(&expected);
        return next;
    };
    let Some(end) = existing.find(MANAGED_BLOCK_END) else {
        let mut next = existing.trim_end().to_string();
        next.push_str("\n\n");
        next.push_str(&expected);
        return next;
    };
    let end_index = end + MANAGED_BLOCK_END.len();
    let before = &existing[..start];
    let after = &existing[end_index..];
    let mut next = before.to_string();
    next.push_str(&expected);
    if !after.starts_with('\n') {
        next.push('\n');
    }
    next.push_str(after.trim_start_matches('\n'));
    next
}

fn global_text_body() -> &'static str {
    "When a task is about workflow state rather than code implementation, use Parallel through MCP or projectctl before proceeding.\n\nUse this sequence unless the task is clearly read-only:\n1. list_projects\n2. get_project\n3. ensure_session\n4. claim or start a step only when actively executing it\n5. append activity, blockers, and handoff through Parallel\n\nDo not edit workflow files directly unless repairing broken state.\nDo not use Parallel when modifying the Parallel product itself."
}

fn repo_text_body() -> &'static str {
    "Workflow state in this repo is managed through Parallel.\nUse Parallel MCP or projectctl for current step, sessions, blockers, notes, decisions, and handoff instead of editing workflow files directly."
}

fn home_dir(context: &AgentDefaultsContext) -> Result<PathBuf, String> {
    context
        .home_dir
        .clone()
        .or_else(|| env::var_os("HOME").map(PathBuf::from))
        .ok_or_else(|| "HOME is not set".to_string())
}

fn claude_desktop_config_path(context: &AgentDefaultsContext) -> Result<PathBuf, String> {
    if cfg!(target_os = "windows") {
        let base = context
            .appdata_dir
            .clone()
            .or_else(|| env::var_os("APPDATA").map(PathBuf::from))
            .ok_or_else(|| "APPDATA is not set".to_string())?;
        return Ok(base.join("Claude").join("claude_desktop_config.json"));
    }

    let home = home_dir(context)?;
    if cfg!(target_os = "macos") {
        return Ok(home
            .join("Library")
            .join("Application Support")
            .join("Claude")
            .join("claude_desktop_config.json"));
    }

    Ok(home
        .join(".config")
        .join("Claude")
        .join("claude_desktop_config.json"))
}

fn required_bridge_url<'a>(context: &'a AgentDefaultsContext) -> Result<&'a str, String> {
    context
        .bridge_url
        .as_deref()
        .ok_or_else(|| "--url is required".to_string())
}

fn required_bridge_token<'a>(context: &'a AgentDefaultsContext) -> Result<&'a str, String> {
    context
        .bridge_token
        .as_deref()
        .ok_or_else(|| "--token is required".to_string())
}

fn required_projectctl_command_path(context: &AgentDefaultsContext) -> Result<PathBuf, String> {
    context
        .projectctl_command_path
        .clone()
        .ok_or_else(|| "--projectctl-path is required".to_string())
}

fn ensure_json_object(value: &mut Value) -> Result<&mut Map<String, Value>, String> {
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    value
        .as_object_mut()
        .ok_or_else(|| "Expected JSON object".to_string())
}

fn ensure_child_object<'a>(
    value: &'a mut Value,
    key: &str,
) -> Result<&'a mut Map<String, Value>, String> {
    let object = ensure_json_object(value)?;
    if !object.contains_key(key) || !object.get(key).map(Value::is_object).unwrap_or(false) {
        object.insert(key.to_string(), Value::Object(Map::new()));
    }
    object
        .get_mut(key)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| format!("Expected object at key {key}"))
}

fn format_json(value: &Value) -> Result<String, String> {
    serde_json::to_string_pretty(value).map_err(|error| error.to_string())
}

fn path_entries(path_env: Option<&str>) -> Vec<PathBuf> {
    path_env
        .unwrap_or_default()
        .split(if cfg!(target_os = "windows") { ';' } else { ':' })
        .filter(|entry| !entry.is_empty())
        .map(PathBuf::from)
        .collect()
}

fn canonicalize(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn is_parallel_product_repo(repo_root: &Path) -> Result<bool, String> {
    let mut cursor = Some(repo_root);
    while let Some(current) = cursor {
        let cargo_toml = current.join("Cargo.toml");
        if cargo_toml.exists() {
            let raw = fs::read_to_string(&cargo_toml).map_err(|error| error.to_string())?;
            let doc = raw.parse::<DocumentMut>().map_err(|error| error.to_string())?;
            if let Some(workspace) = doc.get("workspace").and_then(Item::as_table_like) {
                let has_member = workspace
                    .get("members")
                    .and_then(Item::as_array)
                    .map(|members| {
                        members.iter().any(|member| {
                            member
                                .as_str()
                                .map(|value| value == "crates/projectctl-rs")
                                .unwrap_or(false)
                        })
                    })
                    .unwrap_or(false);
                if !has_member {
                    return Ok(false);
                }
                let member_cargo = current.join("crates").join("projectctl-rs").join("Cargo.toml");
                if !member_cargo.exists() {
                    return Ok(false);
                }
                let member_raw =
                    fs::read_to_string(member_cargo).map_err(|error| error.to_string())?;
                let member_doc =
                    member_raw.parse::<DocumentMut>().map_err(|error| error.to_string())?;
                let package_name = member_doc
                    .get("package")
                    .and_then(Item::as_table_like)
                    .and_then(|package| package.get("name"))
                    .and_then(Item::as_str);
                return Ok(package_name == Some("parallel-projectctl"));
            }
        }
        cursor = current.parent();
    }
    Ok(false)
}

fn changed_paths_for(
    kind: ClientKind,
    scope: InstallScope,
    context: &AgentDefaultsContext,
    repo_root: Option<&Path>,
) -> Result<Vec<String>, String> {
    let mut paths = BTreeSet::new();
    if matches!(scope, InstallScope::Global | InstallScope::Both) {
        for path in global_paths_for(kind, context, repo_root)? {
            paths.insert(path);
        }
    }
    if matches!(scope, InstallScope::Repo | InstallScope::Both) {
        for path in repo_paths_for(context, repo_root)? {
            paths.insert(path);
        }
    }
    Ok(paths.into_iter().collect())
}

fn global_paths_for(
    kind: ClientKind,
    context: &AgentDefaultsContext,
    _repo_root: Option<&Path>,
) -> Result<Vec<String>, String> {
    let home = home_dir(context)?;
    match kind {
        ClientKind::Codex => Ok(vec![
            home.join(".codex").join("config.toml").to_string_lossy().into_owned(),
            home.join(".codex").join("AGENTS.md").to_string_lossy().into_owned(),
        ]),
        ClientKind::ClaudeCode => Ok(vec![
            home.join(".claude.json").to_string_lossy().into_owned(),
            home.join(".claude").join("CLAUDE.md").to_string_lossy().into_owned(),
        ]),
        ClientKind::ClaudeDesktop => Ok(vec![
            claude_desktop_config_path(context)?
                .to_string_lossy()
                .into_owned(),
        ]),
    }
}

fn repo_paths_for(
    _context: &AgentDefaultsContext,
    repo_root: Option<&Path>,
) -> Result<Vec<String>, String> {
    let repo_root = repo_root.ok_or_else(|| "--repo is required".to_string())?;
    if is_parallel_product_repo(repo_root)? {
        return Ok(Vec::new());
    }
    Ok(vec![repo_root.join("AGENTS.md").to_string_lossy().into_owned()])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn unique_temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "parallel-agent-defaults-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time before epoch")
                .as_nanos()
        ))
    }

    #[test]
    fn codex_snippet_uses_env_var_indirection() {
        let snippet = build_client_snippet(
            ClientKind::Codex,
            "http://127.0.0.1:4855/mcp",
            "token-123",
            Path::new("/Users/light/bin/projectctl"),
            false,
        )
        .expect("snippet should build");

        assert!(snippet.content.contains("bearer-token-env-var PARALLEL_MCP_TOKEN"));
    }

    #[test]
    fn claude_code_snippet_uses_user_scope() {
        let snippet = build_client_snippet(
            ClientKind::ClaudeCode,
            "http://127.0.0.1:4855/mcp",
            "token-123",
            Path::new("/Users/light/bin/projectctl"),
            false,
        )
        .expect("snippet should build");

        assert!(snippet.content.contains("--scope user"));
    }

    #[test]
    fn stable_cli_path_prefers_visible_home_bin() {
        let home = PathBuf::from("/tmp/test-home");
        let path = stable_projectctl_install_path(Some("/usr/bin:/tmp/test-home/bin"), &home);
        assert_eq!(path, home.join("bin").join("projectctl"));
    }

    #[test]
    fn repo_scope_skips_parallel_repo() {
        let base = unique_temp_dir("parallel-skip");
        let repo = base.join("parallel");
        fs::create_dir_all(repo.join("crates/projectctl-rs/src")).expect("repo should create");
        fs::write(
            repo.join("Cargo.toml"),
            "[workspace]\nmembers = [\"crates/projectctl-rs\"]\nresolver = \"2\"\n",
        )
        .expect("workspace cargo should write");
        fs::write(
            repo.join("crates/projectctl-rs/Cargo.toml"),
            "[package]\nname = \"parallel-projectctl\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )
        .expect("member cargo should write");
        fs::write(repo.join("AGENTS.md"), "do not touch\n").expect("agents should write");

        let status = inspect_agent_defaults(
            &AgentDefaultsContext {
                repo_root: Some(repo.clone()),
                ..AgentDefaultsContext::default()
            },
            ClientKind::Codex,
            InstallScope::Repo,
        )
        .expect("status should inspect");

        assert_eq!(status.status, InstallStatus::Installed);
        assert!(status
            .reasons
            .iter()
            .any(|reason| reason == "repo_manages_parallel_guidance"));
        assert_eq!(
            fs::read_to_string(repo.join("AGENTS.md")).expect("agents should read"),
            "do not touch\n"
        );
    }

    #[test]
    fn codex_install_preserves_existing_comments() {
        let base = unique_temp_dir("codex-comments");
        let home = base.join("home");
        fs::create_dir_all(home.join(".codex")).expect("codex dir should create");
        fs::write(
            home.join(".codex/config.toml"),
            "# keep me\n[mcp_servers.other]\nurl = \"http://example.test\"\n",
        )
        .expect("config should write");

        let status = apply_agent_defaults(
            &AgentDefaultsContext {
                home_dir: Some(home),
                bridge_url: Some("http://127.0.0.1:4855/mcp".to_string()),
                bridge_token: Some("token".to_string()),
                ..AgentDefaultsContext::default()
            },
            ClientKind::Codex,
            InstallScope::Global,
            InstallAction::Install,
        )
        .expect("install should succeed");

        assert_eq!(status.status, InstallStatus::Installed);
        let updated = fs::read_to_string(base.join("home/.codex/config.toml"))
            .expect("updated config should read");
        assert!(updated.contains("# keep me"));
        assert!(updated.contains("[mcp_servers.parallel]"));
        assert!(updated.contains("bearer_token_env_var = \"PARALLEL_MCP_TOKEN\""));
    }

    #[test]
    fn stale_on_shape_mismatch_for_parallel_entry() {
        let base = unique_temp_dir("shape-mismatch");
        let home = base.join("home");
        fs::create_dir_all(home.join(".codex")).expect("codex dir should create");
        fs::write(
            home.join(".codex/config.toml"),
            "[mcp_servers.parallel]\ncommand = \"projectctl\"\n",
        )
        .expect("config should write");

        let status = inspect_agent_defaults(
            &AgentDefaultsContext {
                home_dir: Some(home),
                bridge_url: Some("http://127.0.0.1:4855/mcp".to_string()),
                bridge_token: Some("token".to_string()),
                ..AgentDefaultsContext::default()
            },
            ClientKind::Codex,
            InstallScope::Global,
        )
        .expect("status should inspect");

        assert_eq!(status.status, InstallStatus::Stale);
        assert!(status.reasons.iter().any(|reason| reason == "shape_mismatch"));
    }

    #[test]
    fn claude_code_user_scope_entry_is_recognized_as_installed() {
        let base = unique_temp_dir("claude-user");
        let home = base.join("home");
        fs::create_dir_all(home.join(".claude")).expect("claude dir should create");
        fs::write(
            home.join(".claude.json"),
            serde_json::to_string_pretty(&serde_json::json!({
                "mcpServers": {
                    "parallel": {
                        "type": "http",
                        "url": "http://127.0.0.1:4855/mcp",
                        "headers": {
                            "Authorization": "Bearer token"
                        }
                    }
                }
            }))
            .expect("json should serialize"),
        )
        .expect("claude config should write");
        fs::write(home.join(".claude/CLAUDE.md"), managed_block(global_text_body()))
            .expect("claude instructions should write");

        let status = inspect_agent_defaults(
            &AgentDefaultsContext {
                home_dir: Some(home),
                bridge_url: Some("http://127.0.0.1:4855/mcp".to_string()),
                bridge_token: Some("token".to_string()),
                ..AgentDefaultsContext::default()
            },
            ClientKind::ClaudeCode,
            InstallScope::Global,
        )
        .expect("status should inspect");

        assert_eq!(status.status, InstallStatus::Installed);
    }

    #[test]
    fn claude_code_local_scope_is_reported_as_legacy() {
        let base = unique_temp_dir("claude-local");
        let home = base.join("home");
        let repo = base.join("repo");
        fs::create_dir_all(home.join(".claude")).expect("claude dir should create");
        fs::create_dir_all(&repo).expect("repo should create");
        fs::write(
            home.join(".claude.json"),
            serde_json::to_string_pretty(&serde_json::json!({
                "projects": {
                    repo.to_string_lossy().to_string(): {
                        "mcpServers": {
                            "parallel": {
                                "type": "http",
                                "url": "http://127.0.0.1:4855/mcp",
                                "headers": {
                                    "Authorization": "Bearer token"
                                }
                            }
                        }
                    }
                }
            }))
            .expect("json should serialize"),
        )
        .expect("claude config should write");

        let status = inspect_agent_defaults(
            &AgentDefaultsContext {
                home_dir: Some(home),
                repo_root: Some(repo),
                bridge_url: Some("http://127.0.0.1:4855/mcp".to_string()),
                bridge_token: Some("token".to_string()),
                ..AgentDefaultsContext::default()
            },
            ClientKind::ClaudeCode,
            InstallScope::Global,
        )
        .expect("status should inspect");

        assert_eq!(status.status, InstallStatus::Stale);
        assert!(status.reasons.iter().any(|reason| reason == "legacy_local_scope"));
    }

    #[test]
    fn update_promotes_matching_claude_local_scope_to_user_scope() {
        let base = unique_temp_dir("claude-promote");
        let home = base.join("home");
        let repo = base.join("repo");
        fs::create_dir_all(home.join(".claude")).expect("claude dir should create");
        fs::create_dir_all(&repo).expect("repo should create");
        fs::write(
            home.join(".claude.json"),
            serde_json::to_string_pretty(&serde_json::json!({
                "projects": {
                    repo.to_string_lossy().to_string(): {
                        "mcpServers": {
                            "parallel": {
                                "type": "http",
                                "url": "http://127.0.0.1:4855/mcp",
                                "headers": {
                                    "Authorization": "Bearer token"
                                }
                            }
                        }
                    }
                }
            }))
            .expect("json should serialize"),
        )
        .expect("claude config should write");

        let status = apply_agent_defaults(
            &AgentDefaultsContext {
                home_dir: Some(home.clone()),
                repo_root: Some(repo.clone()),
                bridge_url: Some("http://127.0.0.1:4855/mcp".to_string()),
                bridge_token: Some("token".to_string()),
                ..AgentDefaultsContext::default()
            },
            ClientKind::ClaudeCode,
            InstallScope::Global,
            InstallAction::Update,
        )
        .expect("update should succeed");

        assert_eq!(status.status, InstallStatus::Installed);
        let updated: Value = serde_json::from_str(
            &fs::read_to_string(home.join(".claude.json")).expect("updated config should read"),
        )
        .expect("updated config should parse");
        assert!(updated
            .get("mcpServers")
            .and_then(Value::as_object)
            .and_then(|servers| servers.get("parallel"))
            .is_some());
        assert!(updated
            .get("projects")
            .and_then(Value::as_object)
            .and_then(|projects| projects.get(repo.to_string_lossy().as_ref()))
            .and_then(Value::as_object)
            .and_then(|project| project.get("mcpServers"))
            .and_then(Value::as_object)
            .and_then(|servers| servers.get("parallel"))
            .is_none());
    }

    #[test]
    fn error_on_name_collision_for_matching_endpoint() {
        let base = unique_temp_dir("collision");
        let home = base.join("home");
        fs::create_dir_all(home.join(".codex")).expect("codex dir should create");
        fs::write(
            home.join(".codex/config.toml"),
            "[mcp_servers.paper]\nurl = \"http://127.0.0.1:4855/mcp\"\n",
        )
        .expect("config should write");

        let status = inspect_agent_defaults(
            &AgentDefaultsContext {
                home_dir: Some(home),
                bridge_url: Some("http://127.0.0.1:4855/mcp".to_string()),
                ..AgentDefaultsContext::default()
            },
            ClientKind::Codex,
            InstallScope::Global,
        )
        .expect("status should inspect");

        assert_eq!(status.status, InstallStatus::Error);
        assert!(status
            .reasons
            .iter()
            .any(|reason| reason == "parallel_name_collision"));
    }

    #[test]
    fn claude_desktop_path_matches_current_platform_contract() {
        let base = unique_temp_dir("desktop-path");
        let context = AgentDefaultsContext {
            home_dir: Some(base.join("home")),
            appdata_dir: Some(base.join("appdata")),
            ..AgentDefaultsContext::default()
        };
        let path = claude_desktop_config_path(&context).expect("path should resolve");

        #[cfg(target_os = "macos")]
        assert!(path.ends_with("Library/Application Support/Claude/claude_desktop_config.json"));
        #[cfg(target_os = "linux")]
        assert!(path.ends_with(".config/Claude/claude_desktop_config.json"));
        #[cfg(target_os = "windows")]
        assert!(path.ends_with("Claude/claude_desktop_config.json"));
    }
}
