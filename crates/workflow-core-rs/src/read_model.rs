use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use anyhow::Result;

use crate::{
    discovery::discover_project_roots,
    index_store::IndexStore,
    models::{
        BoardProjectDetail, BoardStepDetail, DiscoverySource, ProjectIndexRecord, ProjectSummary,
        SessionStatus,
    },
    root_paths::{canonicalize_root, most_specific_watched_root, normalize_roots},
    services::{
        determine_project_stale, find_current_step_title, get_plan_progress, get_project,
        locate_step,
    },
    storage_yaml::{get_workflow_paths, now_iso, path_exists, read_git_branch},
};

#[derive(Clone)]
struct CachedProjection<T> {
    fingerprint: String,
    value: T,
}

static SUMMARY_CACHE: OnceLock<Mutex<HashMap<String, CachedProjection<ProjectSummary>>>> =
    OnceLock::new();
static BOARD_CACHE: OnceLock<Mutex<HashMap<String, CachedProjection<BoardProjectDetail>>>> =
    OnceLock::new();

fn summary_cache() -> &'static Mutex<HashMap<String, CachedProjection<ProjectSummary>>> {
    SUMMARY_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn board_cache() -> &'static Mutex<HashMap<String, CachedProjection<BoardProjectDetail>>> {
    BOARD_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn file_fingerprint(paths: &[PathBuf]) -> String {
    paths
        .iter()
        .map(|path| match fs::metadata(path) {
            Ok(metadata) => {
                let modified = metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis())
                    .unwrap_or_default();
                format!("{}:{modified}:{}", path.display(), metadata.len())
            }
            Err(_) => format!("{}:missing", path.display()),
        })
        .collect::<Vec<_>>()
        .join("|")
}

fn summary_fingerprint(root: &str) -> String {
    let root = canonicalize_root(root);
    let paths = get_workflow_paths(&root);
    file_fingerprint(&[
        paths.manifest_path,
        paths.plan_path,
        paths.runtime_path,
        paths.sessions_path,
        paths.proposed_decisions_path,
        Path::new(&root).join(".git").join("HEAD"),
    ])
}

fn board_fingerprint(root: &str) -> String {
    let root = canonicalize_root(root);
    let paths = get_workflow_paths(&root);
    file_fingerprint(&[
        paths.plan_path,
        paths.runtime_path,
        paths.sessions_path,
        paths.activity_path,
    ])
}

fn build_uninitialized_summary(root: &str) -> Result<ProjectSummary> {
    let root = canonicalize_root(root);
    let name = Path::new(&root)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(&root)
        .to_string();
    let repo_exists = path_exists(&root);
    Ok(ProjectSummary {
        id: None,
        name,
        root: root.clone(),
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
        active_branch: read_git_branch(&root)?,
        pending_proposal_count: 0,
        discovery_source: None,
        discovery_path: None,
        last_seen_at: Some(now_iso()),
    })
}

fn build_initialized_summary(root: &str) -> Result<ProjectSummary> {
    let root = canonicalize_root(root);
    let detail = get_project(&root)?;
    let repo_exists = path_exists(&root);
    let (total, completed) = get_plan_progress(&detail.plan);
    Ok(ProjectSummary {
        id: Some(detail.manifest.id),
        name: detail.manifest.name,
        root,
        kind: Some(detail.manifest.kind),
        owner: Some(detail.manifest.owner),
        tags: detail.manifest.tags,
        initialized: true,
        status: format!("{:?}", detail.runtime.status)
            .to_lowercase()
            .replace("stepstatus::", ""),
        stale: determine_project_stale(Some(&detail.runtime), repo_exists),
        missing: !repo_exists,
        current_step_id: detail.runtime.current_step_id.clone(),
        current_step_title: find_current_step_title(
            &detail.plan,
            detail.runtime.current_step_id.as_deref(),
        ),
        blocker_count: detail.runtime.blockers.len() as i64,
        total_step_count: total,
        completed_step_count: completed,
        active_session_count: detail
            .sessions
            .iter()
            .filter(|session| session.status == SessionStatus::Active)
            .count() as i64,
        focus_session_id: detail.runtime.focus_session_id.clone(),
        last_updated_at: Some(detail.runtime.last_updated_at.clone()),
        next_action: Some(detail.runtime.next_action.clone()),
        active_branch: detail.runtime.active_branch.clone(),
        pending_proposal_count: detail.pending_proposals.len() as i64,
        discovery_source: Some(DiscoverySource::Parallel),
        discovery_path: None,
        last_seen_at: Some(now_iso()),
    })
}

