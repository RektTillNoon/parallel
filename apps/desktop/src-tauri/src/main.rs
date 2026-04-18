#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;

use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    sync::mpsc,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use bridge::{
    bundled_sidecar_binary_filename, find_available_port, generate_token, resolve_bridge_url,
    resolve_bundled_projectctl_path,
    BridgeRuntimeSnapshot, BridgeSettings, BridgeStateEvent, BRIDGE_EVENT, DEFAULT_BRIDGE_PORT,
};
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use parallel_projectctl::{
    apply_agent_defaults, build_client_snippet, inspect_agent_defaults,
    stable_projectctl_install_path, AgentDefaultsContext, AgentTargetStatus, ClientKind,
    InstallAction, InstallScope, InstallStatus,
};
use parallel_workflow_core::{
    add_blocker, add_note, add_watched_root_index_state, canonical_index_db_path, clear_blocker,
    complete_step, get_board_project_detail, get_project as get_project_service,
    init_project as init_project_service, list_indexed_projects, list_projects,
    missing_watched_root_coverage, propose_decision, remove_watched_root_index_state,
    resolve_watched_roots, start_step, ActivitySource, BoardProjectDetail, DecisionProposalInput,
    InitProjectInput, MutationActor, ProjectSummary, RootResolutionSurface, SessionContextInput,
    CANONICAL_INDEX_DB_FILE,
};
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{MenuBuilder, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent, State,
};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tracing_subscriber::EnvFilter;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default)]
    watched_roots: Vec<String>,
    last_focused_project: Option<String>,
    #[serde(default)]
    mcp: BridgeSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PersistedSettings {
    last_focused_project: Option<String>,
    #[serde(default)]
    mcp: BridgeSettings,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadStatePayload {
    settings: Settings,
    projects: Vec<ProjectSummary>,
    board_projects: Vec<BoardProjectDetail>,
    mcp_runtime: BridgeRuntimeSnapshot,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CliInstallStatus {
    bundled_path: String,
    install_path: String,
    installed: bool,
    install_dir_on_path: bool,
    shell_profile_configured: bool,
    shell_export: String,
    shell_profile: String,
    persist_command: String,
}

#[derive(Clone)]
struct TrayMenuHandles {
    project: MenuItem<tauri::Wry>,
    step: MenuItem<tauri::Wry>,
    blockers: MenuItem<tauri::Wry>,
    next_action: MenuItem<tauri::Wry>,
}

struct AppState {
    settings_path: PathBuf,
    index_db_path: PathBuf,
    watcher: Mutex<Option<RecommendedWatcher>>,
    local_write_suppression: Mutex<HashMap<String, std::time::Instant>>,
    tray_handles: Mutex<Option<TrayMenuHandles>>,
    bridge: Mutex<BridgeSupervisor>,
}

struct BridgeSupervisor {
    child: Option<CommandChild>,
    child_pid: Option<u32>,
    stopping_pid: Option<u32>,
    runtime: BridgeRuntimeSnapshot,
}

const DESKTOP_ACTOR_ID: &str = "desktop-user";
const DEFAULT_PROJECT_KIND: &str = "software";
const WORKFLOW_TOPOLOGY_EVENT: &str = "workflow://topology-changed";
const WORKFLOW_SNAPSHOT_EVENT: &str = "workflow://snapshot-changed";
const LOCAL_WRITE_SUPPRESSION_WINDOW_MS: u64 = 1500;

fn app_support_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|error| error.to_string())
}

fn finalize_desktop_index_path(
    legacy_index_path: PathBuf,
    canonical_index_path: Option<PathBuf>,
) -> Result<PathBuf, String> {
    let resolved = canonical_index_path.unwrap_or_else(|| legacy_index_path.clone());
    if let Some(parent) = resolved.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    if resolved != legacy_index_path && legacy_index_path.exists() && !resolved.exists() {
        match fs::rename(&legacy_index_path, &resolved) {
            Ok(()) => {}
            Err(_) => {
                fs::copy(&legacy_index_path, &resolved).map_err(|error| error.to_string())?;
                fs::remove_file(&legacy_index_path).map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(resolved)
}

fn resolve_desktop_index_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let support_dir = app_support_dir(app)?;
    finalize_desktop_index_path(
        support_dir.join(CANONICAL_INDEX_DB_FILE),
        canonical_index_db_path(),
    )
}

fn ensure_settings(state: &AppState) -> Result<Settings, String> {
    if !state.settings_path.exists() {
        if let Some(parent) = state.settings_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let initial = serde_json::to_string_pretty(&PersistedSettings::default())
            .map_err(|error| error.to_string())?;
        fs::write(&state.settings_path, initial).map_err(|error| error.to_string())?;
    }

    let raw = fs::read_to_string(&state.settings_path).map_err(|error| error.to_string())?;
    let persisted: PersistedSettings =
        serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    let watched_roots = resolve_desktop_watched_roots(
        state,
        env::var("PROJECT_WORKFLOW_WATCH_ROOTS").ok().as_deref(),
    )?;
    Ok(Settings {
        watched_roots,
        last_focused_project: persisted.last_focused_project,
        mcp: persisted.mcp,
    })
}

fn resolve_desktop_watched_roots(
    state: &AppState,
    env_roots: Option<&str>,
) -> Result<Vec<String>, String> {
    let index_db_path = index_db_path_string(&state);
    resolve_watched_roots(
        RootResolutionSurface::Desktop,
        None,
        env_roots,
        index_db_path.as_str(),
        None,
    )
    .map_err(|error| error.to_string())
}

fn save_settings(state: &AppState, settings: &Settings) -> Result<(), String> {
    let body = serde_json::to_string_pretty(&PersistedSettings {
        last_focused_project: settings.last_focused_project.clone(),
        mcp: settings.mcp.clone(),
    })
    .map_err(|error| error.to_string())?;
    fs::write(&state.settings_path, body).map_err(|error| error.to_string())
}

fn canonicalize_path(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn canonicalize_path_string(raw: &str) -> String {
    canonicalize_path(Path::new(raw))
        .to_string_lossy()
        .into_owned()
}

fn path_is_root_or_descendant(candidate: &str, root: &str) -> bool {
    candidate == root || candidate.starts_with(&format!("{root}{}", std::path::MAIN_SEPARATOR))
}

fn workflow_dir_prefix(root: &str) -> String {
    format!("{root}{}{}", std::path::MAIN_SEPARATOR, ".project-workflow")
}

fn index_db_path_string(state: &AppState) -> String {
    state.index_db_path.to_string_lossy().into_owned()
}

fn user_home_dir() -> Result<PathBuf, String> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| "HOME is not set".to_string())
}

fn path_entries(raw: Option<&str>) -> Vec<PathBuf> {
    raw.unwrap_or_default()
        .split(if cfg!(windows) { ';' } else { ':' })
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .collect()
}

fn shell_profile_path(shell_env: Option<&str>, home_dir: &Path) -> PathBuf {
    let shell = shell_env.unwrap_or_default();
    if shell.contains("zsh") {
        return home_dir.join(".zshrc");
    }
    if shell.contains("bash") {
        return home_dir.join(".bashrc");
    }
    if shell.contains("fish") {
        return home_dir.join(".config").join("fish").join("config.fish");
    }
    home_dir.join(".profile")
}

fn display_home_relative(path: &Path, home_dir: &Path) -> String {
    path.strip_prefix(home_dir)
        .map(|relative| format!("$HOME/{}", relative.display()))
        .unwrap_or_else(|_| path.to_string_lossy().into_owned())
}

fn resolve_cli_install_path(path_env: Option<&str>, home_dir: &Path) -> PathBuf {
    stable_projectctl_install_path(path_env, home_dir)
}

fn install_dir_on_path(path_env: Option<&str>, install_path: &Path) -> bool {
    let Some(parent) = install_path.parent() else {
        return false;
    };
    path_entries(path_env).iter().any(|entry| entry == parent)
}

fn install_dir_variants(install_dir: &Path, home_dir: &Path) -> Vec<String> {
    let mut variants = vec![install_dir.to_string_lossy().into_owned()];
    if let Ok(relative) = install_dir.strip_prefix(home_dir) {
        let relative = relative.to_string_lossy();
        variants.push(format!("$HOME/{relative}"));
        variants.push(format!("~/{relative}"));
    }
    variants
}

fn shell_profile_configures_install_dir(
    shell_profile: &Path,
    install_path: &Path,
    home_dir: &Path,
) -> bool {
    let Some(install_dir) = install_path.parent() else {
        return false;
    };
    let Ok(contents) = fs::read_to_string(shell_profile) else {
        return false;
    };
    let variants = install_dir_variants(install_dir, home_dir);

    contents.lines().any(|line| {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            return false;
        }
        let updates_path = trimmed.contains("PATH")
            || trimmed.contains("fish_add_path")
            || trimmed.contains("fish_user_paths");
        updates_path && variants.iter().any(|variant| trimmed.contains(variant))
    })
}

