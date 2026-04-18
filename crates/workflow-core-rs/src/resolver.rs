use std::{
    fs,
    path::Path,
};

use anyhow::{anyhow, Result};
use serde::Deserialize;

use crate::{
    canonical_index_db_path, canonical_settings_path, index_store::IndexStore,
    root_paths::normalize_roots,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootResolutionSurface {
    Cli,
    Desktop,
    Bridge,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LegacySettings {
    #[serde(default)]
    watched_roots: Vec<String>,
}

pub fn resolve_index_db_path(explicit: Option<&str>, env_value: Option<&str>) -> Result<String> {
    explicit
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .or_else(|| env_value.filter(|value| !value.trim().is_empty()).map(str::to_string))
        .or_else(|| canonical_index_db_path().map(|path| path.to_string_lossy().into_owned()))
        .ok_or_else(|| anyhow!("Unable to resolve canonical workflow index DB path"))
}

pub fn resolve_watched_roots(
    surface: RootResolutionSurface,
    explicit_roots: Option<&[String]>,
    env_roots: Option<&str>,
    index_db_path: &str,
    cli_cwd: Option<&str>,
) -> Result<Vec<String>> {
    resolve_watched_roots_from_sources(
        surface,
        explicit_roots,
        env_roots,
        index_db_path,
        cli_cwd,
        canonical_settings_path().as_deref(),
    )
}

pub(crate) fn resolve_watched_roots_from_sources(
    surface: RootResolutionSurface,
    explicit_roots: Option<&[String]>,
    env_roots: Option<&str>,
    index_db_path: &str,
    cli_cwd: Option<&str>,
    legacy_settings_path: Option<&Path>,
) -> Result<Vec<String>> {
    if let Some(roots) = explicit_roots {
        let normalized = normalize_roots(roots.iter().cloned());
        if !normalized.is_empty() {
            return Ok(normalized);
        }
    }

    if let Some(raw) = env_roots {
        let normalized = normalize_roots(split_roots(raw));
        if !normalized.is_empty() {
            return Ok(normalized);
        }
    }

    let migrated = migrate_legacy_watched_roots(index_db_path, legacy_settings_path)?;
    if !migrated.is_empty() {
        return Ok(migrated);
    }

    if surface == RootResolutionSurface::Cli {
        if let Some(cwd) = cli_cwd.filter(|value| !value.trim().is_empty()) {
            return Ok(normalize_roots([cwd.to_string()]));
        }
    }

    Ok(Vec::new())
}

pub fn migrate_legacy_watched_roots(index_db_path: &str, legacy_settings_path: Option<&Path>) -> Result<Vec<String>> {
    let store = IndexStore::new(index_db_path.to_string())?;
    if !store.list_watched_roots()?.is_empty() {
        return store.list_watched_roots();
    }

    let mut roots = store.seed_watched_roots()?;
    roots.extend(read_legacy_watched_roots(legacy_settings_path));
    let normalized = normalize_roots(roots);
    if !normalized.is_empty() {
        store.sync_watched_roots(&normalized)?;
    }
    store.list_watched_roots()
}

fn read_legacy_watched_roots(legacy_settings_path: Option<&Path>) -> Vec<String> {
    let Some(settings_path) = legacy_settings_path else {
        return Vec::new();
    };
    let Ok(raw) = fs::read_to_string(settings_path) else {
        return Vec::new();
    };
    serde_json::from_str::<LegacySettings>(&raw)
        .map(|settings| settings.watched_roots)
        .unwrap_or_default()
}

fn split_roots(raw: &str) -> impl Iterator<Item = String> + '_ {
    raw.split(if cfg!(windows) { ';' } else { ':' })
        .map(str::trim)
        .filter(|root| !root.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use std::{fs, sync::mpsc, thread};

    use tempfile::tempdir;

    use super::*;
    use crate::index_store::IndexStore;

    fn canonical(path: &Path) -> String {
        path.canonicalize()
            .unwrap_or_else(|_| path.to_path_buf())
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn migrates_union_of_legacy_settings_and_seed_db_roots() -> Result<()> {
        let temp = tempdir()?;
        let index_db = temp.path().join("workflow-index.sqlite");
        let settings_path = temp.path().join("settings.json");
        fs::write(
            &settings_path,
            serde_json::json!({
                "watchedRoots": [
                    temp.path().join("legacy").display().to_string(),
                    temp.path().join("existing").display().to_string()
                ]
            })
            .to_string(),
        )?;

        fs::create_dir_all(temp.path().join("existing"))?;
        fs::create_dir_all(temp.path().join("legacy"))?;
        fs::create_dir_all(temp.path().join("scan-root"))?;

        let store = IndexStore::new(index_db.display().to_string())?;
        store.sync_project_root_seed(temp.path().join("existing").display().to_string().as_str())?;
        store.record_watched_root_scan(temp.path().join("scan-root").display().to_string().as_str(), "2026-01-01T00:00:00Z")?;

        let roots = resolve_watched_roots_from_sources(
            RootResolutionSurface::Bridge,
            None,
            None,
            index_db.to_string_lossy().as_ref(),
            None,
            Some(&settings_path),
        )?;

        assert_eq!(
            roots,
            vec![
                canonical(&temp.path().join("existing")),
                canonical(&temp.path().join("legacy")),
                canonical(&temp.path().join("scan-root")),
            ]
        );
        assert_eq!(store.list_watched_roots()?, roots);
        Ok(())
    }

    #[test]
    fn cli_uses_cwd_only_when_no_explicit_env_or_canonical_roots_exist() -> Result<()> {
        let temp = tempdir()?;
        let index_db = temp.path().join("workflow-index.sqlite");
        let cwd = temp.path().join("cwd");
        fs::create_dir_all(&cwd)?;

        let roots = resolve_watched_roots_from_sources(
            RootResolutionSurface::Cli,
            None,
            None,
            index_db.to_string_lossy().as_ref(),
            Some(cwd.to_string_lossy().as_ref()),
            Some(&temp.path().join("missing-settings.json")),
        )?;

        assert_eq!(roots, vec![canonical(&cwd)]);
        Ok(())
    }

    #[test]
    fn bridge_returns_empty_when_no_roots_are_available() -> Result<()> {
        let temp = tempdir()?;
        let index_db = temp.path().join("workflow-index.sqlite");

        let roots = resolve_watched_roots_from_sources(
            RootResolutionSurface::Bridge,
            None,
            None,
            index_db.to_string_lossy().as_ref(),
            None,
            None,
        )?;

        assert!(roots.is_empty());
        Ok(())
    }

    #[test]
    fn malformed_legacy_settings_falls_back_to_db_roots() -> Result<()> {
        let temp = tempdir()?;
        let index_db = temp.path().join("workflow-index.sqlite");
        let settings_path = temp.path().join("settings.json");
        let rooted = temp.path().join("db-root");
        fs::create_dir_all(&rooted)?;
        fs::write(&settings_path, "{bad json")?;

        let store = IndexStore::new(index_db.display().to_string())?;
        store.sync_watched_roots(&[canonical(&rooted)])?;

        let roots = resolve_watched_roots_from_sources(
            RootResolutionSurface::Desktop,
            None,
            None,
            index_db.to_string_lossy().as_ref(),
            None,
            Some(&settings_path),
        )?;

        assert_eq!(roots, vec![canonical(&rooted)]);
        Ok(())
    }

    #[test]
    fn concurrent_first_access_converges_on_one_canonical_root_set() -> Result<()> {
        let temp = tempdir()?;
        let index_db = temp.path().join("workflow-index.sqlite");
        let settings_path = temp.path().join("settings.json");
        let first = temp.path().join("first");
        let second = temp.path().join("second");
        fs::create_dir_all(&first)?;
        fs::create_dir_all(&second)?;
        fs::write(
            &settings_path,
            serde_json::json!({
                "watchedRoots": [first.display().to_string(), second.display().to_string()]
            })
            .to_string(),
        )?;

        let (tx, rx) = mpsc::sync_channel(2);
        let index_db_one = index_db.clone();
        let settings_one = settings_path.clone();
        let tx_one = tx.clone();
        thread::spawn(move || {
            let roots = resolve_watched_roots_from_sources(
                RootResolutionSurface::Bridge,
                None,
                None,
                index_db_one.to_string_lossy().as_ref(),
                None,
                Some(&settings_one),
            )
            .expect("first resolver should succeed");
            tx_one.send(roots).expect("first roots should send");
        });
        let index_db_two = index_db.clone();
        let settings_two = settings_path.clone();
        thread::spawn(move || {
            let roots = resolve_watched_roots_from_sources(
                RootResolutionSurface::Bridge,
                None,
                None,
                index_db_two.to_string_lossy().as_ref(),
                None,
                Some(&settings_two),
            )
            .expect("second resolver should succeed");
            tx.send(roots).expect("second roots should send");
        });

        let first_result = rx.recv().expect("first result should arrive");
        let second_result = rx.recv().expect("second result should arrive");
        assert_eq!(first_result, second_result);
        assert_eq!(
            first_result,
            vec![canonical(&first), canonical(&second)]
        );
        Ok(())
    }
}