pub fn project_summary(root: &str) -> Result<ProjectSummary> {
    let root = canonicalize_root(root);
    let fingerprint = summary_fingerprint(&root);
    if let Ok(cache) = summary_cache().lock() {
        if let Some(cached) = cache.get(&root) {
            if cached.fingerprint == fingerprint {
                return Ok(cached.value.clone());
            }
        }
    }

    let summary = if path_exists(get_workflow_paths(&root).manifest_path) {
        build_initialized_summary(&root)?
    } else {
        build_uninitialized_summary(&root)?
    };

    if let Ok(mut cache) = summary_cache().lock() {
        cache.insert(
            root,
            CachedProjection {
                fingerprint,
                value: summary.clone(),
            },
        );
    }
    Ok(summary)
}

fn refreshed_indexed_summary(record: ProjectIndexRecord) -> Result<ProjectSummary> {
    if path_exists(&record.summary.root) {
        let mut summary = project_summary(&record.summary.root)?;
        summary.discovery_source = record.summary.discovery_source;
        summary.discovery_path = record.summary.discovery_path;
        return Ok(summary);
    }

    let mut summary = record.summary;
    summary.missing = true;
    summary.stale = true;
    Ok(summary)
}

pub fn board_project_detail(root: &str) -> Result<BoardProjectDetail> {
    let root = canonicalize_root(root);
    let fingerprint = board_fingerprint(&root);
    if let Ok(cache) = board_cache().lock() {
        if let Some(cached) = cache.get(&root) {
            if cached.fingerprint == fingerprint {
                return Ok(cached.value.clone());
            }
        }
    }

    let detail = get_project(&root)?;
    let mut sessions = detail
        .sessions
        .into_iter()
        .filter(|session| session.status == SessionStatus::Active)
        .collect::<Vec<_>>();
    let mut recent_activity = detail.recent_activity;
    recent_activity.sort_by(|left, right| right.timestamp.cmp(&left.timestamp));
    recent_activity.truncate(5);

    let mut active_step_lookup = BTreeMap::new();
    for session in &sessions {
        let Some(step_id) = session.owned_step_id.as_deref() else {
            continue;
        };
        let Some((_, _, _, step)) = locate_step(&detail.plan, step_id) else {
            continue;
        };
        active_step_lookup
            .entry(step.id.clone())
            .or_insert(BoardStepDetail {
                title: step.title.clone(),
                summary: step.summary.clone(),
            });
    }
    if let Some(step_id) = detail.runtime.current_step_id.as_deref() {
        if let Some((_, _, _, step)) = locate_step(&detail.plan, step_id) {
            active_step_lookup
                .entry(step.id.clone())
                .or_insert(BoardStepDetail {
                    title: step.title.clone(),
                    summary: step.summary.clone(),
                });
        }
    }

    sessions.sort_by(|left, right| right.last_updated_at.cmp(&left.last_updated_at));
    let board = BoardProjectDetail {
        root: root.clone(),
        sessions,
        runtime_next_action: detail.runtime.next_action,
        blockers: detail.runtime.blockers,
        recent_activity,
        active_step_lookup,
    };

    if let Ok(mut cache) = board_cache().lock() {
        cache.insert(
            root,
            CachedProjection {
                fingerprint,
                value: board.clone(),
            },
        );
    }
    Ok(board)
}

pub fn list_projects(roots: &[String], index_db_path: &str) -> Result<Vec<ProjectSummary>> {
    let roots = normalize_roots(roots.iter().cloned());
    let store = IndexStore::new(index_db_path.to_string())?;
    let indexed_projects = store.list_projects(&roots)?;
    let initialized_index = indexed_projects
        .into_iter()
        .filter(|record| record.summary.initialized)
        .map(|record| (record.summary.root.clone(), record))
        .collect::<HashMap<_, _>>();
    let discovered_projects = discover_project_roots(&roots, &store)?;

    for discovered in &discovered_projects {
        let repo_root = &discovered.root;
        let mut summary = if let Some(existing_record) = initialized_index.get(repo_root) {
            if !path_exists(repo_root) {
                let mut summary = existing_record.summary.clone();
                summary.missing = true;
                summary.stale = true;
                summary
            } else {
                project_summary(repo_root)?
            }
        } else {
            project_summary(repo_root)?
        };
        summary.discovery_source = Some(discovered.discovery_source);
        summary.discovery_path = discovered.discovery_path.clone();
        let watched_root = most_specific_watched_root(repo_root, &roots);
        store.sync_project(&ProjectIndexRecord {
            summary,
            watched_root,
        })?;
    }

    store.mark_missing_projects(
        &roots,
        &discovered_projects
            .iter()
            .map(|project| project.root.clone())
            .collect::<Vec<_>>(),
    )?;
    let scanned_at = now_iso();
    for watched_root in &roots {
        store.record_watched_root_scan(watched_root, &scanned_at)?;
        store.add_watched_root(watched_root, &scanned_at)?;
    }

    Ok(store
        .list_projects(&roots)?
        .into_iter()
        .map(|record| record.summary)
        .collect())
}