fn cli_install_matches(install_path: &Path, bundled_path: &Path) -> bool {
    if !(install_path.exists() && bundled_path.exists()) {
        return false;
    }
    canonicalize_path(install_path) == canonicalize_path(bundled_path)
}

fn build_cli_install_status(
    bundled_path: &Path,
    install_path: &Path,
    path_env: Option<&str>,
    shell_env: Option<&str>,
    home_dir: &Path,
) -> CliInstallStatus {
    let shell_profile = shell_profile_path(shell_env, home_dir);
    let install_dir = install_path.parent().unwrap_or_else(|| Path::new("."));
    let shell_export = if shell_env.unwrap_or_default().contains("fish") {
        format!(
            "fish_add_path {}",
            display_home_relative(install_dir, home_dir)
        )
    } else {
        format!(
            "export PATH=\"{}:$PATH\"",
            display_home_relative(install_dir, home_dir)
        )
    };
    CliInstallStatus {
        bundled_path: bundled_path.to_string_lossy().into_owned(),
        install_path: install_path.to_string_lossy().into_owned(),
        installed: cli_install_matches(install_path, bundled_path),
        install_dir_on_path: install_dir_on_path(path_env, install_path),
        shell_profile_configured: shell_profile_configures_install_dir(
            &shell_profile,
            install_path,
            home_dir,
        ),
        shell_export: shell_export.clone(),
        shell_profile: shell_profile.to_string_lossy().into_owned(),
        persist_command: if shell_env.unwrap_or_default().contains("fish") {
            shell_export
        } else {
            format!(
                "echo '{}' >> {}",
                shell_export,
                display_home_relative(&shell_profile, home_dir)
            )
        },
    }
}

#[cfg(unix)]
fn link_projectctl(bundled_path: &Path, install_path: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(bundled_path, install_path).map_err(|error| error.to_string())
}

#[cfg(windows)]
fn link_projectctl(bundled_path: &Path, install_path: &Path) -> Result<(), String> {
    fs::copy(bundled_path, install_path)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn install_projectctl_entry(bundled_path: &Path, install_path: &Path) -> Result<(), String> {
    if !bundled_path.exists() {
        return Err(format!("Bundled CLI not found: {}", bundled_path.display()));
    }

    if cli_install_matches(install_path, bundled_path) {
        return Ok(());
    }

    if let Some(parent) = install_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    if let Ok(metadata) = fs::symlink_metadata(install_path) {
        if metadata.file_type().is_dir() {
            return Err(format!(
                "CLI install path is a directory: {}",
                install_path.display()
            ));
        }
        if metadata.file_type().is_symlink() {
            fs::remove_file(install_path).map_err(|error| error.to_string())?;
        } else {
            return Err(format!(
                "CLI install path already exists and will not be replaced automatically: {}",
                install_path.display()
            ));
        }
    }

    link_projectctl(bundled_path, install_path)
}

fn resolve_input_path(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Path is empty".to_string());
    }

    let expanded = if trimmed == "~" || trimmed.starts_with("~/") {
        let home = env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
        if trimmed == "~" {
            PathBuf::from(home)
        } else {
            PathBuf::from(home).join(trimmed.trim_start_matches("~/"))
        }
    } else {
        PathBuf::from(trimmed)
    };

    if !expanded.exists() {
        return Err(format!("Path does not exist: {}", expanded.display()));
    }

    Ok(canonicalize_path(&expanded))
}

fn to_json_string<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| error.to_string())
}

fn complete_local_workflow_mutation<T: Serialize>(
    app: &AppHandle,
    state: &AppState,
    root: &str,
    result: &T,
) -> Result<String, String> {
    let _ = record_local_workflow_write(state, root);
    let _ = load_state_payload(app, state);
    to_json_string(result)
}

fn desktop_actor() -> MutationActor {
    MutationActor {
        actor: DESKTOP_ACTOR_ID.to_string(),
        source: ActivitySource::Desktop,
    }
}

fn desktop_session_context() -> SessionContextInput {
    SessionContextInput::default()
}

fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{seconds}")
}

fn emit_bridge_state(app: &AppHandle, state: &AppState, reason: &str) -> Result<(), String> {
    let payload = bridge_state_payload(state, reason)?;
    app.emit(BRIDGE_EVENT, payload)
        .map_err(|error| error.to_string())
}

fn bridge_state_payload(state: &AppState, reason: &str) -> Result<BridgeStateEvent, String> {
    let settings = ensure_settings(state)?;
    let runtime = state
        .bridge
        .lock()
        .map_err(|_| "bridge mutex poisoned".to_string())?
        .runtime
        .clone();
    Ok(BridgeStateEvent {
        reason: reason.to_string(),
        mcp: settings.mcp,
        mcp_runtime: runtime,
    })
}

fn update_bridge_runtime(
    app: &AppHandle,
    state: &AppState,
    reason: &str,
    update: impl FnOnce(&mut BridgeRuntimeSnapshot),
) -> Result<(), String> {
    {
        let mut guard = state
            .bridge
            .lock()
            .map_err(|_| "bridge mutex poisoned".to_string())?;
        update(&mut guard.runtime);
    }
    emit_bridge_state(app, state, reason)
}

