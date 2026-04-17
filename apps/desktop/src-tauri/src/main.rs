#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;

use std::{
    env, fs,
    path::{Path, PathBuf},
    sync::mpsc,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use bridge::{
    build_client_snippet, clear_client_stale, find_available_port, generate_token,
    mark_clients_stale, resolve_bridge_url, resolve_bundled_projectctl_path, BridgeRuntimeSnapshot,
    BridgeSettings, BridgeStateEvent, DEFAULT_BRIDGE_PORT, BRIDGE_EVENT,
};
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use parallel_workflow_core::{
    add_blocker, add_note, clear_blocker, complete_step, get_board_project_detail,
    get_project as get_project_service, init_project as init_project_service, list_indexed_projects,
    list_projects, missing_watched_root_coverage, propose_decision,
    remove_watched_root_index_state, start_step, ActivitySource, BoardProjectDetail,
    DecisionProposalInput, InitProjectInput, MutationActor, ProjectSummary, SessionContextInput,
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Settings {
    watched_roots: Vec<String>,
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

fn app_support_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|error| error.to_string())
}

fn ensure_settings(state: &AppState) -> Result<Settings, String> {
    if !state.settings_path.exists() {
        if let Some(parent) = state.settings_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let initial = serde_json::to_string_pretty(&Settings::default()).map_err(|error| error.to_string())?;
        fs::write(&state.settings_path, initial).map_err(|error| error.to_string())?;
    }

    let raw = fs::read_to_string(&state.settings_path).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw).map_err(|error| error.to_string())
}

fn save_settings(state: &AppState, settings: &Settings) -> Result<(), String> {
    let body = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    fs::write(&state.settings_path, body).map_err(|error| error.to_string())
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

    expanded.canonicalize().map_err(|error| error.to_string())
}

fn to_json_string<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| error.to_string())
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

fn joined_watched_roots(settings: &Settings) -> String {
    settings.watched_roots.join(if cfg!(windows) { ";" } else { ":" })
}

fn emit_bridge_state(app: &AppHandle, state: &AppState, reason: &str) -> Result<(), String> {
    let payload = bridge_state_payload(state, reason)?;
    app.emit(
        BRIDGE_EVENT,
        payload,
    )
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

fn register_bridge_child(supervisor: &mut BridgeSupervisor, child: CommandChild, pid: u32, port: u16) {
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
        Ok(response) => Err(format!("Agent Bridge health returned {}", response.status())),
        Err(error) => Err(error.to_string()),
    }
}