pub fn list_indexed_projects(roots: &[String], index_db_path: &str) -> Result<Vec<ProjectSummary>> {
    let roots = normalize_roots(roots.iter().cloned());
    let store = IndexStore::new(index_db_path.to_string())?;
    store
        .list_projects(&roots)?
        .into_iter()
        .map(refreshed_indexed_summary)
        .collect()
}

#[cfg(test)]
mod tests {
    use anyhow::Result;
    use tempfile::tempdir;

    use crate::{index_store::IndexStore, ActivitySource, InitProjectInput};

    use super::*;

    fn with_home<T>(home: &std::path::Path, f: impl FnOnce() -> Result<T>) -> Result<T> {
        let _guard = crate::test_home_lock()
            .lock()
            .expect("home lock should not poison");
        let prior_home = std::env::var_os("HOME");
        std::env::set_var("HOME", home);
        let result = f();
        if let Some(value) = prior_home {
            std::env::set_var("HOME", value);
        } else {
            std::env::remove_var("HOME");
        }
        result
    }

    #[test]
    fn memoized_summary_invalidates_when_runtime_changes() -> Result<()> {
        let temp = tempdir()?;
        let root = temp.path().join("repo");
        fs::create_dir_all(root.join(".git"))?;
        fs::write(root.join(".git/HEAD"), "ref: refs/heads/main\n")?;
        let index_db = temp
            .path()
            .join("workflow-index.sqlite")
            .display()
            .to_string();

        crate::init_project(InitProjectInput {
            root: root.display().to_string(),
            actor: "tester".to_string(),
            source: ActivitySource::Cli,
            name: Some("Repo".to_string()),
            kind: None,
            owner: None,
            tags: None,
            index_db_path: index_db,
        })?;

        let first = project_summary(root.display().to_string().as_str())?;
        let runtime_path = get_workflow_paths(&root).runtime_path;
        let raw = fs::read_to_string(&runtime_path)?;
        fs::write(&runtime_path, raw.replace("todo", "blocked"))?;

        let second = project_summary(root.display().to_string().as_str())?;
        assert_ne!(first.status, second.status);
        Ok(())
    }

    #[test]
    fn refresh_discovers_tool_backed_projects_and_skips_hidden_ones() -> Result<()> {
        let temp = tempdir()?;
        let watched_root = temp.path().join("watched");
        fs::create_dir_all(&watched_root)?;

        let git_project = watched_root.join("git-project");
        fs::create_dir_all(git_project.join("nested"))?;

        let codex_home = temp.path().join(".codex");
        fs::create_dir_all(&codex_home)?;
        let codex_db = codex_home.join("state_7.sqlite");
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
            rusqlite::params![git_project.join("nested").display().to_string()],
        )?;

        let hidden_project = watched_root.join(".hidden-project");
        fs::create_dir_all(&hidden_project)?;

        let index_db = temp
            .path()
            .join("workflow-index.sqlite")
            .display()
            .to_string();
        let summaries = with_home(temp.path(), || {
            list_projects(&[watched_root.display().to_string()], &index_db)
        })?;

