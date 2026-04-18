use std::{
    collections::{BTreeSet, HashMap},
    env, fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::Result;
use rusqlite::{Connection, Error as SqliteError, ErrorCode, OpenFlags};
use serde_json::Value;
use walkdir::WalkDir;

use crate::{
    index_store::IndexStore,
    root_paths::{canonicalize_root, normalize_roots, root_belongs_to_watched_root},
};

const REJECTED_FIRST_CHILD_NAMES: &[&str] = &["node_modules", ".pnpm"];
const CLAUDE_SCAN_BUDGET: Duration = Duration::from_secs(1);
const CODEX_BUSY_TIMEOUT: Duration = Duration::from_millis(50);

#[derive(Clone, Debug)]
struct ClaudeCwdCacheEntry {
    modified_ms: u128,
    size: u64,
    cwd: Option<String>,
}

static CLAUDE_CWD_CACHE: OnceLock<Mutex<HashMap<PathBuf, ClaudeCwdCacheEntry>>> = OnceLock::new();

fn claude_cwd_cache() -> &'static Mutex<HashMap<PathBuf, ClaudeCwdCacheEntry>> {
    CLAUDE_CWD_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

struct DiscoveryContext<'a> {
    codex_home: PathBuf,
    claude_projects_root: PathBuf,
    claude_budget: Duration,
    claude_cache: &'a Mutex<HashMap<PathBuf, ClaudeCwdCacheEntry>>,
}

impl<'a> DiscoveryContext<'a> {
    fn from_home(home_dir: PathBuf, claude_cache: &'a Mutex<HashMap<PathBuf, ClaudeCwdCacheEntry>>) -> Self {
        Self {
            codex_home: home_dir.join(".codex"),
            claude_projects_root: home_dir.join(".claude").join("projects"),
            claude_budget: CLAUDE_SCAN_BUDGET,
            claude_cache,
        }
    }
}

#[derive(Debug)]
struct ClaudeFileInfo {
    path: PathBuf,
    modified_ms: u128,
    size: u64,
}

enum ClaudeParseOutcome {
    Complete(Option<String>),
    TimedOut,
}

pub fn discover_project_roots(roots: &[String], store: &IndexStore) -> Result<Vec<String>> {
    let home_dir = env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(PathBuf::new);
    let context = DiscoveryContext::from_home(home_dir, claude_cwd_cache());
    discover_project_roots_with_context(roots, store, &context)
}

fn discover_project_roots_with_context(
    roots: &[String],
    store: &IndexStore,
    context: &DiscoveryContext<'_>,
) -> Result<Vec<String>> {
    let roots = normalize_roots(roots.iter().cloned());
    let initialized_records = store
        .list_projects(&roots)?
        .into_iter()
        .filter(|record| record.summary.initialized)
        .collect::<Vec<_>>();
    let initialized_roots = initialized_records
        .iter()
        .map(|record| record.summary.root.clone())
        .collect::<Vec<_>>();

    let mut discovered = initialized_roots.iter().cloned().collect::<BTreeSet<_>>();

    for watched_root in &roots {
        let has_initialized = initialized_records
            .iter()
            .any(|record| record.watched_root == *watched_root);
        if !has_initialized {
            for root in backfill_initialized_project_roots(watched_root)? {
                discovered.insert(root);
            }
        }
    }

    let external_paths = discover_codex_candidate_paths(&context.codex_home)?
        .into_iter()
        .chain(discover_claude_candidate_paths(context)?)
        .collect::<Vec<_>>();

    for path in external_paths {
        if let Some(root) = resolve_external_candidate_root(&path, &roots, &initialized_roots) {
            discovered.insert(root);
        }
    }

    Ok(discovered.into_iter().collect())
}

