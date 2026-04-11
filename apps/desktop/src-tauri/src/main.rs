#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    env,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
};

use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{
    menu::{MenuBuilder, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State,
};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Settings {
    watched_roots: Vec<String>,
    last_focused_project: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSummary {
    id: Option<String>,
    root: String,
    name: String,
    kind: Option<String>,
    owner: Option<String>,
    tags: Vec<String>,
    initialized: bool,
    status: String,
    stale: bool,
    missing: bool,
    current_step_id: Option<String>,
    current_step_title: Option<String>,
    last_updated_at: Option<String>,
    blocker_count: i64,
    total_step_count: i64,
    completed_step_count: i64,
    active_session_count: i64,
    focus_session_id: Option<String>,
    pending_proposal_count: i64,
    active_branch: Option<String>,
    next_action: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadStatePayload {
    settings: Settings,
    projects: Vec<ProjectSummary>,
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
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProjectctlRuntime {
    command: String,
    args: Vec<String>,
    current_dir: PathBuf,
}

fn push_unique_path(candidates: &mut Vec<PathBuf>, candidate: PathBuf) {
    if !candidates.iter().any(|existing| existing == &candidate) {
        candidates.push(candidate);
    }
}

fn first_existing_command(candidates: Vec<PathBuf>, fallback: &str) -> String {
    candidates
        .into_iter()
        .find(|candidate| candidate.exists())
        .map(|candidate| candidate.to_string_lossy().into_owned())
        .unwrap_or_else(|| fallback.to_string())
}

fn preferred_command_path(
    env_var: &str,
    home_relative_candidates: &[&str],
    absolute_candidates: &[&str],
    fallback: &str,
) -> String {
    let mut candidates = Vec::new();

    if let Ok(explicit) = env::var(env_var) {
        let explicit = explicit.trim();
        if !explicit.is_empty() {
            push_unique_path(&mut candidates, PathBuf::from(explicit));
        }
    }

    if let Ok(home) = env::var("HOME") {
        let home = PathBuf::from(home);
        for candidate in home_relative_candidates {
            push_unique_path(&mut candidates, home.join(candidate));
        }
    }

    for candidate in absolute_candidates {
        push_unique_path(&mut candidates, PathBuf::from(candidate));
    }

    first_existing_command(candidates, fallback)
}

fn node_command() -> String {
    preferred_command_path(
        "PARALLEL_NODE_BINARY",
        &[".volta/bin/node", ".fnm/current/bin/node"],
        &["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"],
        "node",
    )
}

fn preferred_cli_path() -> String {
    let mut entries = Vec::<String>::new();

    if let Ok(current) = env::var("PATH") {
        for entry in current.split(':').filter(|entry| !entry.is_empty()) {
            if !entries.iter().any(|existing| existing == entry) {
                entries.push(entry.to_string());
            }
        }
    }

    let mut candidate_paths = Vec::new();
    if let Ok(home) = env::var("HOME") {
        let home = PathBuf::from(home);
        push_unique_path(&mut candidate_paths, home.join(".volta/bin"));
        push_unique_path(&mut candidate_paths, home.join(".fnm/current/bin"));
    }
    for candidate in [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        push_unique_path(&mut candidate_paths, PathBuf::from(candidate));
    }

    for candidate in candidate_paths {
        let entry = candidate.to_string_lossy().into_owned();
        if !entries.iter().any(|existing| existing == &entry) {
            entries.push(entry);
        }
    }

    entries.join(":")
}

fn workspace_root() -> Option<PathBuf> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .ok()
}

fn app_support_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| error.to_string())
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

fn bundled_projectctl_entry(resource_dir: &Path) -> PathBuf {
    resource_dir.join("app/projectctl/index.cjs")
}

fn resolve_projectctl_runtime(
    resource_dir: Option<&Path>,
    workspace_root: Option<&Path>,
) -> Result<ProjectctlRuntime, String> {
    if let Some(resource_dir) = resource_dir {
        let bundled_entry = bundled_projectctl_entry(resource_dir);
        if bundled_entry.exists() {
            return Ok(ProjectctlRuntime {
                command: node_command(),
                args: vec![bundled_entry.to_string_lossy().into_owned()],
                current_dir: resource_dir.to_path_buf(),
            });
        }
    }

    if let Some(workspace_root) = workspace_root {
        let dist_entry = workspace_root.join("packages/projectctl/dist/index.js");
        if dist_entry.exists() {
            return Ok(ProjectctlRuntime {
                command: node_command(),
                args: vec![dist_entry.to_string_lossy().into_owned()],
                current_dir: workspace_root.to_path_buf(),
            });
        }

        let source_entry = workspace_root.join("packages/projectctl/src/index.ts");
        if source_entry.exists() {
            return Ok(ProjectctlRuntime {
                command: "pnpm".to_string(),
                args: vec![
                    "--dir".to_string(),
                    workspace_root.to_string_lossy().into_owned(),
                    "exec".to_string(),
                    "tsx".to_string(),
                    source_entry.to_string_lossy().into_owned(),
                ],
                current_dir: workspace_root.to_path_buf(),
            });
        }
    }

    Err("Could not locate bundled or workspace projectctl runtime".to_string())
}

fn projectctl_runtime(app: &AppHandle) -> Result<ProjectctlRuntime, String> {
    let resource_dir = app.path().resource_dir().ok();
    let workspace_root = workspace_root();
    resolve_projectctl_runtime(resource_dir.as_deref(), workspace_root.as_deref())
}

fn run_projectctl(app: &AppHandle, args: &[String], state: &AppState) -> Result<Value, String> {
    run_projectctl_with_env(app, args, state, &[])
}

fn run_projectctl_with_env(
    app: &AppHandle,
    args: &[String],
    state: &AppState,
    extra_envs: &[(&str, &str)],
) -> Result<Value, String> {
    if let Some(parent) = state.index_db_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let runtime = projectctl_runtime(app)?;
    let mut base_args = runtime.args;
    base_args.extend_from_slice(args);
    base_args.push("--json".to_string());
    base_args.push("--index-db".to_string());
    base_args.push(state.index_db_path.to_string_lossy().into_owned());

    let command_name = runtime.command.clone();
    let mut command = Command::new(&runtime.command);
    command.args(base_args).current_dir(&runtime.current_dir);
    command.env("PATH", preferred_cli_path());
    for (key, value) in extra_envs {
        command.env(key, value);
    }

    let output = command
        .output()
        .map_err(|error| format!("Failed to launch {command_name}: {error}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())
}

fn projectctl_actor_args(source: &str, actor: &str) -> Vec<String> {
    vec![
        "--source".to_string(),
        source.to_string(),
        "--actor".to_string(),
        actor.to_string(),
    ]
}

fn to_json_string<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| error.to_string())
}

fn sync_tray(app: &AppHandle, state: &AppState, payload: &LoadStatePayload) -> Result<(), String> {
    let handles_guard = state.tray_handles.lock().map_err(|_| "tray mutex poisoned".to_string())?;
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
    let mut watcher = RecommendedWatcher::new(
        move |result: Result<notify::Event, notify::Error>| {
            if result.is_ok() {
                let _ = app_handle.emit("workflow://changed", ());
            }
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

    let mut guard = state.watcher.lock().map_err(|_| "watcher mutex poisoned".to_string())?;
    *guard = Some(watcher);
    Ok(())
}

fn load_state_payload(app: &AppHandle, state: &AppState) -> Result<LoadStatePayload, String> {
    let settings = ensure_settings(state)?;
    let mut args = vec!["list".to_string()];
    for root in &settings.watched_roots {
        args.push(root.clone());
    }

    let projects = if settings.watched_roots.is_empty() {
        Vec::new()
    } else {
        serde_json::from_value(run_projectctl(app, &args, state)?).map_err(|error| error.to_string())?
    };

    let payload = LoadStatePayload { settings, projects };
    if let Err(error) = sync_tray(app, state, &payload) {
        eprintln!("workflow desktop: tray sync failed during load_state_payload: {error}");
    }
    Ok(payload)
}

#[tauri::command]
fn load_state(app: AppHandle, state: State<AppState>) -> Result<String, String> {
    let payload = load_state_payload(&app, &state)?;
    to_json_string(&payload)
}

#[tauri::command]
fn refresh_projects(app: AppHandle, state: State<AppState>) -> Result<String, String> {
    let payload = load_state_payload(&app, &state)?;
    to_json_string(&payload)
}

#[tauri::command]
fn add_watch_root(app: AppHandle, state: State<AppState>, root: String) -> Result<String, String> {
    let mut settings = ensure_settings(&state)?;
    let root = resolve_input_path(&root)?
        .to_string_lossy()
        .into_owned();

    if !settings.watched_roots.contains(&root) {
        settings.watched_roots.push(root);
        settings.watched_roots.sort();
    }

    save_settings(&state, &settings)?;
    reload_watcher(&app, &state, &settings)?;
    let payload = load_state_payload(&app, &state)?;
    to_json_string(&payload)
}

#[tauri::command]
fn remove_watch_root(app: AppHandle, state: State<AppState>, root: String) -> Result<String, String> {
    let mut settings = ensure_settings(&state)?;
    settings.watched_roots.retain(|candidate| candidate != &root);
    if settings.last_focused_project.as_deref() == Some(root.as_str()) {
        settings.last_focused_project = None;
    }
    save_settings(&state, &settings)?;
    reload_watcher(&app, &state, &settings)?;
    let payload = load_state_payload(&app, &state)?;
    to_json_string(&payload)
}

#[tauri::command]
fn set_last_focused_project(
    app: AppHandle,
    state: State<AppState>,
    root: Option<String>,
) -> Result<String, String> {
    let mut settings = ensure_settings(&state)?;
    settings.last_focused_project = root;
    save_settings(&state, &settings)?;
    let payload = load_state_payload(&app, &state)?;
    to_json_string(&payload)
}

#[tauri::command]
fn get_project(app: AppHandle, state: State<AppState>, root: String) -> Result<String, String> {
    let result = run_projectctl(
        &app,
        &vec!["show".to_string(), "--root".to_string(), root.clone()],
        &state,
    )?;
    let _ = load_state_payload(&app, &state);
    to_json_string(&result)
}

#[tauri::command]
fn init_project(app: AppHandle, state: State<AppState>, root: String, name: String) -> Result<String, String> {
    let mut args = vec![
        "init".to_string(),
        "--root".to_string(),
        root.clone(),
        "--name".to_string(),
        name,
    ];
    args.extend(projectctl_actor_args("desktop", "desktop-user"));
    let result = run_projectctl(&app, &args, &state)?;
    let mut settings = ensure_settings(&state)?;
    settings.last_focused_project = Some(root);
    save_settings(&state, &settings)?;
    let payload = load_state_payload(&app, &state)?;
    let _ = sync_tray(&app, &state, &payload);
    to_json_string(&result)
}

#[tauri::command]
fn start_step_cmd(app: AppHandle, state: State<AppState>, root: String, step_id: String) -> Result<String, String> {
    let mut args = vec![
        "step".to_string(),
        "start".to_string(),
        step_id,
        "--root".to_string(),
        root,
    ];
    args.extend(projectctl_actor_args("desktop", "desktop-user"));
    let result = run_projectctl_with_env(
        &app,
        &args,
        &state,
        &[("PROJECT_WORKFLOW_ALLOW_HUMAN_ACTIONS", "1")],
    )?;
    let _ = load_state_payload(&app, &state);
    to_json_string(&result)
}

#[tauri::command]
fn complete_step_cmd(app: AppHandle, state: State<AppState>, root: String, step_id: String) -> Result<String, String> {
    let mut args = vec![
        "step".to_string(),
        "done".to_string(),
        step_id,
        "--root".to_string(),
        root,
    ];
    args.extend(projectctl_actor_args("desktop", "desktop-user"));
    let result = run_projectctl(&app, &args, &state)?;
    let _ = load_state_payload(&app, &state);
    to_json_string(&result)
}

#[tauri::command]
fn add_blocker_cmd(app: AppHandle, state: State<AppState>, root: String, blocker: String) -> Result<String, String> {
    let mut args = vec![
        "blocker".to_string(),
        "add".to_string(),
        blocker,
        "--root".to_string(),
        root,
    ];
    args.extend(projectctl_actor_args("desktop", "desktop-user"));
    let result = run_projectctl(&app, &args, &state)?;
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
    let mut args = vec!["blocker".to_string(), "clear".to_string()];
    if let Some(blocker) = blocker {
        args.push(blocker);
    }
    args.push("--root".to_string());
    args.push(root);
    args.extend(projectctl_actor_args("desktop", "desktop-user"));
    let result = run_projectctl(&app, &args, &state)?;
    let _ = load_state_payload(&app, &state);
    to_json_string(&result)
}

#[tauri::command]
fn add_note_cmd(app: AppHandle, state: State<AppState>, root: String, note: String) -> Result<String, String> {
    let mut args = vec![
        "note".to_string(),
        "add".to_string(),
        note,
        "--root".to_string(),
        root,
    ];
    args.extend(projectctl_actor_args("desktop", "desktop-user"));
    let result = run_projectctl(&app, &args, &state)?;
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
    let mut args = vec![
        "decision".to_string(),
        "propose".to_string(),
        "--root".to_string(),
        root,
        "--title".to_string(),
        title,
        "--context".to_string(),
        context,
        "--decision".to_string(),
        decision,
        "--impact".to_string(),
        impact,
    ];
    args.extend(projectctl_actor_args("desktop", "desktop-user"));
    let result = run_projectctl(&app, &args, &state)?;
    let _ = load_state_payload(&app, &state);
    to_json_string(&result)
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

    let mut guard = state.tray_handles.lock().map_err(|_| "tray mutex poisoned".to_string())?;
    *guard = Some(TrayMenuHandles {
        project: project_item,
        step: step_item,
        blockers: blockers_item,
        next_action: next_item,
    });
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let support_dir = app_support_dir(app.handle())?;
            fs::create_dir_all(&support_dir).map_err(|error| error.to_string())?;
            let state = AppState {
                settings_path: support_dir.join("settings.json"),
                index_db_path: support_dir.join("workflow-index.sqlite"),
                watcher: Mutex::new(None),
                tray_handles: Mutex::new(None),
            };

            app.manage(state);
            let state_ref = app.state::<AppState>();
            build_tray(app.handle(), &state_ref)?;
            let settings = ensure_settings(&state_ref)?;
            reload_watcher(app.handle(), &state_ref, &settings)?;
            let _ = load_state_payload(app.handle(), &state_ref);
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{bundled_projectctl_entry, first_existing_command, resolve_projectctl_runtime};
    use std::{
        fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    fn temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("parallel-{prefix}-{unique}"));
        fs::create_dir_all(&path).expect("temp dir should be created");
        path
    }

    fn write_file(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("parent dir should be created");
        }
        fs::write(path, "console.log('ok');").expect("file should be written");
    }

    #[test]
    fn prefers_bundled_projectctl_when_available() {
        let root = temp_dir("bundled-runtime");
        let resource_dir = root.join("Resources");
        let workspace_root = root.join("workspace");
        let bundled_entry = bundled_projectctl_entry(&resource_dir);
        let workspace_entry = workspace_root.join("packages/projectctl/dist/index.js");

        write_file(&bundled_entry);
        write_file(&workspace_entry);

        let runtime =
            resolve_projectctl_runtime(Some(&resource_dir), Some(&workspace_root)).expect("runtime should resolve");

        assert!(runtime.command.ends_with("node"));
        assert_eq!(runtime.args, vec![bundled_entry.to_string_lossy().into_owned()]);
        assert_eq!(runtime.current_dir, resource_dir);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn prefers_existing_absolute_command_path() {
        let root = temp_dir("command-resolution");
        let missing = root.join("missing-node");
        let existing = root.join("node");
        write_file(&existing);

        let command = first_existing_command(vec![missing, existing.clone()], "node");

        assert_eq!(command, existing.to_string_lossy().into_owned());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn falls_back_to_workspace_dist_when_bundle_missing() {
        let root = temp_dir("workspace-runtime");
        let resource_dir = root.join("Resources");
        let workspace_root = root.join("workspace");
        let workspace_entry = workspace_root.join("packages/projectctl/dist/index.js");

        fs::create_dir_all(&resource_dir).expect("resource dir should exist");
        write_file(&workspace_entry);

        let runtime =
            resolve_projectctl_runtime(Some(&resource_dir), Some(&workspace_root)).expect("runtime should resolve");

        assert!(runtime.command.ends_with("node"));
        assert_eq!(runtime.args, vec![workspace_entry.to_string_lossy().into_owned()]);
        assert_eq!(runtime.current_dir, workspace_root);

        let _ = fs::remove_dir_all(root);
    }
}
