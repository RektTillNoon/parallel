use std::{collections::BTreeSet, fs, path::Path};

use anyhow::Result;
use tracing::debug;

use crate::index_store::IndexStore;

pub(crate) fn lookup(
    store: &IndexStore,
    path: &str,
    modified_ms: u128,
    size: u64,
) -> Result<Option<Option<String>>> {
    Ok(store
        .claude_cache_entry(path)?
        .filter(|entry| entry.modified_ms == modified_ms && entry.size == size)
        .map(|entry| entry.cwd))
}

pub(crate) fn store_entry(
    store: &IndexStore,
    path: &str,
    modified_ms: u128,
    size: u64,
    cwd: Option<String>,
) -> Result<()> {
    store.upsert_claude_cache_entry(path, modified_ms, size, cwd)
}

pub(crate) fn prune_absent_entries(
    store: &IndexStore,
    claude_projects_root: &Path,
    enumerated_paths: &BTreeSet<String>,
) -> Result<()> {
    if !claude_projects_root.exists() {
        debug!(root = %claude_projects_root.display(), "Skipping Claude cache prune because the projects root does not exist");
        return Ok(());
    }

    let root = fs::canonicalize(claude_projects_root)
        .unwrap_or_else(|_| claude_projects_root.to_path_buf())
        .to_string_lossy()
        .into_owned();
    for entry in store.list_claude_cache_entries()? {
        if !entry.path.starts_with(root.as_str()) {
            continue;
        }
        if enumerated_paths.contains(&entry.path) {
            continue;
        }
        store.delete_claude_cache_entry(&entry.path)?;
    }
    Ok(())
}