fn backfill_initialized_project_roots(watched_root: &str) -> Result<Vec<String>> {
    let watched_root = canonicalize_root(watched_root);
    let watched_root_path = Path::new(&watched_root);
    if !watched_root_path.is_dir() {
        return Ok(Vec::new());
    }

    let mut discovered = BTreeSet::new();
    for entry in WalkDir::new(watched_root_path)
        .follow_links(false)
        .into_iter()
        .filter_map(std::result::Result::ok)
    {
        if !entry.file_type().is_file() || entry.file_name() != "manifest.yaml" {
            continue;
        }

        let Some(workflow_dir) = entry.path().parent() else {
            continue;
        };
        if workflow_dir.file_name() != Some(std::ffi::OsStr::new(".project-workflow")) {
            continue;
        }
        let Some(project_root) = workflow_dir.parent() else {
            continue;
        };

        if let Some(root) = canonicalize_existing_path(project_root) {
            discovered.insert(root);
        }
    }

    Ok(discovered.into_iter().collect())
}

fn resolve_external_candidate_root(
    path: &str,
    watched_roots: &[String],
    initialized_roots: &[String],
) -> Option<String> {
    if let Some(initialized_root) = most_specific_matching_root(path, initialized_roots) {
        return Some(initialized_root);
    }

    let watched_root = most_specific_matching_root(path, watched_roots)?;
    if path == watched_root {
        return None;
    }

    collapse_to_first_child(path, &watched_root)
}

fn most_specific_matching_root(path: &str, candidates: &[String]) -> Option<String> {
    let mut matches = candidates
        .iter()
        .filter(|candidate| root_belongs_to_watched_root(path, candidate))
        .cloned()
        .collect::<Vec<_>>();
    matches.sort_by_key(|candidate| candidate.len());
    matches.pop()
}

fn collapse_to_first_child(path: &str, watched_root: &str) -> Option<String> {
    let path = Path::new(path);
    let watched_root_path = Path::new(watched_root);
    let relative = path.strip_prefix(watched_root_path).ok()?;
    let first_component = relative.components().next()?;
    let std::path::Component::Normal(name) = first_component else {
        return None;
    };
    let name = name.to_string_lossy();
    if should_reject_first_child(&name) {
        return None;
    }
    Some(watched_root_path.join(name.as_ref()).to_string_lossy().into_owned())
}

fn should_reject_first_child(name: &str) -> bool {
    name.starts_with('.')
        || REJECTED_FIRST_CHILD_NAMES
            .iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(name))
}

fn canonicalize_existing_path(path: &Path) -> Option<String> {
    if !path.exists() {
        return None;
    }
    fs::canonicalize(path)
        .ok()
        .map(|value| value.to_string_lossy().into_owned())
}

fn discover_codex_candidate_paths(codex_home: &Path) -> Result<Vec<String>> {
    let Some(database_path) = newest_codex_state_database(codex_home)? else {
        return Ok(Vec::new());
    };

    let Some(connection) = open_codex_database(&database_path) else {
        return Ok(Vec::new());
    };

    if !threads_table_supports_discovery(&connection)? {
        return Ok(Vec::new());
    }

    let mut statement = match connection
        .prepare("SELECT DISTINCT cwd FROM threads WHERE archived = 0 AND typeof(cwd) = 'text' AND cwd <> ''")
    {
        Ok(statement) => statement,
        Err(error) if is_sqlite_busy(&error) => return Ok(Vec::new()),
        Err(_) => return Ok(Vec::new()),
    };

    let rows = match statement.query_map([], |row| row.get::<_, String>(0)) {
        Ok(rows) => rows,
        Err(error) if is_sqlite_busy(&error) => return Ok(Vec::new()),
        Err(_) => return Ok(Vec::new()),
    };

    let mut discovered = BTreeSet::new();
    for row in rows {
        let cwd = match row {
            Ok(cwd) => cwd,
            Err(error) if is_sqlite_busy(&error) => return Ok(discovered.into_iter().collect()),
            Err(_) => continue,
        };
        if let Some(path) = canonicalize_existing_path(Path::new(cwd.trim())) {
            discovered.insert(path);
        }
    }

    Ok(discovered.into_iter().collect())
}

