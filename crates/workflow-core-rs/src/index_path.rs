use std::{
    env,
    path::PathBuf,
};

pub const CANONICAL_INDEX_DB_FILE: &str = "workflow-index.sqlite";
const CANONICAL_APP_IDENTIFIER: &str = "ai.light.projectworkflowos";

pub fn canonical_index_db_path() -> Option<PathBuf> {
    canonical_index_db_path_from_env(|key| env::var(key).ok())
}

fn canonical_index_db_path_from_env<F>(get_env: F) -> Option<PathBuf>
where
    F: Fn(&str) -> Option<String>,
{
    Some(canonical_data_dir_from_env(get_env)?.join(CANONICAL_INDEX_DB_FILE))
}

fn canonical_data_dir_from_env<F>(get_env: F) -> Option<PathBuf>
where
    F: Fn(&str) -> Option<String>,
{
    #[cfg(target_os = "macos")]
    {
        let home = get_env("HOME")?;
        return Some(
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join(CANONICAL_APP_IDENTIFIER),
        );
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(app_data) = get_env("APPDATA") {
            return Some(PathBuf::from(app_data).join(CANONICAL_APP_IDENTIFIER));
        }
        let user_profile = get_env("USERPROFILE")?;
        return Some(
            PathBuf::from(user_profile)
                .join("AppData")
                .join("Roaming")
                .join(CANONICAL_APP_IDENTIFIER),
        );
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        if let Some(data_home) = get_env("XDG_DATA_HOME") {
            return Some(PathBuf::from(data_home).join(CANONICAL_APP_IDENTIFIER));
        }
        let home = get_env("HOME")?;
        Some(
            PathBuf::from(home)
                .join(".local")
                .join("share")
                .join(CANONICAL_APP_IDENTIFIER),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_canonical_index_path_from_platform_env() {
        #[cfg(target_os = "macos")]
        let path = canonical_index_db_path_from_env(|key| match key {
            "HOME" => Some("/Users/tester".to_string()),
            _ => None,
        })
        .expect("mac path should resolve");

        #[cfg(target_os = "windows")]
        let path = canonical_index_db_path_from_env(|key| match key {
            "APPDATA" => Some(r"C:\Users\tester\AppData\Roaming".to_string()),
            _ => None,
        })
        .expect("windows path should resolve");

        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let path = canonical_index_db_path_from_env(|key| match key {
            "XDG_DATA_HOME" => Some("/home/tester/.local/share".to_string()),
            _ => None,
        })
        .expect("linux path should resolve");

        assert!(path.ends_with(CANONICAL_INDEX_DB_FILE));
        assert!(path.to_string_lossy().contains(CANONICAL_APP_IDENTIFIER));
    }
}
