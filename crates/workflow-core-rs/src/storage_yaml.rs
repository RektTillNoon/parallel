use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
};

use anyhow::{anyhow, Context, Result};
use chrono::{SecondsFormat, Utc};
use fd_lock::RwLock;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct WorkflowPaths {
    pub workflow_dir: PathBuf,
    pub local_dir: PathBuf,
    pub manifest_path: PathBuf,
    pub plan_path: PathBuf,
    pub decisions_path: PathBuf,
    pub runtime_path: PathBuf,
    pub sessions_path: PathBuf,
    pub activity_path: PathBuf,
    pub proposed_decisions_path: PathBuf,
    pub handoff_path: PathBuf,
}

pub fn get_workflow_paths(root: impl AsRef<Path>) -> WorkflowPaths {
    let root = root.as_ref().to_path_buf();
    let workflow_dir = root.join(".project-workflow");
    let local_dir = workflow_dir.join("local");

    WorkflowPaths {
        workflow_dir: workflow_dir.clone(),
        local_dir: local_dir.clone(),
        manifest_path: workflow_dir.join("manifest.yaml"),
        plan_path: workflow_dir.join("plan.yaml"),
        decisions_path: workflow_dir.join("decisions.md"),
        runtime_path: local_dir.join("runtime.yaml"),
        sessions_path: local_dir.join("sessions.yaml"),
        activity_path: local_dir.join("activity.jsonl"),
        proposed_decisions_path: local_dir.join("decisions-proposed.yaml"),
        handoff_path: local_dir.join("handoff.md"),
    }
}

pub fn ensure_dir(path: impl AsRef<Path>) -> Result<()> {
    fs::create_dir_all(path.as_ref()).with_context(|| format!("create dir {}", path.as_ref().display()))
}

pub fn path_exists(path: impl AsRef<Path>) -> bool {
    path.as_ref().exists()
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn read_text_if_exists(path: impl AsRef<Path>) -> Result<Option<String>> {
    let path = path.as_ref();
    if !path.exists() {
        return Ok(None);
    }

    fs::read_to_string(path)
        .with_context(|| format!("read {}", path.display()))
        .map(Some)
}

pub fn read_yaml_file<T: DeserializeOwned>(path: impl AsRef<Path>) -> Result<T> {
    let path = path.as_ref();
    let raw = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    serde_yaml::from_str(&raw).with_context(|| format!("parse yaml {}", path.display()))
}

pub fn write_yaml_atomic<T: Serialize>(path: impl AsRef<Path>, data: &T) -> Result<()> {
    let path = path.as_ref();
    let dir = path
        .parent()
        .ok_or_else(|| anyhow!("yaml target has no parent: {}", path.display()))?;
    ensure_dir(dir)?;
    let temp_path = dir.join(format!(".{}.{}.tmp", path.file_name().unwrap().to_string_lossy(), Uuid::new_v4()));
    let body = serde_yaml::to_string(data)?;
    fs::write(&temp_path, body).with_context(|| format!("write {}", temp_path.display()))?;
    fs::rename(&temp_path, path)
        .with_context(|| format!("rename {} -> {}", temp_path.display(), path.display()))
}

pub fn write_text_atomic(path: impl AsRef<Path>, body: &str) -> Result<()> {
    let path = path.as_ref();
    let dir = path
        .parent()
        .ok_or_else(|| anyhow!("text target has no parent: {}", path.display()))?;
    ensure_dir(dir)?;
    let temp_path = dir.join(format!(".{}.{}.tmp", path.file_name().unwrap().to_string_lossy(), Uuid::new_v4()));
    fs::write(&temp_path, body).with_context(|| format!("write {}", temp_path.display()))?;
    fs::rename(&temp_path, path)
        .with_context(|| format!("rename {} -> {}", temp_path.display(), path.display()))
}

pub fn append_json_line(path: impl AsRef<Path>, data: &Value) -> Result<()> {
    let path = path.as_ref();
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .with_context(|| format!("open {}", path.display()))?;
    file.write_all(serde_json::to_string(data)?.as_bytes())?;
    file.write_all(b"\n")?;
    Ok(())
}

pub fn read_json_lines(path: impl AsRef<Path>) -> Result<Vec<Value>> {
    let path = path.as_ref();
    if !path.exists() {
        return Ok(Vec::new());
    }

    let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let reader = BufReader::new(file);
    let mut rows = Vec::new();
    for line in reader.lines() {
        let line = line?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        rows.push(serde_json::from_str::<Value>(trimmed)?);
    }
    Ok(rows)
}

pub fn with_project_lock<T, F>(root: &str, callback: F) -> Result<T>
where
    F: FnOnce() -> Result<T>,
{
    let paths = get_workflow_paths(root);
    ensure_dir(&paths.local_dir)?;
    let lock_file_path = paths.local_dir.join(".lock");
    let lock_file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(&lock_file_path)
        .with_context(|| format!("open {}", lock_file_path.display()))?;
    let mut lock = RwLock::new(lock_file);
    let _guard = lock.write()?;
    callback()
}

pub fn read_git_branch(root: &str) -> Result<Option<String>> {
    let head_path = Path::new(root).join(".git").join("HEAD");
    let Some(head) = read_text_if_exists(&head_path)? else {
        return Ok(None);
    };

    let trimmed = head.trim();
    if !trimmed.starts_with("ref:") {
        return Ok(Some(trimmed.to_string()));
    }

    Ok(trimmed
        .trim_start_matches("ref:")
        .trim()
        .split('/')
        .last()
        .map(|value| value.to_string()))
}

pub fn slugify(value: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;

    for ch in value.chars().flat_map(|ch| ch.to_lowercase()) {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }

    out.trim_matches('-').chars().take(48).collect()
}