fn wait_for_bridge_shutdown(state: &AppState, timeout: Duration) -> Result<(), String> {
    let started = std::time::Instant::now();
    loop {
        let stopping_pid = state
            .bridge
            .lock()
            .map_err(|_| "bridge mutex poisoned".to_string())?
            .stopping_pid;
        if stopping_pid.is_none() {
            return Ok(());
        }
        if started.elapsed() >= timeout {
            return Err(format!(
                "Previous Agent Bridge process {:?} did not exit in time",
                stopping_pid
            ));
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn register_bridge_child(
    supervisor: &mut BridgeSupervisor,
    child: CommandChild,
    pid: u32,
    port: u16,
) {
    supervisor.child = Some(child);
    supervisor.child_pid = Some(pid);
    supervisor.runtime.pid = Some(pid);
    supervisor.runtime.bound_port = Some(port);
    supervisor.runtime.started_at = Some(now_iso());
}

fn handle_terminated_bridge_process(supervisor: &mut BridgeSupervisor, monitored_pid: u32) -> bool {
    let intentional_stop = supervisor.stopping_pid == Some(monitored_pid);
    if intentional_stop {
        supervisor.stopping_pid = None;
    }
    if supervisor.child_pid == Some(monitored_pid) {
        supervisor.child = None;
        supervisor.child_pid = None;
    }
    intentional_stop
}

fn stop_bridge(app: &AppHandle, state: &AppState, reason: &str) -> Result<(), String> {
    {
        let mut guard = state
            .bridge
            .lock()
            .map_err(|_| "bridge mutex poisoned".to_string())?;
        if let Some(child) = guard.child.take() {
            guard.stopping_pid = guard.child_pid.take();
            let _ = child.kill();
        }
        guard.runtime.status = "stopped".to_string();
        guard.runtime.pid = None;
        guard.runtime.bound_port = None;
        guard.runtime.started_at = None;
        guard.runtime.last_error = None;
    }
    emit_bridge_state(app, state, reason)
}

fn probe_bridge_health(port: u16, token: &str, timeout_ms: u64) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_millis(timeout_ms))
        .timeout(Duration::from_millis(timeout_ms))
        .no_proxy()
        .build()
        .map_err(|error| error.to_string())?;
    let url = format!("http://127.0.0.1:{port}/health");

    match client
        .get(&url)
        .header("Authorization", format!("Bearer {token}"))
        .send()
    {
        Ok(response) if response.status().is_success() => Ok(()),
        Ok(response) => Err(format!(
            "Agent Bridge health returned {}",
            response.status()
        )),
        Err(error) => Err(error.to_string()),
    }
}

fn wait_for_bridge_health(
    port: u16,
    token: &str,
    attempts: usize,
    delay_ms: u64,
) -> Result<(), String> {
    let mut last_error = None;
    for _ in 0..attempts {
        match probe_bridge_health(port, token, delay_ms.max(250)) {
            Ok(()) => return Ok(()),
            Err(error) => {
                last_error = Some(error);
                thread::sleep(Duration::from_millis(delay_ms));
            }
        }
    }

    let detail = last_error.unwrap_or_else(|| "no health probe result".to_string());
    Err(format!(
        "Agent Bridge did not become healthy on port {port}. Last probe error: {detail}"
    ))
}

fn apply_bridge_health_success(runtime: &mut BridgeRuntimeSnapshot, port: u16) {
    runtime.status = "running".to_string();
    runtime.bound_port = Some(port);
    runtime.last_error = None;
}

fn reconcile_bridge_runtime_if_healthy(state: &AppState) -> Result<(), String> {
    let settings = ensure_settings(state)?;
    if !settings.mcp.enabled {
        return Ok(());
    }

    let port = {
        let guard = state
            .bridge
            .lock()
            .map_err(|_| "bridge mutex poisoned".to_string())?;
        if guard.runtime.status != "starting" {
            return Ok(());
        }
        guard.runtime.bound_port.unwrap_or(settings.mcp.port)
    };

    if probe_bridge_health(port, &settings.mcp.token, 250).is_ok() {
        let mut guard = state
            .bridge
            .lock()
            .map_err(|_| "bridge mutex poisoned".to_string())?;
        if guard.runtime.status == "starting" {
            apply_bridge_health_success(&mut guard.runtime, port);
        }
    }

    Ok(())
}

fn start_bridge(app: &AppHandle, state: &AppState) -> Result<(), String> {
    wait_for_bridge_shutdown(state, Duration::from_secs(2))?;
    let mut settings = ensure_settings(state)?;
    if !settings.mcp.enabled {
        return Ok(());
    }
    if settings.mcp.token.trim().is_empty() {
        settings.mcp.token = generate_token();
    }

    let (port, changed) = find_available_port(settings.mcp.port.max(DEFAULT_BRIDGE_PORT))?;
    if changed {
        settings.mcp.port = port;
        save_settings(state, &settings)?;
        update_bridge_runtime(app, state, "endpointChanged", |runtime| {
            runtime.last_error = None;
        })?;
    } else {
        save_settings(state, &settings)?;
    }

    update_bridge_runtime(app, state, "startRequested", |runtime| {
        runtime.status = "starting".to_string();
        runtime.last_error = None;
    })?;

    let executable = current_projectctl_path()?;
    let sidecar = app
        .shell()
        .command(executable)
        .args(vec![
            "mcp".to_string(),
            "serve-http".to_string(),
            "--port".to_string(),
            port.to_string(),
            "--token".to_string(),
            settings.mcp.token.clone(),
        ])
        .env("PROJECT_WORKFLOW_INDEX_DB", index_db_path_string(state));

    let (mut rx, child) = sidecar.spawn().map_err(|error| error.to_string())?;
    let pid = child.pid();

    {
        let mut guard = state
            .bridge
            .lock()
            .map_err(|_| "bridge mutex poisoned".to_string())?;
        register_bridge_child(&mut guard, child, pid, port);
    }

    let (startup_tx, startup_rx) = mpsc::sync_channel::<Result<(), String>>(1);
    let monitor_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let monitored_pid = pid;
        let mut startup_tx = Some(startup_tx);
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let message = String::from_utf8_lossy(&bytes).trim().to_string();
                    if message.starts_with("AGENT_BRIDGE_READY ") {
                        if let Some(tx) = startup_tx.take() {
                            let _ = tx.send(Ok(()));
                        }
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let terminated_error = format!(
                        "projectctl exited with code {:?} signal {:?}",
                        payload.code, payload.signal
                    );
                    let intentional_stop =
                        if let Ok(mut guard) = monitor_app.state::<AppState>().bridge.lock() {
                            handle_terminated_bridge_process(&mut guard, monitored_pid)
                        } else {
                            false
                        };
                    if intentional_stop {
                        break;
                    }
                    if let Some(tx) = startup_tx.take() {
                        let _ = tx.send(Err(terminated_error.clone()));
                    }
                    let _ = update_bridge_runtime(
                        &monitor_app,
                        &monitor_app.state::<AppState>(),
                        "sidecarExited",
                        |runtime| {
                            runtime.status = "error".to_string();
                            runtime.pid = None;
                            runtime.started_at = None;
                            runtime.last_error = Some(terminated_error.clone());
                        },
                    );
                    break;
                }
                CommandEvent::Error(message) => {
                    if let Some(tx) = startup_tx.take() {
                        let _ = tx.send(Err(message.clone()));
                    }
                    let _ = update_bridge_runtime(
                        &monitor_app,
                        &monitor_app.state::<AppState>(),
                        "startFailed",
                        |runtime| {
                            runtime.last_error = Some(message.clone());
                        },
                    );
                }
                CommandEvent::Stderr(bytes) => {
                    let message = String::from_utf8_lossy(&bytes).trim().to_string();
                    if !message.is_empty() {
                        let _ = update_bridge_runtime(
                            &monitor_app,
                            &monitor_app.state::<AppState>(),
                            "startRequested",
                            |runtime| {
                                runtime.last_error = Some(message.clone());
                            },
                        );
                    }
                }
                _ => {}
            }
        }
    });

    let startup_result = startup_rx.recv_timeout(Duration::from_secs(5));
    let readiness_result = match startup_result {
        Ok(Ok(())) => wait_for_bridge_health(port, &settings.mcp.token, 10, 100),
        Ok(Err(error)) => Err(error),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            wait_for_bridge_health(port, &settings.mcp.token, 30, 250)
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("Agent Bridge startup channel disconnected before readiness".to_string())
        }
    };

    if let Err(error) = readiness_result {
        let previous_error = state
            .bridge
            .lock()
            .map_err(|_| "bridge mutex poisoned".to_string())?
            .runtime
            .last_error
            .clone();
        let _ = stop_bridge(app, state, "startFailed");
        let failure_message = match previous_error {
            Some(previous) if !previous.trim().is_empty() => {
                format!("{error}. Sidecar output: {previous}")
            }
            _ => error.clone(),
        };
        update_bridge_runtime(app, state, "startFailed", |runtime| {
            runtime.status = "error".to_string();
            runtime.last_error = Some(failure_message.clone());
        })?;
        return Err(failure_message);
    }

    update_bridge_runtime(app, state, "startSucceeded", |runtime| {
        apply_bridge_health_success(runtime, port);
        runtime.pid = Some(pid);
    })
}

fn restart_bridge(app: &AppHandle, state: &AppState, reason: &str) -> Result<(), String> {
    let settings = ensure_settings(state)?;
    if !settings.mcp.enabled {
        return stop_bridge(app, state, "stopSucceeded");
    }
    let _ = stop_bridge(app, state, reason);
    start_bridge(app, state)
}

fn apply_bridge_failure(runtime: &mut BridgeRuntimeSnapshot, error: String) {
    runtime.status = "error".to_string();
    runtime.last_error = Some(error);
}

fn record_background_bridge_failure(app: &AppHandle, state: &AppState, error: String) {
    let _ = update_bridge_runtime(app, state, "startFailed", |runtime| {
        apply_bridge_failure(runtime, error.clone());
    });
}

