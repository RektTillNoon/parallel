use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

use anyhow::Result;
use walkdir::{DirEntry, WalkDir};

const DISCOVERY_IGNORES: &[&str] = &[
    "node_modules",
    ".pnpm",
    "dist",
    "build",
    "target",
    ".next",
    "coverage",
];

fn should_descend(entry: &DirEntry) -> bool {
    if entry.depth() == 0 {
        return true;
    }
    let name = entry.file_name().to_string_lossy();
    if name == ".git" {
        return true;
    }
    if name.starts_with('.') {
        return false;
    }
    !DISCOVERY_IGNORES.iter().any(|ignored| *ignored == name)
}

fn normalized_existing_path(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

pub fn discover_git_repos(roots: &[String]) -> Result<Vec<String>> {
    let mut discovered = BTreeSet::new();

    for root in roots {
        let root_path = Path::new(root);
        if !root_path.exists() {
            continue;
        }

        if root_path.join(".git").exists() {
            discovered.insert(
                normalized_existing_path(root_path)
                    .to_string_lossy()
                    .into_owned(),
            );
        }

        for entry in WalkDir::new(root_path)
            .follow_links(false)
            .into_iter()
            .filter_entry(should_descend)
        {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => continue,
            };

            if entry.file_name() == ".git" {
                if let Some(repo_root) = entry.path().parent() {
                    discovered.insert(
                        normalized_existing_path(repo_root)
                            .to_string_lossy()
                            .into_owned(),
                    );
                }
            }
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

        fs::create_dir_all(root.join("visible-repo/.git"))?;
        fs::write(
            root.join("visible-repo/.git/HEAD"),
            "ref: refs/heads/main\n",
        )?;

        fs::create_dir_all(root.join(".hidden/ignored-repo/.git"))?;
        fs::write(
            root.join(".hidden/ignored-repo/.git/HEAD"),
            "ref: refs/heads/main\n",
        )?;

        let discovered = discover_git_repos(&[root.display().to_string()])?;

        assert_eq!(discovered.len(), 1);
        assert!(discovered[0].ends_with("visible-repo"));
        Ok(())
    }
}