fn newest_codex_state_database(codex_home: &Path) -> Result<Option<PathBuf>> {
    let entries = match fs::read_dir(codex_home) {
        Ok(entries) => entries,
        Err(_) => return Ok(None),
    };

    let mut candidates = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let Some(version) = parse_codex_state_version(file_name) else {
            continue;
        };
        let modified_ms = entry
            .metadata()
            .ok()
            .map(|metadata| system_time_key(metadata.modified().ok()))
            .unwrap_or_default();
        candidates.push((version, modified_ms, path));
    }

    candidates.sort_by(|left, right| left.cmp(right));
    Ok(candidates.pop().map(|(_, _, path)| path))
}

fn parse_codex_state_version(file_name: &str) -> Option<u32> {
    file_name
        .strip_prefix("state_")?
        .strip_suffix(".sqlite")?
        .parse()
        .ok()
}

fn open_codex_database(path: &Path) -> Option<Connection> {
    let uri = format!("file:{}?mode=ro", path.to_string_lossy());
    let connection = Connection::open_with_flags(
        uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .ok()?;

    if connection.busy_timeout(CODEX_BUSY_TIMEOUT).is_err() {
        return None;
    }

    Some(connection)
}

fn threads_table_supports_discovery(connection: &Connection) -> Result<bool> {
    let mut statement = match connection.prepare("PRAGMA table_info(threads)") {
        Ok(statement) => statement,
        Err(error) if is_sqlite_busy(&error) => return Ok(false),
        Err(_) => return Ok(false),
    };

    let columns = match statement.query_map([], |row| row.get::<_, String>(1)) {
        Ok(rows) => rows,
        Err(error) if is_sqlite_busy(&error) => return Ok(false),
        Err(_) => return Ok(false),
    };

    let mut seen = BTreeSet::new();
    for column in columns {
        match column {
            Ok(column) => {
                seen.insert(column);
            }
            Err(error) if is_sqlite_busy(&error) => return Ok(false),
            Err(_) => return Ok(false),
        }
    }

    Ok(seen.contains("cwd") && seen.contains("archived"))
}

fn discover_claude_candidate_paths(context: &DiscoveryContext<'_>) -> Result<Vec<String>> {
    let root = &context.claude_projects_root;
    if !root.is_dir() {
        return Ok(Vec::new());
    }

    let mut cached_results = BTreeSet::new();
    let mut uncached_files = Vec::new();
    let mut cache = context
        .claude_cache
        .lock()
        .expect("claude cwd cache mutex poisoned");

    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(std::result::Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        if entry.path().extension() != Some(std::ffi::OsStr::new("jsonl")) {
            continue;
        }

        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let file = ClaudeFileInfo {
            path: entry.path().to_path_buf(),
            modified_ms: system_time_key(metadata.modified().ok()),
            size: metadata.len(),
        };

        if let Some(cached) = cache.get(&file.path) {
            if cached.modified_ms == file.modified_ms && cached.size == file.size {
                if let Some(cwd) = &cached.cwd {
                    cached_results.insert(cwd.clone());
                }
                continue;
            }
        }

        uncached_files.push(file);
    }

    uncached_files.sort_by(|left, right| {
        right
            .modified_ms
            .cmp(&left.modified_ms)
            .then_with(|| left.path.cmp(&right.path))
    });

    let deadline = Instant::now() + context.claude_budget;
    for file in uncached_files {
        match read_first_claude_cwd(&file.path, deadline) {
            ClaudeParseOutcome::Complete(cwd) => {
                if let Some(cwd) = &cwd {
                    cached_results.insert(cwd.clone());
                }
                cache.insert(
                    file.path,
                    ClaudeCwdCacheEntry {
                        modified_ms: file.modified_ms,
                        size: file.size,
                        cwd,
                    },
                );
            }
            ClaudeParseOutcome::TimedOut => break,
        }
    }

    Ok(cached_results.into_iter().collect())
}

fn read_first_claude_cwd(path: &Path, deadline: Instant) -> ClaudeParseOutcome {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return ClaudeParseOutcome::Complete(None),
    };

    let reader = BufReader::new(file);
    for line in reader.lines() {
        if Instant::now() >= deadline {
            return ClaudeParseOutcome::TimedOut;
        }

        let Ok(line) = line else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(cwd) = value.get("cwd").and_then(Value::as_str) else {
            continue;
        };
        return ClaudeParseOutcome::Complete(canonicalize_existing_path(Path::new(cwd.trim())));
    }

    ClaudeParseOutcome::Complete(None)
}