fn spawn_named_thread<F>(thread_name: &'static str, task: F) -> Result<(), std::io::Error>
where
    F: FnOnce() + Send + 'static,
{
    thread::Builder::new()
        .name(thread_name.to_string())
        .spawn(task)
        .map(|_| ())
}

fn spawn_bridge_task<F>(app: AppHandle, thread_name: &'static str, task: F)
where
    F: FnOnce(AppHandle) -> Result<(), String> + Send + 'static,
{
    let worker_app = app.clone();
    let spawn_result = spawn_named_thread(thread_name, move || {
        if let Err(error) = task(worker_app.clone()) {
            let state_ref = worker_app.state::<AppState>();
            record_background_bridge_failure(&worker_app, &state_ref, error);
        }
    });

    if let Err(error) = spawn_result {
        let state_ref = app.state::<AppState>();
        record_background_bridge_failure(
            &app,
            &state_ref,
            format!("Failed to spawn {thread_name} worker: {error}"),
        );
    }
}

fn spawn_bridge_start(app: AppHandle) {
    // Keep bridge lifecycle work off Tauri's Tokio runtime because it uses
    // reqwest's blocking client and shell teardown paths that may block.
    spawn_bridge_task(app, "bridge-start", |app| {
        let state_ref = app.state::<AppState>();
        start_bridge(&app, &state_ref)
    });
}

fn spawn_bridge_restart(app: AppHandle, reason: &'static str) {
    spawn_bridge_task(app, "bridge-restart", move |app| {
        let state_ref = app.state::<AppState>();
        restart_bridge(&app, &state_ref, reason)
    });
}

fn current_projectctl_path() -> Result<PathBuf, String> {
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    Ok(resolve_bundled_projectctl_path(&executable))
}

fn cli_install_status() -> Result<CliInstallStatus, String> {
    let home_dir = user_home_dir()?;
    let bundled_path = current_projectctl_path()?;
    let install_path = resolve_cli_install_path(env::var("PATH").ok().as_deref(), &home_dir);
    Ok(build_cli_install_status(
        &bundled_path,
        &install_path,
        env::var("PATH").ok().as_deref(),
        env::var("SHELL").ok().as_deref(),
        &home_dir,
    ))
}

fn sync_tray(app: &AppHandle, state: &AppState, payload: &LoadStatePayload) -> Result<(), String> {
    let handles_guard = state
        .tray_handles
        .lock()
        .map_err(|_| "tray mutex poisoned".to_string())?;
    let Some(handles) = handles_guard.as_ref() else {
        return Ok(());
    };

    let focused_root = payload.settings.last_focused_project.clone();
    let focused_summary = payload
        .projects
        .iter()
        .find(|project| focused_root.as_deref() == Some(project.root.as_str()));

    let project_text = focused_summary
        .as_ref()
        .map(|summary| format!("Project: {}", summary.name))
        .unwrap_or_else(|| "Project: none".to_string());
    let step_text = focused_summary
        .as_ref()
        .and_then(|summary| summary.current_step_title.clone())
        .map(|step| format!("Step: {step}"))
        .unwrap_or_else(|| "Step: none".to_string());
    let blocker_text = focused_summary
        .as_ref()
        .map(|summary| {
            format!(
                "Progress: {}/{} · {} sessions · {} blockers",
                summary.completed_step_count,
                summary.total_step_count,
                summary.active_session_count,
                summary.blocker_count
            )
        })
        .unwrap_or_else(|| "Progress: 0/0 · 0 sessions · 0 blockers".to_string());
    let next_text = focused_summary
        .as_ref()
        .and_then(|summary| summary.next_action.clone())
        .map(|next| format!("Next: {next}"))
        .unwrap_or_else(|| "Next: none".to_string());

    handles
        .project
        .set_text(project_text)
        .map_err(|error| error.to_string())?;
    handles
        .step
        .set_text(step_text)
        .map_err(|error| error.to_string())?;
    handles
        .blockers
        .set_text(blocker_text)
        .map_err(|error| error.to_string())?;
    handles
        .next_action
        .set_text(next_text.clone())
        .map_err(|error| error.to_string())?;
    if let Some(tray) = app.tray_by_id("workflow-tray") {
        tray.set_tooltip(Some(next_text))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn open_main_window(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

fn cleanup_suppressed_writes(
    entries: &mut HashMap<String, std::time::Instant>,
    now: std::time::Instant,
) {
    entries.retain(|_, recorded| {
        now.duration_since(*recorded) < Duration::from_millis(LOCAL_WRITE_SUPPRESSION_WINDOW_MS)
    });
}

fn record_local_workflow_write(state: &AppState, root: &str) -> Result<(), String> {
    let mut entries = state
        .local_write_suppression
        .lock()
        .map_err(|_| "local write suppression mutex poisoned".to_string())?;
    let now = std::time::Instant::now();
    cleanup_suppressed_writes(&mut entries, now);
    entries.insert(canonicalize_path_string(root), now);
    Ok(())
}

fn should_suppress_snapshot_event(state: &AppState, paths: &[PathBuf]) -> bool {
    let Ok(mut entries) = state.local_write_suppression.lock() else {
        return false;
    };
    let now = std::time::Instant::now();
    cleanup_suppressed_writes(&mut entries, now);
    paths.iter().any(|path| {
        let normalized = canonicalize_path(path).to_string_lossy().into_owned();
        entries
            .keys()
            .any(|root| normalized.starts_with(&workflow_dir_prefix(root)))
    })
}

fn reload_watcher(app: &AppHandle, state: &AppState, settings: &Settings) -> Result<(), String> {
    let app_handle = app.clone();
    let last_emit_at = Arc::new(Mutex::new(None::<std::time::Instant>));
    let mut watcher = RecommendedWatcher::new(
        move |result: Result<notify::Event, notify::Error>| {
            let Ok(event) = result else {
                return;
            };
            let relevant = event.paths.iter().any(|path| {
                path.components().any(|component| {
                    component.as_os_str() == std::ffi::OsStr::new(".project-workflow")
                })
            });
            if !relevant {
                return;
            }
            let state_ref = app_handle.state::<AppState>();
            if should_suppress_snapshot_event(&state_ref, &event.paths) {
                return;
            }
            let Ok(mut last_emit) = last_emit_at.lock() else {
                return;
            };
            let now = std::time::Instant::now();
            if last_emit
                .map(|previous| now.duration_since(previous) < Duration::from_millis(250))
                .unwrap_or(false)
            {
                return;
            }
            *last_emit = Some(now);
            let _ = app_handle.emit(WORKFLOW_SNAPSHOT_EVENT, ());
        },
        Config::default(),
    )
    .map_err(|error| error.to_string())?;

    for root in &settings.watched_roots {
        if Path::new(root).exists() {
            watcher
                .watch(Path::new(root), RecursiveMode::Recursive)
                .map_err(|error| error.to_string())?;
        }
    }

    let mut guard = state
        .watcher
        .lock()
        .map_err(|_| "watcher mutex poisoned".to_string())?;
    *guard = Some(watcher);
    Ok(())
}

fn load_state_payload(app: &AppHandle, state: &AppState) -> Result<LoadStatePayload, String> {
    let _ = reconcile_bridge_runtime_if_healthy(state);
    let settings = ensure_settings(state)?;
    let payload = build_snapshot_payload(state, &settings)?;
    if let Err(error) = sync_tray(app, state, &payload) {
        eprintln!("workflow desktop: tray sync failed during load_state_payload: {error}");
    }
    Ok(payload)
}

fn refresh_projects_payload(app: &AppHandle, state: &AppState) -> Result<LoadStatePayload, String> {
    let _ = reconcile_bridge_runtime_if_healthy(state);
    let settings = ensure_settings(state)?;
    let payload = build_refreshed_payload(state, &settings)?;
    if let Err(error) = sync_tray(app, state, &payload) {
        eprintln!("workflow desktop: tray sync failed during refresh_projects_payload: {error}");
    }
    Ok(payload)
}

fn build_board_projects(projects: &[ProjectSummary]) -> Result<Vec<BoardProjectDetail>, String> {
    projects
        .iter()
        .filter(|project| project.initialized && !project.missing)
        .map(|project| get_board_project_detail(&project.root).map_err(|error| error.to_string()))
        .collect()
}

fn snapshot_projects(state: &AppState, settings: &Settings) -> Result<Vec<ProjectSummary>, String> {
    if settings.watched_roots.is_empty() {
        Ok(Vec::new())
    } else {
        let index_db_path = index_db_path_string(state);
        list_indexed_projects(&settings.watched_roots, index_db_path.as_str())
            .map_err(|error| error.to_string())
    }
}

fn refreshed_projects(
    state: &AppState,
    settings: &Settings,
) -> Result<Vec<ProjectSummary>, String> {
    if settings.watched_roots.is_empty() {
        return Ok(Vec::new());
    }

    let index_db_path = index_db_path_string(&state);
    list_projects(&settings.watched_roots, index_db_path.as_str())
        .map_err(|error| error.to_string())
}

fn build_snapshot_payload(
    state: &AppState,
    settings: &Settings,
) -> Result<LoadStatePayload, String> {
    let projects = snapshot_projects(state, settings)?;
    let board_projects = build_board_projects(&projects)?;
    let mcp_runtime = state
        .bridge
        .lock()
        .map_err(|_| "bridge mutex poisoned".to_string())?
        .runtime
        .clone();
    Ok(LoadStatePayload {
        settings: settings.clone(),
        projects,
        board_projects,
        mcp_runtime,
    })
}

fn build_refreshed_payload(
    state: &AppState,
    settings: &Settings,
) -> Result<LoadStatePayload, String> {
    let projects = refreshed_projects(state, settings)?;
    let board_projects = build_board_projects(&projects)?;
    let mcp_runtime = state
        .bridge
        .lock()
        .map_err(|_| "bridge mutex poisoned".to_string())?
        .runtime
        .clone();
    Ok(LoadStatePayload {
        settings: settings.clone(),
        projects,
        board_projects,
        mcp_runtime,
    })
}

fn watched_roots_need_startup_refresh(
    state: &AppState,
    settings: &Settings,
) -> Result<bool, String> {
    if settings.watched_roots.is_empty() {
        return Ok(false);
    }

    let index_db_path = index_db_path_string(&state);
    Ok(
        !missing_watched_root_coverage(&settings.watched_roots, index_db_path.as_str())
            .map_err(|error| error.to_string())?
            .is_empty(),
    )
}

#[tauri::command]
fn load_state(app: AppHandle, state: State<AppState>) -> Result<String, String> {
    to_json_string(&load_state_payload(&app, &state)?)
}

#[tauri::command]
fn refresh_projects(app: AppHandle, state: State<AppState>) -> Result<String, String> {
    to_json_string(&refresh_projects_payload(&app, &state)?)
}

#[tauri::command]
fn add_watch_root(app: AppHandle, state: State<AppState>, root: String) -> Result<String, String> {
    let root = resolve_input_path(&root)?.to_string_lossy().into_owned();
    let index_db_path = index_db_path_string(&state);
    add_watched_root_index_state(&root, index_db_path.as_str())
        .map_err(|error| error.to_string())?;
    let settings = ensure_settings(&state)?;
    reload_watcher(&app, &state, &settings)?;
    to_json_string(&refresh_projects_payload(&app, &state)?)
}

#[tauri::command]
fn remove_watch_root(
    app: AppHandle,
    state: State<AppState>,
    root: String,
) -> Result<String, String> {
    let mut settings = ensure_settings(&state)?;
    let root = canonicalize_path_string(root.trim());
    if settings
        .last_focused_project
        .as_deref()
        .map(|focused| path_is_root_or_descendant(focused, &root))
        .unwrap_or(false)
    {
        settings.last_focused_project = None;
    }
    save_settings(&state, &settings)?;
    let index_db_path = index_db_path_string(&state);
    remove_watched_root_index_state(&root, index_db_path.as_str())
        .map_err(|error| error.to_string())?;
    let settings = ensure_settings(&state)?;
    reload_watcher(&app, &state, &settings)?;
    to_json_string(&refresh_projects_payload(&app, &state)?)
}

#[tauri::command]
fn set_last_focused_project(state: State<AppState>, root: Option<String>) -> Result<(), String> {
    let mut settings = ensure_settings(&state)?;
    settings.last_focused_project = root;
    save_settings(&state, &settings)?;
    Ok(())
}

#[tauri::command]
fn get_project(root: String) -> Result<String, String> {
    let result = get_project_service(&root).map_err(|error| error.to_string())?;
    to_json_string(&result)
}

#[tauri::command]
fn init_project(
    app: AppHandle,
    state: State<AppState>,
    root: String,
    name: String,
) -> Result<String, String> {
    let index_db_path = index_db_path_string(&state);
    init_project_service(InitProjectInput {
        root: root.clone(),
        actor: DESKTOP_ACTOR_ID.to_string(),
        source: ActivitySource::Desktop,
        name: Some(name),
        kind: Some(DEFAULT_PROJECT_KIND.to_string()),
        owner: Some(DESKTOP_ACTOR_ID.to_string()),
        tags: Some(Vec::new()),
        index_db_path,
    })
    .map_err(|error| error.to_string())?;

    let _ = record_local_workflow_write(&state, &root);
    let mut settings = ensure_settings(&state)?;
    settings.last_focused_project = Some(root);
    save_settings(&state, &settings)?;
    to_json_string(&refresh_projects_payload(&app, &state)?)
}

#[tauri::command]
fn start_step_cmd(
    app: AppHandle,
    state: State<AppState>,
    root: String,
    step_id: String,
) -> Result<String, String> {
    let index_db_path = index_db_path_string(&state);
    let result = start_step(
        &root,
        &step_id,
        desktop_actor(),
        desktop_session_context(),
        index_db_path.as_str(),
    )
    .map_err(|error| error.to_string())?;
    complete_local_workflow_mutation(&app, &state, &root, &result)
}

#[tauri::command]
fn complete_step_cmd(
    app: AppHandle,
    state: State<AppState>,
    root: String,
    step_id: String,
) -> Result<String, String> {
    let index_db_path = index_db_path_string(&state);
    let result = complete_step(
        &root,
        &step_id,
        desktop_actor(),
        desktop_session_context(),
        index_db_path.as_str(),
    )
    .map_err(|error| error.to_string())?;
    complete_local_workflow_mutation(&app, &state, &root, &result)
}

#[tauri::command]
fn add_blocker_cmd(
    app: AppHandle,
    state: State<AppState>,
    root: String,
    blocker: String,
) -> Result<String, String> {
    let index_db_path = index_db_path_string(&state);
    let result = add_blocker(
        &root,
        &blocker,
        desktop_actor(),
        desktop_session_context(),
        index_db_path.as_str(),
    )
    .map_err(|error| error.to_string())?;
    complete_local_workflow_mutation(&app, &state, &root, &result)
}

#[tauri::command]
fn clear_blocker_cmd(
    app: AppHandle,
    state: State<AppState>,
    root: String,
    blocker: Option<String>,
) -> Result<String, String> {
    let index_db_path = index_db_path_string(&state);
    let result = clear_blocker(
        &root,
        blocker.as_deref(),
        desktop_actor(),
        desktop_session_context(),
        index_db_path.as_str(),
    )
    .map_err(|error| error.to_string())?;
    complete_local_workflow_mutation(&app, &state, &root, &result)
}

#[tauri::command]
fn add_note_cmd(
    app: AppHandle,
    state: State<AppState>,
    root: String,
    note: String,
) -> Result<String, String> {
    let index_db_path = index_db_path_string(&state);
    let result = add_note(
        &root,
        &note,
        desktop_actor(),
        desktop_session_context(),
        index_db_path.as_str(),
    )
    .map_err(|error| error.to_string())?;
    complete_local_workflow_mutation(&app, &state, &root, &result)
}

#[tauri::command]
fn propose_decision_cmd(
    app: AppHandle,
    state: State<AppState>,
    root: String,
    title: String,
    context: String,
    decision: String,
    impact: String,
) -> Result<String, String> {
    let index_db_path = index_db_path_string(&state);
    let result = propose_decision(
        &root,
        DecisionProposalInput {
            title,
            context,
            decision,
            impact,
        },
        desktop_actor(),
        desktop_session_context(),
        index_db_path.as_str(),
    )
    .map_err(|error| error.to_string())?;
    complete_local_workflow_mutation(&app, &state, &root, &result)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetBridgeEnabledArgs {
    enabled: bool,
}

#[tauri::command]
fn set_bridge_enabled(
    app: AppHandle,
    state: State<AppState>,
    payload: SetBridgeEnabledArgs,
) -> Result<String, String> {
    let mut settings = ensure_settings(&state)?;
    settings.mcp.enabled = payload.enabled;
    if payload.enabled && settings.mcp.token.trim().is_empty() {
        settings.mcp.token = generate_token();
    }
    save_settings(&state, &settings)?;
    if payload.enabled {
        spawn_bridge_start(app.clone());
    } else {
        stop_bridge(&app, &state, "stopSucceeded")?;
    }
    to_json_string(&load_state_payload(&app, &state)?)
}

#[tauri::command]
fn restart_bridge_cmd(app: AppHandle, state: State<AppState>) -> Result<String, String> {
    spawn_bridge_restart(app.clone(), "startRequested");
    to_json_string(&load_state_payload(&app, &state)?)
}

#[tauri::command]
fn get_bridge_status(state: State<AppState>) -> Result<String, String> {
    let _ = reconcile_bridge_runtime_if_healthy(&state);
    to_json_string(&bridge_state_payload(&state, "snapshot")?)
}

#[tauri::command]
fn regenerate_bridge_token(app: AppHandle, state: State<AppState>) -> Result<String, String> {
    let mut settings = ensure_settings(&state)?;
    settings.mcp.token = generate_token();
    save_settings(&state, &settings)?;
    update_bridge_runtime(&app, &state, "tokenRotated", |runtime| {
        runtime.last_error = None;
    })?;
    if settings.mcp.enabled {
        spawn_bridge_restart(app.clone(), "tokenRotated");
    }
    to_json_string(&load_state_payload(&app, &state)?)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GetBridgeSnippetsArgs {
    kind: String,
    root: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentDefaultsArgs {
    root: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplyAgentDefaultsArgs {
    kind: String,
    action: String,
    root: Option<String>,
}

fn parse_client_kind(raw: &str) -> Result<ClientKind, String> {
    match raw {
        "codex" => Ok(ClientKind::Codex),
        "claudeCode" => Ok(ClientKind::ClaudeCode),
        "claudeDesktop" => Ok(ClientKind::ClaudeDesktop),
        _ => Err(format!("Unknown client kind: {raw}")),
    }
}

fn parse_install_action(raw: &str) -> Result<InstallAction, String> {
    match raw {
        "install" => Ok(InstallAction::Install),
        "update" => Ok(InstallAction::Update),
        "reinstall" => Ok(InstallAction::Reinstall),
        _ => Err(format!("Unknown install action: {raw}")),
    }
}

fn agent_defaults_context(
    state: &AppState,
    root: Option<&str>,
) -> Result<(AgentDefaultsContext, InstallScope), String> {
    let settings = ensure_settings(state)?;
    let home_dir = user_home_dir()?;
    let path_env = env::var("PATH").ok();
    let stable_cli_path = resolve_cli_install_path(path_env.as_deref(), &home_dir);
    let bridge_port = state
        .bridge
        .lock()
        .map_err(|_| "bridge mutex poisoned".to_string())?
        .runtime
        .bound_port
        .unwrap_or(settings.mcp.port);
    let scope = if root.is_some() {
        InstallScope::Both
    } else {
        InstallScope::Global
    };
    Ok((
        AgentDefaultsContext {
            repo_root: root.map(PathBuf::from),
            bridge_url: Some(resolve_bridge_url(bridge_port)),
            bridge_token: Some(settings.mcp.token),
            projectctl_command_path: Some(stable_cli_path),
            path_env,
            home_dir: Some(home_dir),
            appdata_dir: env::var_os("APPDATA").map(PathBuf::from),
        },
        scope,
    ))
}

fn inspect_all_agent_defaults(
    state: &AppState,
    root: Option<&str>,
) -> Result<Vec<AgentTargetStatus>, String> {
    let (context, scope) = agent_defaults_context(state, root)?;
    ClientKind::ALL
        .into_iter()
        .map(|kind| inspect_agent_defaults(&context, kind, scope))
        .collect()
}

#[tauri::command]
fn get_bridge_client_snippets(
    state: State<AppState>,
    args: GetBridgeSnippetsArgs,
) -> Result<String, String> {
    let kind = parse_client_kind(&args.kind)?;
    let (context, scope) = agent_defaults_context(&state, args.root.as_deref())?;
    let status = inspect_agent_defaults(&context, kind, scope)?;
    let snippet = build_client_snippet(
        kind,
        context
            .bridge_url
            .as_deref()
            .ok_or_else(|| "Bridge URL missing".to_string())?,
        context
            .bridge_token
            .as_deref()
            .ok_or_else(|| "Bridge token missing".to_string())?,
        context
            .projectctl_command_path
            .as_deref()
            .ok_or_else(|| "projectctl path missing".to_string())?,
        status.status == InstallStatus::Stale,
    )?;
    let snippets = vec![snippet];
    to_json_string(&snippets)
}

#[tauri::command]
fn get_agent_defaults_status(
    state: State<AppState>,
    args: AgentDefaultsArgs,
) -> Result<String, String> {
    to_json_string(&inspect_all_agent_defaults(&state, args.root.as_deref())?)
}

#[tauri::command]
fn apply_agent_defaults_cmd(
    state: State<AppState>,
    args: ApplyAgentDefaultsArgs,
) -> Result<String, String> {
    let kind = parse_client_kind(&args.kind)?;
    let action = parse_install_action(&args.action)?;
    let (context, scope) = agent_defaults_context(&state, args.root.as_deref())?;
    let status = apply_agent_defaults(&context, kind, scope, action)?;
    to_json_string(&status)
}

#[tauri::command]
fn get_cli_install_status() -> Result<String, String> {
    to_json_string(&cli_install_status()?)
}

#[tauri::command]
fn install_cli_cmd() -> Result<String, String> {
    let status = cli_install_status()?;
    install_projectctl_entry(
        Path::new(&status.bundled_path),
        Path::new(&status.install_path),
    )?;
    to_json_string(&cli_install_status()?)
}

fn build_tray(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let project_item = MenuItem::with_id(app, "project", "Project: none", false, None::<&str>)
        .map_err(|error| error.to_string())?;
    let step_item = MenuItem::with_id(app, "step", "Step: none", false, None::<&str>)
        .map_err(|error| error.to_string())?;
    let blockers_item = MenuItem::with_id(app, "blockers", "Blockers: 0", false, None::<&str>)
        .map_err(|error| error.to_string())?;
    let next_item = MenuItem::with_id(app, "next", "Next: none", false, None::<&str>)
        .map_err(|error| error.to_string())?;
    let open_item = MenuItem::with_id(app, "open", "Open dashboard", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let separator = PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?;

    let menu = MenuBuilder::new(app)
        .items(&[
            &project_item,
            &step_item,
            &blockers_item,
            &next_item,
            &separator,
            &open_item,
            &quit_item,
        ])
        .build()
        .map_err(|error| error.to_string())?;

    let _tray = TrayIconBuilder::with_id("workflow-tray")
        .menu(&menu)
        .icon(
            app.default_window_icon()
                .cloned()
                .ok_or_else(|| "default window icon missing".to_string())?,
        )
        .tooltip("Project Workflow OS")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => {
                let _ = open_main_window(app);
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = open_main_window(&tray.app_handle());
            }
        })
        .build(app)
        .map_err(|error| error.to_string())?;

    let mut guard = state
        .tray_handles
        .lock()
        .map_err(|_| "tray mutex poisoned".to_string())?;
    *guard = Some(TrayMenuHandles {
        project: project_item,
        step: step_item,
        blockers: blockers_item,
        next_action: next_item,
    });
    Ok(())
}

fn main() {
    init_tracing();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let support_dir = app_support_dir(app.handle())?;
            fs::create_dir_all(&support_dir).map_err(|error| error.to_string())?;
            let index_db_path = resolve_desktop_index_db_path(app.handle())?;
            let state = AppState {
                settings_path: support_dir.join("settings.json"),
                index_db_path,
                watcher: Mutex::new(None),
                local_write_suppression: Mutex::new(HashMap::new()),
                tray_handles: Mutex::new(None),
                bridge: Mutex::new(BridgeSupervisor {
                    child: None,
                    child_pid: None,
                    stopping_pid: None,
                    runtime: BridgeRuntimeSnapshot {
                        status: "stopped".to_string(),
                        ..BridgeRuntimeSnapshot::default()
                    },
                }),
            };

            app.manage(state);
            let state_ref = app.state::<AppState>();
            build_tray(app.handle(), &state_ref)?;
            let settings = ensure_settings(&state_ref)?;
            save_settings(&state_ref, &settings)?;
            reload_watcher(app.handle(), &state_ref, &settings)?;
            if watched_roots_need_startup_refresh(&state_ref, &settings)? {
                let _ = refresh_projects_payload(app.handle(), &state_ref);
                let _ = app.handle().emit(WORKFLOW_TOPOLOGY_EVENT, ());
            } else {
                let _ = load_state_payload(app.handle(), &state_ref);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_state,
            refresh_projects,
            add_watch_root,
            remove_watch_root,
            set_last_focused_project,
            get_project,
            init_project,
            start_step_cmd,
            complete_step_cmd,
            add_blocker_cmd,
            clear_blocker_cmd,
            add_note_cmd,
            propose_decision_cmd,
            set_bridge_enabled,
            restart_bridge_cmd,
            get_bridge_status,
            regenerate_bridge_token,
            get_bridge_client_snippets,
            get_agent_defaults_status,
            apply_agent_defaults_cmd,
            get_cli_install_status,
            install_cli_cmd,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        if let RunEvent::Ready = event {
            let state_ref = app.state::<AppState>();
            if let Ok(settings) = ensure_settings(&state_ref) {
                if settings.mcp.enabled {
                    spawn_bridge_start(app.clone());
                }
            }
        }
    });
}

fn init_tracing() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("warn")),
        )
        .with_target(false)
        .try_init();
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::{distributions::Alphanumeric, Rng};

    fn unique_temp_dir(label: &str) -> PathBuf {
        let suffix = rand::thread_rng()
            .sample_iter(&Alphanumeric)
            .take(8)
            .map(char::from)
            .collect::<String>();
        let path = env::temp_dir().join(format!("parallel-desktop-{label}-{suffix}"));
        fs::create_dir_all(&path).expect("temporary test directory should create");
        path
    }

    fn create_repo(root: &Path) {
        fs::create_dir_all(root.join(".git")).expect("repo should create");
        fs::write(root.join(".git/HEAD"), "ref: refs/heads/main\n").expect("git head should write");
    }

    fn test_state(base: &Path) -> AppState {
        AppState {
            settings_path: base.join("settings.json"),
            index_db_path: base.join("workflow-index.sqlite"),
            watcher: Mutex::new(None),
            local_write_suppression: Mutex::new(HashMap::new()),
            tray_handles: Mutex::new(None),
            bridge: Mutex::new(BridgeSupervisor {
                child: None,
                child_pid: None,
                stopping_pid: None,
                runtime: BridgeRuntimeSnapshot {
                    status: "stopped".to_string(),
                    ..BridgeRuntimeSnapshot::default()
                },
            }),
        }
    }

    #[test]
    fn old_bridge_termination_does_not_clear_new_child() {
        let mut supervisor = BridgeSupervisor {
            child: None,
            child_pid: Some(222),
            stopping_pid: Some(111),
            runtime: BridgeRuntimeSnapshot::default(),
        };

        let intentional = handle_terminated_bridge_process(&mut supervisor, 111);

        assert!(intentional);
        assert_eq!(supervisor.child_pid, Some(222));
        assert_eq!(supervisor.stopping_pid, None);
    }

    #[test]
    fn apply_bridge_failure_marks_runtime_error() {
        let mut runtime = BridgeRuntimeSnapshot {
            status: "starting".to_string(),
            ..BridgeRuntimeSnapshot::default()
        };

        apply_bridge_failure(&mut runtime, "boom".to_string());

        assert_eq!(runtime.status, "error");
        assert_eq!(runtime.last_error.as_deref(), Some("boom"));
    }

    #[test]
    fn apply_bridge_health_success_marks_runtime_running() {
        let mut runtime = BridgeRuntimeSnapshot {
            status: "starting".to_string(),
            last_error: Some("waiting".to_string()),
            ..BridgeRuntimeSnapshot::default()
        };

        apply_bridge_health_success(&mut runtime, 4857);

        assert_eq!(runtime.status, "running");
        assert_eq!(runtime.bound_port, Some(4857));
        assert_eq!(runtime.last_error, None);
    }

    #[test]
    fn spawn_named_thread_runs_on_dedicated_thread() {
        let current_thread = thread::current().id();
        let (tx, rx) = mpsc::sync_channel(1);

        spawn_named_thread("bridge-test", move || {
            tx.send(thread::current().id())
                .expect("thread id should send");
        })
        .expect("bridge test worker thread should spawn");

        let worker_thread = rx
            .recv_timeout(Duration::from_secs(1))
            .expect("bridge worker thread should report its id");

        assert_ne!(worker_thread, current_thread);
    }

    #[test]
    fn startup_refresh_runs_once_for_uncovered_watched_roots() {
        let base = unique_temp_dir("startup-coverage");
        let state = test_state(&base);
        let watched_root = base.join("watched-root");
        fs::create_dir_all(&watched_root).expect("watched root should create");
        let settings = Settings {
            watched_roots: vec![watched_root.display().to_string()],
            last_focused_project: None,
            mcp: BridgeSettings {
                enabled: false,
                port: DEFAULT_BRIDGE_PORT,
                token: String::new(),
            },
        };

        assert!(watched_roots_need_startup_refresh(&state, &settings)
            .expect("coverage check should work"));
        build_refreshed_payload(&state, &settings).expect("refresh payload should build");
        assert!(!watched_roots_need_startup_refresh(&state, &settings)
            .expect("coverage should now exist"));
    }

    #[test]
    fn desktop_watched_roots_resolve_from_env_before_canonical_store() {
        let base = unique_temp_dir("desktop-root-resolution");
        let state = test_state(&base);
        let persisted = serde_json::to_string_pretty(&PersistedSettings::default())
            .expect("persisted settings should serialize");
        fs::write(&state.settings_path, persisted).expect("settings should write");

        let canonical_root = base.join("canonical-root");
        let env_root = base.join("env-root");
        fs::create_dir_all(&canonical_root).expect("canonical root should create");
        fs::create_dir_all(&env_root).expect("env root should create");

        add_watched_root_index_state(
            canonical_root.display().to_string().as_str(),
            state.index_db_path.to_string_lossy().as_ref(),
        )
        .expect("canonical root should store");

        let env_root_raw = env_root.display().to_string();
        let resolved = resolve_desktop_watched_roots(&state, Some(env_root_raw.as_str()))
            .expect("desktop roots should resolve");

        assert_eq!(
            resolved,
            vec![env_root
                .canonicalize()
                .expect("env root should canonicalize")
                .to_string_lossy()
                .into_owned()]
        );
    }

    #[test]
    fn local_write_suppression_ignores_recent_workflow_events() {
        let base = unique_temp_dir("suppression");
        let state = test_state(&base);
        let repo = base.join("repo");
        fs::create_dir_all(repo.join(".project-workflow/local"))
            .expect("workflow dir should create");
        fs::write(
            repo.join(".project-workflow/local/runtime.yaml"),
            "status: todo\n",
        )
        .expect("runtime file should write");

        record_local_workflow_write(&state, repo.display().to_string().as_str())
            .expect("local write should record");

        assert!(should_suppress_snapshot_event(
            &state,
            &[repo.join(".project-workflow/local/runtime.yaml")]
        ));
    }

    #[test]
    fn root_or_descendant_check_excludes_sibling_paths() {
        let root = "/tmp/workspace/root";
        assert!(path_is_root_or_descendant("/tmp/workspace/root", root));
        assert!(path_is_root_or_descendant(
            "/tmp/workspace/root/nested/project",
            root
        ));
        assert!(!path_is_root_or_descendant(
            "/tmp/workspace/root-sibling",
            root
        ));
    }

    #[test]
    fn cli_install_path_prefers_visible_home_bin_on_macos() {
        let home = PathBuf::from("/tmp/test-home");
        let install = resolve_cli_install_path(Some("/usr/bin:/tmp/test-home/bin"), &home);
        assert_eq!(
            install,
            home.join("bin").join(bundled_sidecar_binary_filename())
        );
    }

    #[test]
    fn cli_install_status_reports_path_export_command() {
        let home = PathBuf::from("/tmp/test-home");
        let bundled = home
            .join("parallel.app")
            .join("Contents")
            .join("MacOS")
            .join("projectctl");
        let install = home.join("bin").join("projectctl");
        let status = build_cli_install_status(
            &bundled,
            &install,
            Some("/usr/bin"),
            Some("/bin/zsh"),
            &home,
        );

        assert!(!status.install_dir_on_path);
        assert_eq!(status.shell_export, "export PATH=\"$HOME/bin:$PATH\"");
        assert_eq!(status.shell_profile, "/tmp/test-home/.zshrc");
        assert_eq!(
            status.persist_command,
            "echo 'export PATH=\"$HOME/bin:$PATH\"' >> $HOME/.zshrc"
        );
    }

    #[test]
    fn cli_install_status_detects_shell_profile_path_configuration() {
        let home = unique_temp_dir("cli-shell-profile");
        let shell_profile = home.join(".zshrc");
        fs::write(&shell_profile, "export PATH=\"$HOME/bin:$PATH\"\n")
            .expect("shell profile should write");

        let bundled = home
            .join("parallel.app")
            .join("Contents")
            .join("MacOS")
            .join("projectctl");
        let install = home.join("bin").join("projectctl");
        let status = build_cli_install_status(
            &bundled,
            &install,
            Some("/usr/bin"),
            Some("/bin/zsh"),
            &home,
        );

        assert!(!status.install_dir_on_path);
        assert!(status.shell_profile_configured);
    }

    #[test]
    fn install_projectctl_entry_creates_cli_link() {
        let base = unique_temp_dir("cli-install");
        let bundled = base
            .join("parallel.app")
            .join("Contents")
            .join("MacOS")
            .join("projectctl");
        fs::create_dir_all(bundled.parent().expect("bundled parent"))
            .expect("bundled dir should create");
        fs::write(&bundled, "cli").expect("bundled binary should write");

        let install = base.join("bin").join("projectctl");
        install_projectctl_entry(&bundled, &install).expect("cli install should succeed");

        assert!(install.exists());
        assert!(cli_install_matches(&install, &bundled));
    }

    #[test]
    fn snapshot_payload_keeps_new_repo_hidden_until_refresh() {
        let base = unique_temp_dir("snapshot-refresh");
        let state = test_state(&base);
        let watched_root = base.join("watched-root");
        fs::create_dir_all(&watched_root).expect("watched root should create");

        let repo_one = watched_root.join("repo-one");
        create_repo(&repo_one);
        init_project_service(InitProjectInput {
            root: repo_one.display().to_string(),
            actor: DESKTOP_ACTOR_ID.to_string(),
            source: ActivitySource::Desktop,
            name: Some("Repo One".to_string()),
            kind: Some(DEFAULT_PROJECT_KIND.to_string()),
            owner: Some(DESKTOP_ACTOR_ID.to_string()),
            tags: Some(Vec::new()),
            index_db_path: state.index_db_path.to_string_lossy().into_owned(),
        })
        .expect("initial repo should initialize");

        let settings = Settings {
            watched_roots: vec![watched_root.display().to_string()],
            last_focused_project: Some(repo_one.display().to_string()),
            mcp: BridgeSettings {
                enabled: false,
                port: DEFAULT_BRIDGE_PORT,
                token: String::new(),
            },
        };

        let refreshed = build_refreshed_payload(&state, &settings)
            .expect("refresh should discover indexed repo");
        assert_eq!(refreshed.projects.len(), 1);
        assert_eq!(refreshed.board_projects.len(), 1);

        let repo_two = watched_root.join("repo-two");
        create_repo(&repo_two);

        let snapshot =
            build_snapshot_payload(&state, &settings).expect("snapshot should use index only");
        assert_eq!(snapshot.projects.len(), 1);
        assert!(snapshot.projects[0]
            .root
            .ends_with("/watched-root/repo-one"));

        let codex_home = base.join(".codex");
        fs::create_dir_all(&codex_home).expect("codex home should create");
        let codex_db = codex_home.join("state_11.sqlite");
        let connection = rusqlite::Connection::open(&codex_db).expect("codex db should open");
        connection
            .execute_batch(
                r#"
                CREATE TABLE threads (
                  cwd TEXT,
                  archived INTEGER NOT NULL DEFAULT 0
                );
                "#,
            )
            .expect("codex schema should create");
        connection
            .execute(
                "INSERT INTO threads (cwd, archived) VALUES (?1, 0)",
                rusqlite::params![repo_two.display().to_string()],
            )
            .expect("codex thread should insert");

        let prior_home = std::env::var_os("HOME");
        std::env::set_var("HOME", &base);
        let refreshed_again =
            build_refreshed_payload(&state, &settings).expect("refresh should discover repo two");
        if let Some(value) = prior_home {
            std::env::set_var("HOME", value);
        } else {
            std::env::remove_var("HOME");
        }
        assert_eq!(refreshed_again.projects.len(), 2);
        let discovered_repo_two = refreshed_again
            .projects
            .iter()
            .find(|project| project.root.ends_with("/watched-root/repo-two"))
            .expect("refreshed payload should include repo two");
        assert_eq!(
            discovered_repo_two.discovery_source,
            Some(parallel_workflow_core::DiscoverySource::Codex)
        );
        assert_eq!(discovered_repo_two.discovery_path, None);
        assert!(refreshed_again
            .projects
            .iter()
            .any(|project| project.root.ends_with("/watched-root/repo-two")));
        let snapshot_after_refresh = build_snapshot_payload(&state, &settings)
            .expect("snapshot should reuse indexed provenance");
        let snapshot_repo_two = snapshot_after_refresh
            .projects
            .iter()
            .find(|project| project.root.ends_with("/watched-root/repo-two"))
            .expect("snapshot should retain repo two");
        assert_eq!(
            snapshot_repo_two.discovery_source,
            Some(parallel_workflow_core::DiscoverySource::Codex)
        );
        assert_eq!(refreshed_again.board_projects.len(), 1);
    }

    #[test]
    fn desktop_index_path_migrates_legacy_index_to_canonical_location() {
        let base = unique_temp_dir("index-migration");
        let legacy_index = base.join("legacy").join("workflow-index.sqlite");
        let canonical_index = base.join("canonical").join("workflow-index.sqlite");
        fs::create_dir_all(legacy_index.parent().expect("legacy parent"))
            .expect("legacy dir should create");
        fs::write(&legacy_index, "legacy").expect("legacy index should write");

        let resolved =
            finalize_desktop_index_path(legacy_index.clone(), Some(canonical_index.clone()))
                .expect("index path should resolve");

        assert_eq!(resolved, canonical_index);
        assert!(!legacy_index.exists());
        assert_eq!(
            fs::read_to_string(&canonical_index).expect("canonical index should exist"),
            "legacy"
        );
    }
}
