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
        BoardProjectDetail, BoardStepDetail, ProjectIndexRecord, ProjectSummary, SessionStatus,
    },
    root_paths::{canonicalize_root, normalize_roots, root_belongs_to_watched_root},
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

    let summary = if path_exists(get_workflow_paths(&root).workflow_dir) {
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
        return project_summary(&record.summary.root);
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
    let discovered_roots = discover_project_roots(&roots)?;
    let store = IndexStore::new(index_db_path.to_string())?;

    for repo_root in &discovered_roots {
        let summary = project_summary(repo_root)?;
        let watched_root = roots
            .iter()
            .find(|candidate| root_belongs_to_watched_root(repo_root, candidate))
            .cloned()
            .unwrap_or_else(|| repo_root.to_string());
        store.sync_project(&ProjectIndexRecord {
            summary,
            watched_root,
        })?;
    }

    store.mark_missing_projects(&roots, &discovered_roots)?;
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

    use crate::{ActivitySource, InitProjectInput};

    use super::*;

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
    fn refresh_discovers_visible_plain_directories_and_skips_hidden_ones() -> Result<()> {
        let temp = tempdir()?;
        let watched_root = temp.path().join("watched");
        fs::create_dir_all(&watched_root)?;

        let plain_project = watched_root.join("plain-project");
        fs::create_dir_all(&plain_project)?;

        let git_project = watched_root.join("git-project");
        fs::create_dir_all(git_project.join(".git"))?;
        fs::write(git_project.join(".git/HEAD"), "ref: refs/heads/main\n")?;

        let hidden_project = watched_root.join(".hidden-project");
        fs::create_dir_all(&hidden_project)?;

        let index_db = temp
            .path()
            .join("workflow-index.sqlite")
            .display()
            .to_string();

        let summaries = list_projects(&[watched_root.display().to_string()], &index_db)?;

        assert_eq!(summaries.len(), 2);
        assert!(summaries
            .iter()
            .any(|summary| summary.root.ends_with("/watched/plain-project")));
        assert!(summaries
            .iter()
            .any(|summary| summary.root.ends_with("/watched/git-project")));
        assert!(!summaries
            .iter()
            .any(|summary| summary.root.ends_with("/watched/.hidden-project")));
        assert!(summaries
            .iter()
            .find(|summary| summary.root.ends_with("/watched/plain-project"))
            .is_some_and(|summary| !summary.initialized && summary.active_branch.is_none()));
        Ok(())
    }
}