        assert_eq!(summaries.len(), 1);
        assert!(summaries
            .iter()
            .any(|summary| summary.root.ends_with("/watched/git-project")));
        assert!(!summaries
            .iter()
            .any(|summary| summary.root.ends_with("/watched/.hidden-project")));
        Ok(())
    }

    #[test]
    fn refresh_ignores_plain_directories_without_parallel_or_tool_backing() -> Result<()> {
        let temp = tempdir()?;
        let watched_root = temp.path().join("watched");
        fs::create_dir_all(watched_root.join("plain-project"))?;

        let index_db = temp
            .path()
            .join("workflow-index.sqlite")
            .display()
            .to_string();

        let summaries = list_projects(&[watched_root.display().to_string()], &index_db)?;
        assert!(summaries.is_empty());
        Ok(())
    }

    #[test]
    fn refresh_prunes_uninitialized_candidates_that_are_no_longer_backed() -> Result<()> {
        let temp = tempdir()?;
        let watched_root = temp.path().join("watched");
        fs::create_dir_all(&watched_root)?;

        let stale_candidate = watched_root.join("plain-project");
        let index_db = temp
            .path()
            .join("workflow-index.sqlite")
            .display()
            .to_string();
        let store = IndexStore::new(index_db.clone())?;
        store.sync_project_root_seed(stale_candidate.display().to_string().as_str())?;

        let summaries = list_projects(&[watched_root.display().to_string()], &index_db)?;
        assert!(summaries.is_empty());
        Ok(())
    }

    #[test]
    fn refresh_backfills_nested_initialized_projects_when_index_has_none() -> Result<()> {
        let temp = tempdir()?;
        let watched_root = temp.path().join("watched");
        fs::create_dir_all(&watched_root)?;

        let project_root = watched_root.join("group").join("parallel-project");
        fs::create_dir_all(&project_root)?;

        let seed_index_db = temp.path().join("seed-index.sqlite").display().to_string();
        crate::init_project(InitProjectInput {
            root: project_root.display().to_string(),
            actor: "tester".to_string(),
            source: ActivitySource::Cli,
            name: Some("Parallel Project".to_string()),
            kind: None,
            owner: None,
            tags: None,
            index_db_path: seed_index_db,
        })?;

        let refresh_index_db = temp
            .path()
            .join("refresh-index.sqlite")
            .display()
            .to_string();

        let summaries = list_projects(&[watched_root.display().to_string()], &refresh_index_db)?;
        assert_eq!(summaries.len(), 1);
        assert_eq!(
            summaries[0].root,
            fs::canonicalize(&project_root)?.to_string_lossy()
        );
        assert!(summaries[0].initialized);
        Ok(())
    }

    #[test]
    fn refresh_assigns_backfilled_projects_to_the_most_specific_watched_root() -> Result<()> {
        let temp = tempdir()?;
        let watched_root = temp.path().join("watched");
        let nested_watched_root = watched_root.join("group");
        fs::create_dir_all(&nested_watched_root)?;

        let project_root = nested_watched_root.join("parallel-project");
        fs::create_dir_all(&project_root)?;

        let seed_index_db = temp.path().join("seed-index.sqlite").display().to_string();
        crate::init_project(InitProjectInput {
            root: project_root.display().to_string(),
            actor: "tester".to_string(),
            source: ActivitySource::Cli,
            name: Some("Parallel Project".to_string()),
            kind: None,
            owner: None,
            tags: None,
            index_db_path: seed_index_db,
        })?;

        let refresh_index_db = temp
            .path()
            .join("refresh-index.sqlite")
            .display()
            .to_string();
        let roots = vec![
            watched_root.display().to_string(),
            nested_watched_root.display().to_string(),
        ];

        let _ = list_projects(&roots, &refresh_index_db)?;
        let store = IndexStore::new(refresh_index_db)?;

        assert_eq!(
            store.project_watched_root(
                fs::canonicalize(&project_root)?.to_string_lossy().as_ref()
            )?,
            Some(
                fs::canonicalize(&nested_watched_root)?
                    .to_string_lossy()
                    .into_owned()
            )
        );
        Ok(())
    }

    #[test]
    fn refresh_prefers_codex_provenance_over_claude_for_the_same_surfaced_root() -> Result<()> {
        let temp = tempdir()?;
        let watched_root = temp.path().join("watched");
        let project_root = watched_root.join("foo");
        let claude_nested_root = project_root.join("bar");
        fs::create_dir_all(&claude_nested_root)?;

        let codex_home = temp.path().join(".codex");
        fs::create_dir_all(&codex_home)?;
        let codex_db = codex_home.join("state_7.sqlite");
        let codex = rusqlite::Connection::open(&codex_db)?;
        codex.execute_batch(
            r#"
            CREATE TABLE threads (
              cwd TEXT,
              archived INTEGER NOT NULL DEFAULT 0
            );
            "#,
        )?;
        codex.execute(
            "INSERT INTO threads (cwd, archived) VALUES (?1, 0)",
            rusqlite::params![project_root.display().to_string()],
        )?;

        let claude_projects_root = temp.path().join(".claude").join("projects");
        fs::create_dir_all(claude_projects_root.join("foo"))?;
        fs::write(
            claude_projects_root.join("foo").join("session.jsonl"),
            format!(r#"{{"cwd":"{}"}}"#, claude_nested_root.display()),
        )?;

        let index_db = temp.path().join("workflow-index.sqlite");
        let summaries = with_home(temp.path(), || {
            list_projects(
                &[watched_root.display().to_string()],
                index_db.to_string_lossy().as_ref(),
            )
        })?;

        assert_eq!(summaries.len(), 1);
        assert_eq!(
            summaries[0].discovery_source,
            Some(crate::DiscoverySource::Codex)
        );
        assert_eq!(summaries[0].discovery_path, None);
        Ok(())
    }

    #[test]
    fn refresh_keeps_codex_backed_projects_visible_when_manifest_is_missing() -> Result<()> {
        let temp = tempdir()?;
        let watched_root = temp.path().join("watched");
        let project_root = watched_root.join("broken-project");
        fs::create_dir_all(project_root.join(".git"))?;
        fs::write(project_root.join(".git/HEAD"), "ref: refs/heads/main\n")?;
        fs::create_dir_all(project_root.join(".project-workflow"))?;

        let codex_home = temp.path().join(".codex");
        fs::create_dir_all(&codex_home)?;
        let codex_db = codex_home.join("state_11.sqlite");
        let codex = rusqlite::Connection::open(&codex_db)?;
        codex.execute_batch(
            r#"
            CREATE TABLE threads (
              cwd TEXT,
              archived INTEGER NOT NULL DEFAULT 0
            );
            "#,
        )?;
        codex.execute(
            "INSERT INTO threads (cwd, archived) VALUES (?1, 0)",
            rusqlite::params![project_root.display().to_string()],
        )?;

        let index_db = temp.path().join("workflow-index.sqlite");
        let summaries = with_home(temp.path(), || {
            list_projects(
                &[watched_root.display().to_string()],
                index_db.to_string_lossy().as_ref(),
            )
        })?;

        assert_eq!(summaries.len(), 1);
        assert_eq!(
            summaries[0].root,
            fs::canonicalize(&project_root)?.to_string_lossy()
        );
        assert!(!summaries[0].initialized);
        assert_eq!(
            summaries[0].discovery_source,
            Some(crate::DiscoverySource::Codex)
        );
        Ok(())
    }

    #[test]
    fn indexed_snapshot_round_trips_provenance_without_refresh() -> Result<()> {
        let temp = tempdir()?;
        let watched_root = temp.path().join("watched");
        let project_root = watched_root.join("foo");
        fs::create_dir_all(&project_root)?;

        let codex_home = temp.path().join(".codex");
        fs::create_dir_all(&codex_home)?;
        let codex_db = codex_home.join("state_5.sqlite");
        let codex = rusqlite::Connection::open(&codex_db)?;
        codex.execute_batch(
            r#"
            CREATE TABLE threads (
              cwd TEXT,
              archived INTEGER NOT NULL DEFAULT 0
            );
            "#,
        )?;
        codex.execute(
            "INSERT INTO threads (cwd, archived) VALUES (?1, 0)",
            rusqlite::params![project_root.display().to_string()],
        )?;

        let index_db = temp.path().join("workflow-index.sqlite");
        with_home(temp.path(), || {
            list_projects(
                &[watched_root.display().to_string()],
                index_db.to_string_lossy().as_ref(),
            )
        })?;

        let indexed = list_indexed_projects(
            &[watched_root.display().to_string()],
            index_db.to_string_lossy().as_ref(),
        )?;

        assert_eq!(indexed.len(), 1);
        assert_eq!(
            indexed[0].discovery_source,
            Some(crate::DiscoverySource::Codex)
        );
        assert_eq!(indexed[0].discovery_path, None);
        Ok(())
    }

    #[test]
    fn indexed_snapshot_degrades_when_manifest_is_missing() -> Result<()> {
        let temp = tempdir()?;
        let watched_root = temp.path().join("watched");
        fs::create_dir_all(&watched_root)?;

        let project_root = watched_root.join("parallel-project");
        fs::create_dir_all(project_root.join(".git"))?;
        fs::write(project_root.join(".git/HEAD"), "ref: refs/heads/main\n")?;

        let index_db = temp
            .path()
            .join("workflow-index.sqlite")
            .display()
            .to_string();
        crate::init_project(InitProjectInput {
            root: project_root.display().to_string(),
            actor: "tester".to_string(),
            source: ActivitySource::Cli,
            name: Some("Parallel Project".to_string()),
            kind: None,
            owner: None,
            tags: None,
            index_db_path: index_db.clone(),
        })?;

        let roots = vec![watched_root.display().to_string()];
        let _ = list_projects(&roots, &index_db)?;
        fs::remove_file(get_workflow_paths(&project_root).manifest_path)?;

        let indexed = list_indexed_projects(&roots, &index_db)?;
        assert_eq!(indexed.len(), 1);
        assert_eq!(
            indexed[0].root,
            fs::canonicalize(&project_root)?.to_string_lossy()
        );
        assert!(!indexed[0].initialized);
        Ok(())
    }
}
