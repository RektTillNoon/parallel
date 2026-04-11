#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    env, fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use parallel_workflow_core::{
    add_blocker, add_note, clear_blocker, complete_step, get_project as get_project_service,
    init_project as init_project_service, list_projects, propose_decision, start_step,
    ActivitySource, DecisionProposalInput, InitProjectInput, MutationActor, ProjectSummary,
    SessionContextInput,
};
use serde::{Deserialize, Serialize};
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

    let mut guard = state
        .watcher
        .lock()
        .map_err(|_| "watcher mutex poisoned".to_string())?;
    *guard = Some(watcher);
    Ok(())
}

fn load_state_payload(app: &AppHandle, state: &AppState) -> Result<LoadStatePayload, String> {
    let settings = ensure_settings(state)?;
    let projects = if settings.watched_roots.is_empty() {
        Vec::new()
    } else {
        let index_db_path = state.index_db_path.to_string_lossy().into_owned();
        list_projects(&settings.watched_roots, Some(index_db_path.as_str())).map_err(|error| error.to_string())?
    };

    let payload = LoadStatePayload { settings, projects };
    if let Err(error) = sync_tray(app, state, &payload) {
        eprintln!("workflow desktop: tray sync failed during load_state_payload: {error}");
    }
    Ok(payload)
}

#[tauri::command]
fn load_state(app: AppHandle, state: State<AppState>) -> Result<String, String> {
    to_json_string(&load_state_payload(&app, &state)?)
}

#[tauri::command]
fn refresh_projects(app: AppHandle, state: State<AppState>) -> Result<String, String> {
    to_json_string(&load_state_payload(&app, &state)?)
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
    to_json_string(&load_state_payload(&app, &state)?)
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
    to_json_string(&load_state_payload(&app, &state)?)
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
    to_json_string(&load_state_payload(&app, &state)?)
}

#[tauri::command]
fn get_project(app: AppHandle, state: State<AppState>, root: String) -> Result<String, String> {
    let result = get_project_service(&root).map_err(|error| error.to_string())?;
    let _ = load_state_payload(&app, &state);
    to_json_string(&result)
}

#[tauri::command]
fn init_project(app: AppHandle, state: State<AppState>, root: String, name: String) -> Result<String, String> {
    let index_db_path = state.index_db_path.to_string_lossy().into_owned();
    let result = init_project_service(InitProjectInput {
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
    let payload = load_state_payload(&app, &state)?;
    let _ = sync_tray(&app, &state, &payload);
    to_json_string(&result)
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
