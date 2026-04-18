use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

use anyhow::Result;

const DISCOVERY_IGNORES: &[&str] = &[
    "node_modules",
    ".pnpm",
    "dist",
    "build",
    "target",
    ".next",
    "coverage",
];

fn should_include_child_directory(name: &str) -> bool {
    !name.starts_with('.') && !DISCOVERY_IGNORES.iter().any(|ignored| *ignored == name)
}

fn normalized_existing_path(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn root_is_discoverable_project(root_path: &Path) -> bool {
    root_path.join(".git").exists() || root_path.join(".project-workflow").exists()
}

pub fn discover_project_roots(roots: &[String]) -> Result<Vec<String>> {
    let mut discovered = BTreeSet::new();

    for root in roots {
        let root_path = Path::new(root);
        if !root_path.is_dir() {
            continue;
        }

        if root_is_discoverable_project(root_path) {
            discovered.insert(
                normalized_existing_path(root_path)
                    .to_string_lossy()
                    .into_owned(),
            );
        }

        let entries = match fs::read_dir(root_path) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => continue,
            };

            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            if !file_type.is_dir() {
                continue;
            }

            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !should_include_child_directory(&name) {
                continue;
            }

            discovered.insert(
                normalized_existing_path(&entry.path())
                    .to_string_lossy()
                    .into_owned(),
            );
        }
    }

    Ok(discovered.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn skips_hidden_directories_under_watched_roots() -> Result<()> {
        let temp = tempdir()?;
        let root = temp.path();

        fs::create_dir_all(root.join("visible-project"))?;

        fs::create_dir_all(root.join(".hidden/ignored-repo/.git"))?;
        fs::write(
            root.join(".hidden/ignored-repo/.git/HEAD"),
            "ref: refs/heads/main\n",
        )?;

        let discovered = discover_project_roots(&[root.display().to_string()])?;

        assert_eq!(discovered.len(), 1);
        assert!(discovered[0].ends_with("visible-project"));
        Ok(())
    }

    #[test]
    fn keeps_watched_root_when_root_itself_is_a_project() -> Result<()> {
        let temp = tempdir()?;
        let root = temp.path();

        fs::create_dir_all(root.join(".project-workflow/local"))?;

        let discovered = discover_project_roots(&[root.display().to_string()])?;

        assert_eq!(discovered.len(), 1);
        assert_eq!(
            discovered[0],
            fs::canonicalize(root)?.to_string_lossy().into_owned()
        );
        Ok(())
    }
}