fn system_time_key(value: Option<SystemTime>) -> u128 {
    value
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn is_sqlite_busy(error: &SqliteError) -> bool {
    matches!(
        error,
        SqliteError::SqliteFailure(inner, _)
            if inner.code == ErrorCode::DatabaseBusy || inner.code == ErrorCode::DatabaseLocked
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    use crate::{ActivitySource, InitProjectInput};

    fn create_codex_state_db(
        codex_home: &Path,
        version: u32,
        rows: &[(&str, i64)],
    ) -> Result<PathBuf> {
        fs::create_dir_all(codex_home)?;
        let path = codex_home.join(format!("state_{version}.sqlite"));
        let connection = Connection::open(&path)?;
        connection.execute_batch(
            r#"
            CREATE TABLE threads (
              cwd TEXT,
              archived INTEGER NOT NULL DEFAULT 0
            );
            "#,
        )?;
        for (cwd, archived) in rows {
            connection.execute(
                "INSERT INTO threads (cwd, archived) VALUES (?1, ?2)",
                rusqlite::params![cwd, archived],
            )?;
        }
        Ok(path)
    }

    fn write_claude_jsonl(
        claude_projects_root: &Path,
        project_name: &str,
        session_name: &str,
        lines: &[&str],
    ) -> Result<PathBuf> {
        let project_dir = claude_projects_root.join(project_name);
        fs::create_dir_all(&project_dir)?;
        let path = project_dir.join(format!("{session_name}.jsonl"));
        fs::write(&path, lines.join("\n"))?;
        Ok(path)
    }

    fn create_initialized_project(root: &Path, index_db_path: &str) -> Result<()> {
        fs::create_dir_all(root)?;
        crate::init_project(InitProjectInput {
            root: root.display().to_string(),
            actor: "tester".to_string(),
            source: ActivitySource::Cli,
            name: Some(
                root.file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("Project")
                    .to_string(),
            ),
            kind: None,
            owner: None,
            tags: None,
            index_db_path: index_db_path.to_string(),
        })?;
        Ok(())
    }

    #[test]
    fn skips_plain_directories_without_tool_state() -> Result<()> {
        let temp = tempdir()?;
        let watched_root = temp.path().join("watched");
        fs::create_dir_all(watched_root.join("plain-project"))?;

        let store = IndexStore::new(temp.path().join("index.sqlite").display().to_string())?;
        let cache = Mutex::new(HashMap::new());
        let context = DiscoveryContext {
            codex_home: temp.path().join(".codex"),
            claude_projects_root: temp.path().join(".claude").join("projects"),
            claude_budget: CLAUDE_SCAN_BUDGET,
            claude_cache: &cache,
        };

        let discovered = discover_project_roots_with_context(
            &[watched_root.display().to_string()],
            &store,
            &context,
        )?;

        assert!(discovered.is_empty());
        Ok(())
    }

    #[test]
    fn resolves_newest_codex_state_database() -> Result<()> {
        let temp = tempdir()?;
        let codex_home = temp.path().join(".codex");
        create_codex_state_db(&codex_home, 3, &[])?;
        let newer = create_codex_state_db(&codex_home, 12, &[])?;

        assert_eq!(newest_codex_state_database(&codex_home)?, Some(newer));
        Ok(())
    }

    #[test]
    fn ignores_hidden_first_child_from_codex_activity() -> Result<()> {
        let temp = tempdir()?;
        let watched_root = temp.path().join("watched");
        let hidden_root = watched_root.join(".scratch").join("project");
        fs::create_dir_all(&hidden_root)?;

        let codex_home = temp.path().join(".codex");
        create_codex_state_db(&codex_home, 5, &[(&hidden_root.display().to_string(), 0)])?;

        let store = IndexStore::new(temp.path().join("index.sqlite").display().to_string())?;
        let cache = Mutex::new(HashMap::new());
        let context = DiscoveryContext {
            codex_home,
            claude_projects_root: temp.path().join(".claude").join("projects"),
            claude_budget: CLAUDE_SCAN_BUDGET,
            claude_cache: &cache,
        };

        let discovered = discover_project_roots_with_context(
            &[watched_root.display().to_string()],
            &store,
            &context,
        )?;

        assert!(discovered.is_empty());
        Ok(())
    }

    #[test]
    fn skips_codex_databases_with_incompatible_threads_schema() -> Result<()> {
        let temp = tempdir()?;
        let watched_root = temp.path().join("watched");
        let project_root = watched_root.join("parallel-project");
        fs::create_dir_all(&project_root)?;

        let codex_home = temp.path().join(".codex");
        fs::create_dir_all(&codex_home)?;
        let db_path = codex_home.join("state_4.sqlite");
        let connection = Connection::open(&db_path)?;
        connection.execute_batch(
            r#"
            CREATE TABLE threads (
              cwd TEXT
            );
            INSERT INTO threads (cwd) VALUES ('/tmp/parallel-project');
            "#,
        )?;

        let store = IndexStore::new(temp.path().join("index.sqlite").display().to_string())?;
        let cache = Mutex::new(HashMap::new());
        let context = DiscoveryContext {
            codex_home,
            claude_projects_root: temp.path().join(".claude").join("projects"),
            claude_budget: CLAUDE_SCAN_BUDGET,
            claude_cache: &cache,
        };

        let discovered = discover_project_roots_with_context(
            &[watched_root.display().to_string()],
            &store,
            &context,
        )?;

        assert!(discovered.is_empty());
        Ok(())
    }

    #[test]
    fn drops_deleted_codex_paths() -> Result<()> {
        let temp = tempdir()?;
        let watched_root = temp.path().join("watched");
        fs::create_dir_all(&watched_root)?;

        let codex_home = temp.path().join(".codex");
        create_codex_state_db(
            &codex_home,
            6,
            &[(&watched_root.join("missing-project").display().to_string(), 0)],
        )?;

        let store = IndexStore::new(temp.path().join("index.sqlite").display().to_string())?;
        let cache = Mutex::new(HashMap::new());
        let context = DiscoveryContext {
            codex_home,
            claude_projects_root: temp.path().join(".claude").join("projects"),
            claude_budget: CLAUDE_SCAN_BUDGET,
            claude_cache: &cache,
        };

        let discovered = discover_project_roots_with_context(
            &[watched_root.display().to_string()],
            &store,
            &context,
        )?;

        assert!(discovered.is_empty());
        Ok(())
    }

    #[test]
    fn deduplicates_external_sources_against_initialized_projects() -> Result<()> {
        let temp = tempdir()?;
        let watched_root = temp.path().join("watched");
        let project_root = watched_root.join("parallel-project");
        let nested_tool_root = project_root.join("subdir");
        fs::create_dir_all(&nested_tool_root)?;

        let index_db = temp.path().join("index.sqlite").display().to_string();
        create_initialized_project(&project_root, &index_db)?;
        let store = IndexStore::new(index_db)?;

        let codex_home = temp.path().join(".codex");
        create_codex_state_db(
            &codex_home,
            5,
            &[(&nested_tool_root.display().to_string(), 0)],
        )?;

        let claude_projects_root = temp.path().join(".claude").join("projects");
        write_claude_jsonl(
            &claude_projects_root,
            "parallel",
            "session",
            &[&format!(r#"{{"cwd":"{}"}}"#, nested_tool_root.display())],
        )?;

        let cache = Mutex::new(HashMap::new());
        let context = DiscoveryContext {
            codex_home,
            claude_projects_root,
            claude_budget: CLAUDE_SCAN_BUDGET,
            claude_cache: &cache,
        };

        let discovered = discover_project_roots_with_context(
            &[watched_root.display().to_string()],
            &store,
            &context,
        )?;

        assert_eq!(discovered, vec![fs::canonicalize(project_root)?.to_string_lossy().into_owned()]);
        Ok(())
    }

    #[test]
    fn reuses_cached_claude_results_for_unchanged_files() -> Result<()> {
        let temp = tempdir()?;
        let watched_root = temp.path().join("watched");
        let project_root = watched_root.join("parallel-project");
        fs::create_dir_all(&project_root)?;

        let claude_projects_root = temp.path().join(".claude").join("projects");
        let _session_path = write_claude_jsonl(
            &claude_projects_root,
            "parallel",
            "session",
            &[&format!(r#"{{"cwd":"{}"}}"#, project_root.display())],
        )?;

        let cache = Mutex::new(HashMap::new());
        let context = DiscoveryContext {
            codex_home: temp.path().join(".codex"),
            claude_projects_root,
            claude_budget: CLAUDE_SCAN_BUDGET,
            claude_cache: &cache,
        };
        let store = IndexStore::new(temp.path().join("index.sqlite").display().to_string())?;

        let first = discover_project_roots_with_context(
            &[watched_root.display().to_string()],
            &store,
            &context,
        )?;
        let second = discover_project_roots_with_context(
            &[watched_root.display().to_string()],
            &store,
            &context,
        )?;

        assert_eq!(first, second);
        Ok(())
    }

    #[test]
    fn tolerates_malformed_claude_lines_and_reparses_when_file_size_changes() -> Result<()> {
        let temp = tempdir()?;
        let watched_root = temp.path().join("watched");
        let first_project = watched_root.join("parallel-project");
        let second_project = watched_root.join("trading");
        fs::create_dir_all(&first_project)?;
        fs::create_dir_all(&second_project)?;

        let claude_projects_root = temp.path().join(".claude").join("projects");
        let session_path = write_claude_jsonl(
            &claude_projects_root,
            "parallel",
            "session",
            &[
                "{not-json",
                &format!(r#"{{"cwd":"{}"}}"#, first_project.display()),
            ],
        )?;

        let cache = Mutex::new(HashMap::new());
        let context = DiscoveryContext {
            codex_home: temp.path().join(".codex"),
            claude_projects_root,
            claude_budget: CLAUDE_SCAN_BUDGET,
            claude_cache: &cache,
        };
        let store = IndexStore::new(temp.path().join("index.sqlite").display().to_string())?;

        let first = discover_project_roots_with_context(
            &[watched_root.display().to_string()],
            &store,
            &context,
        )?;

        fs::write(
            &session_path,
            format!(
                "{{\"cwd\":\"{}\"}}\n{{\"cwd\":\"{}\"}}",
                second_project.display(),
                second_project.display()
            ),
        )?;
        let second = discover_project_roots_with_context(
            &[watched_root.display().to_string()],
            &store,
            &context,
        )?;

        assert_eq!(first, vec![fs::canonicalize(first_project)?.to_string_lossy().into_owned()]);
        assert_eq!(
            second,
            vec![fs::canonicalize(second_project)?.to_string_lossy().into_owned()]
        );
        Ok(())
    }
}
