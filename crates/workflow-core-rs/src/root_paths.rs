use std::{path::PathBuf, vec::Vec};

pub(crate) fn canonicalize_root(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    PathBuf::from(trimmed)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(trimmed))
        .to_string_lossy()
        .into_owned()
}

pub(crate) fn normalize_roots<I>(roots: I) -> Vec<String>
where
    I: IntoIterator<Item = String>,
{
    let mut normalized = roots
        .into_iter()
        .map(|root| canonicalize_root(&root))
        .filter(|root| !root.is_empty())
        .collect::<Vec<_>>();
    normalized.sort();
    normalized.dedup();
    normalized
}

pub(crate) fn root_belongs_to_watched_root(root: &str, watched_root: &str) -> bool {
    let root = canonicalize_root(root);
    let watched_root = canonicalize_root(watched_root);
    root == watched_root || root.starts_with(&format!("{watched_root}{}", std::path::MAIN_SEPARATOR))
}