fn wait_for_bridge_health(port: u16, token: &str, attempts: usize, delay_ms: u64) -> Result<(), String> {
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
            mark_clients_stale(runtime, "endpointChanged");
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
        .env("PROJECT_WORKFLOW_INDEX_DB", state.index_db_path.to_string_lossy().into_owned())
        .env("PROJECT_WORKFLOW_WATCH_ROOTS", joined_watched_roots(&settings));

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
                    let intentional_stop = if let Ok(mut guard) = monitor_app.state::<AppState>().bridge.lock() {
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
                    let _ = update_bridge_runtime(&monitor_app, &monitor_app.state::<AppState>(), "sidecarExited", |runtime| {
                        runtime.status = "error".to_string();
                        runtime.pid = None;
                        runtime.started_at = None;
                        runtime.last_error = Some(terminated_error.clone());
                    });
                    break;
                }
                CommandEvent::Error(message) => {
                    if let Some(tx) = startup_tx.take() {
                        let _ = tx.send(Err(message.clone()));
                    }
                    let _ = update_bridge_runtime(&monitor_app, &monitor_app.state::<AppState>(), "startFailed", |runtime| {
                        runtime.last_error = Some(message.clone());
                    });
                }
                CommandEvent::Stderr(bytes) => {
                    let message = String::from_utf8_lossy(&bytes).trim().to_string();
                    if !message.is_empty() {
                        let _ = update_bridge_runtime(&monitor_app, &monitor_app.state::<AppState>(), "startRequested", |runtime| {
                            runtime.last_error = Some(message.clone());
                        });
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
        Err(mpsc::RecvTimeoutError::Timeout) => wait_for_bridge_health(port, &settings.mcp.token, 30, 250),
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
            Some(previous) if !previous.trim().is_empty() => format!("{error}. Sidecar output: {previous}"),
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

    handles.project.set_text(project_text).map_err(|error| error.to_string())?;
    handles.step.set_text(step_text).map_err(|error| error.to_string())?;
    handles.blockers.set_text(blocker_text).map_err(|error| error.to_string())?;
    handles.next_action.set_text(next_text.clone()).map_err(|error| error.to_string())?;
    if let Some(tray) = app.tray_by_id("workflow-tray") {
        tray.set_tooltip(Some(next_text)).map_err(|error| error.to_string())?;
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

fn reload_watcher(app: &AppHandle, state: &AppState, settings: &Settings) -> Result<(), String> {
    let app_handle = app.clone();
    let last_emit_at = Arc::new(Mutex::new(None::<std::time::Instant>));
    let mut watcher = RecommendedWatcher::new(
        move |result: Result<notify::Event, notify::Error>| {
            let Ok(event) = result else {
                return;
            };
            let relevant = event.paths.iter().any(|path| {
                path.components()
                    .any(|component| component.as_os_str() == std::ffi::OsStr::new(".project-workflow"))
            });
            if !relevant {
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
            let _ = app_handle.emit("workflow://changed", ());
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
        let index_db_path = state.index_db_path.to_string_lossy().into_owned();
        list_indexed_projects(&settings.watched_roots, index_db_path.as_str())
            .map_err(|error| error.to_string())
    }
}

fn refreshed_projects(state: &AppState, settings: &Settings) -> Result<Vec<ProjectSummary>, String> {
    if settings.watched_roots.is_empty() {
        return Ok(Vec::new());
    }

    let index_db_path = state.index_db_path.to_string_lossy().into_owned();
    list_projects(&settings.watched_roots, Some(index_db_path.as_str())).map_err(|error| error.to_string())
}

fn build_snapshot_payload(state: &AppState, settings: &Settings) -> Result<LoadStatePayload, String> {
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

fn build_refreshed_payload(state: &AppState, settings: &Settings) -> Result<LoadStatePayload, String> {
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

fn watched_roots_need_startup_refresh(state: &AppState, settings: &Settings) -> Result<bool, String> {
    if settings.watched_roots.is_empty() {
        return Ok(false);
    }

    let index_db_path = state.index_db_path.to_string_lossy().into_owned();
    Ok(!missing_watched_root_coverage(&settings.watched_roots, index_db_path.as_str())
        .map_err(|error| error.to_string())?
        .is_empty())
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
    let mut settings = ensure_settings(&state)?;
    let root = resolve_input_path(&root)?.to_string_lossy().into_owned();
    if !settings.watched_roots.contains(&root) {
        settings.watched_roots.push(root);
        settings.watched_roots.sort();
    }
    save_settings(&state, &settings)?;
    reload_watcher(&app, &state, &settings)?;
    if settings.mcp.enabled {
        restart_bridge(&app, &state, "startRequested")?;
    }
    to_json_string(&refresh_projects_payload(&app, &state)?)
}

#[tauri::command]
fn remove_watch_root(app: AppHandle, state: State<AppState>, root: String) -> Result<String, String> {
    let mut settings = ensure_settings(&state)?;
    settings.watched_roots.retain(|candidate| candidate != &root);
    if settings.last_focused_project.as_deref() == Some(root.as_str()) {
        settings.last_focused_project = None;
    }
    save_settings(&state, &settings)?;
    let index_db_path = state.index_db_path.to_string_lossy().into_owned();
    remove_watched_root_index_state(&root, index_db_path.as_str()).map_err(|error| error.to_string())?;
    reload_watcher(&app, &state, &settings)?;
    if settings.mcp.enabled {
        restart_bridge(&app, &state, "startRequested")?;
    }
    to_json_string(&refresh_projects_payload(&app, &state)?)
}

#[tauri::command]
fn set_last_focused_project(
    state: State<AppState>,
    root: Option<String>,
) -> Result<(), String> {
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
fn init_project(app: AppHandle, state: State<AppState>, root: String, name: String) -> Result<String, String> {
    let index_db_path = state.index_db_path.to_string_lossy().into_owned();
    init_project_service(InitProjectInput {
        root: root.clone(),
        actor: DESKTOP_ACTOR_ID.to_string(),
        source: ActivitySource::Desktop,
        name: Some(name),
        kind: Some(DEFAULT_PROJECT_KIND.to_string()),
        owner: Some(DESKTOP_ACTOR_ID.to_string()),
        tags: Some(Vec::new()),
        index_db_path: Some(index_db_path),
    })
    .map_err(|error| error.to_string())?;

    let mut settings = ensure_settings(&state)?;
    settings.last_focused_project = Some(root);
    save_settings(&state, &settings)?;
    to_json_string(&refresh_projects_payload(&app, &state)?)
}

#[tauri::command]
fn start_step_cmd(app: AppHandle, state: State<AppState>, root: String, step_id: String) -> Result<String, String> {
    let index_db_path = state.index_db_path.to_string_lossy().into_owned();
    let result = start_step(
        &root,
        &step_id,
        desktop_actor(),
        desktop_session_context(),
        Some(index_db_path.as_str()),
    )
    .map_err(|error| error.to_string())?;
    let _ = load_state_payload(&app, &state);
    to_json_string(&result)
}

#[tauri::command]
fn complete_step_cmd(app: AppHandle, state: State<AppState>, root: String, step_id: String) -> Result<String, String> {
    let index_db_path = state.index_db_path.to_string_lossy().into_owned();
    let result = complete_step(
        &root,
        &step_id,
        desktop_actor(),
        desktop_session_context(),
        Some(index_db_path.as_str()),
    )
    .map_err(|error| error.to_string())?;
    let _ = load_state_payload(&app, &state);
    to_json_string(&result)
}

#[tauri::command]
fn add_blocker_cmd(app: AppHandle, state: State<AppState>, root: String, blocker: String) -> Result<String, String> {
    let index_db_path = state.index_db_path.to_string_lossy().into_owned();
    let result = add_blocker(
        &root,
        &blocker,
        desktop_actor(),
        desktop_session_context(),
        Some(index_db_path.as_str()),
    )
    .map_err(|error| error.to_string())?;
    let _ = load_state_payload(&app, &state);
    to_json_string(&result)
}

#[tauri::command]
fn clear_blocker_cmd(
    app: AppHandle,
    state: State<AppState>,
    root: String,
    blocker: Option<String>,
) -> Result<String, String> {
    let index_db_path = state.index_db_path.to_string_lossy().into_owned();
    let result = clear_blocker(
        &root,
        blocker.as_deref(),
        desktop_actor(),
        desktop_session_context(),
        Some(index_db_path.as_str()),
    )
    .map_err(|error| error.to_string())?;
    let _ = load_state_payload(&app, &state);
    to_json_string(&result)
}

#[tauri::command]
fn add_note_cmd(app: AppHandle, state: State<AppState>, root: String, note: String) -> Result<String, String> {
    let index_db_path = state.index_db_path.to_string_lossy().into_owned();
    let result = add_note(
        &root,
        &note,
        desktop_actor(),
        desktop_session_context(),
        Some(index_db_path.as_str()),
    )
    .map_err(|error| error.to_string())?;
    let _ = load_state_payload(&app, &state);
    to_json_string(&result)
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
    let index_db_path = state.index_db_path.to_string_lossy().into_owned();
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
        Some(index_db_path.as_str()),
    )
    .map_err(|error| error.to_string())?;
    let _ = load_state_payload(&app, &state);
    to_json_string(&result)
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
        mark_clients_stale(runtime, "tokenRotated");
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
}

#[tauri::command]
fn get_bridge_client_snippets(
    app: AppHandle,
    state: State<AppState>,
    args: GetBridgeSnippetsArgs,
) -> Result<String, String> {
    let settings = ensure_settings(&state)?;
    let executable = current_projectctl_path()?;
    let url = {
        let guard = state
            .bridge
            .lock()
            .map_err(|_| "bridge mutex poisoned".to_string())?;
        resolve_bridge_url(guard.runtime.bound_port.unwrap_or(settings.mcp.port))
    };
    let snippets = {
        let mut guard = state
            .bridge
            .lock()
            .map_err(|_| "bridge mutex poisoned".to_string())?;
        let snippet = build_client_snippet(
            &args.kind,
            &url,
            &settings.mcp.token,
            &executable,
            &guard.runtime,
        )?;
        clear_client_stale(&mut guard.runtime, &args.kind);
        vec![snippet]
    };
    emit_bridge_state(&app, &state, "snippetsRefreshed")?;
    to_json_string(&snippets)
}

fn build_tray(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let project_item = MenuItem::with_id(app, "project", "Project: none", false, None::<&str>)
        .map_err(|error| error.to_string())?;
    let step_item =
        MenuItem::with_id(app, "step", "Step: none", false, None::<&str>).map_err(|error| error.to_string())?;
    let blockers_item = MenuItem::with_id(app, "blockers", "Blockers: 0", false, None::<&str>)
        .map_err(|error| error.to_string())?;
    let next_item = MenuItem::with_id(app, "next", "Next: none", false, None::<&str>)
        .map_err(|error| error.to_string())?;
    let open_item = MenuItem::with_id(app, "open", "Open dashboard", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let quit_item =
        MenuItem::with_id(app, "quit", "Quit", true, None::<&str>).map_err(|error| error.to_string())?;
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
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let support_dir = app_support_dir(app.handle())?;
            fs::create_dir_all(&support_dir).map_err(|error| error.to_string())?;
            let state = AppState {
                settings_path: support_dir.join("settings.json"),
                index_db_path: support_dir.join("workflow-index.sqlite"),
                watcher: Mutex::new(None),
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
            reload_watcher(app.handle(), &state_ref, &settings)?;
            if watched_roots_need_startup_refresh(&state_ref, &settings)? {
                let _ = refresh_projects_payload(app.handle(), &state_ref);
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

        assert!(watched_roots_need_startup_refresh(&state, &settings).expect("coverage check should work"));
        build_refreshed_payload(&state, &settings).expect("refresh payload should build");
        assert!(!watched_roots_need_startup_refresh(&state, &settings).expect("coverage should now exist"));
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
            index_db_path: Some(state.index_db_path.to_string_lossy().into_owned()),
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

        let refreshed = build_refreshed_payload(&state, &settings).expect("refresh should discover indexed repo");
        assert_eq!(refreshed.projects.len(), 1);
        assert_eq!(refreshed.board_projects.len(), 1);

        let repo_two = watched_root.join("repo-two");
        create_repo(&repo_two);

        let snapshot = build_snapshot_payload(&state, &settings).expect("snapshot should use index only");
        assert_eq!(snapshot.projects.len(), 1);
        assert!(snapshot.projects[0].root.ends_with("/watched-root/repo-one"));

        let refreshed_again = build_refreshed_payload(&state, &settings).expect("refresh should discover repo two");
        assert_eq!(refreshed_again.projects.len(), 2);
        assert!(refreshed_again
            .projects
            .iter()
            .any(|project| project.root.ends_with("/watched-root/repo-two")));
        assert_eq!(refreshed_again.board_projects.len(), 1);
    }
}
