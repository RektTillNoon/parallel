use std::{
    net::TcpListener,
    path::{Path, PathBuf},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use serde::{Deserialize, Serialize};

pub const DEFAULT_BRIDGE_PORT: u16 = 4855;
pub const BRIDGE_EVENT: &str = "bridge://state-changed";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeSettings {
    pub enabled: bool,
    pub port: u16,
    pub token: String,
}

impl Default for BridgeSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_BRIDGE_PORT,
            token: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BridgeRuntimeSnapshot {
    pub status: String,
    pub bound_port: Option<u16>,
    pub pid: Option<u32>,
    pub started_at: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStateEvent {
    pub reason: String,
    pub mcp: BridgeSettings,
    pub mcp_runtime: BridgeRuntimeSnapshot,
}

pub fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn resolve_bridge_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/mcp")
}

pub fn find_available_port(start_port: u16) -> Result<(u16, bool), String> {
    for candidate in start_port..=u16::MAX {
        if TcpListener::bind(("127.0.0.1", candidate)).is_ok() {
            return Ok((candidate, candidate != start_port));
        }
    }
    Err("No free localhost port available for Agent Bridge".to_string())
}

pub fn target_triple() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return "aarch64-apple-darwin";
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        return "x86_64-apple-darwin";
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        return "x86_64-unknown-linux-gnu";
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        return "x86_64-pc-windows-msvc";
    }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "x86_64")
    )))]
    {
        return "unknown-target";
    }
}

pub fn sidecar_binary_filename() -> String {
    let extension = if cfg!(target_os = "windows") {
        ".exe"
    } else {
        ""
    };
    format!("projectctl-{}{}", target_triple(), extension)
}

pub fn bundled_sidecar_binary_filename() -> String {
    let extension = if cfg!(target_os = "windows") {
        ".exe"
    } else {
        ""
    };
    format!("projectctl{extension}")
}

pub fn resolve_bundled_projectctl_path(current_exe: &Path) -> PathBuf {
    resolve_bundled_projectctl_path_with_manifest_dir(
        current_exe,
        Path::new(env!("CARGO_MANIFEST_DIR")),
    )
}

fn resolve_bundled_projectctl_path_with_manifest_dir(
    current_exe: &Path,
    manifest_dir: &Path,
) -> PathBuf {
    let bundled_binary_name = bundled_sidecar_binary_filename();
    let binary_name = sidecar_binary_filename();
    let parent = current_exe.parent().unwrap_or_else(|| Path::new("."));

    let packaged_sibling = parent.join(&bundled_binary_name);
    if packaged_sibling.exists() {
        return packaged_sibling;
    }

    let target_suffixed_sibling = parent.join(&binary_name);
    if target_suffixed_sibling.exists() {
        return target_suffixed_sibling;
    }

    let dev_binary = manifest_dir.join("binaries").join(&binary_name);
    if dev_binary.exists() {
        return dev_binary;
    }

    packaged_sibling
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn unique_test_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "parallel-bridge-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time before unix epoch")
                .as_nanos()
        ))
    }

    #[test]
    fn prefers_packaged_projectctl_sibling_for_bundled_apps() {
        let root = unique_test_dir("packaged-sibling");
        let contents_dir = root.join("parallel.app/Contents/MacOS");
        fs::create_dir_all(&contents_dir).expect("create contents dir");
        let current_exe = contents_dir.join("parallel");
        fs::write(&current_exe, "").expect("create current exe");

        let packaged_sidecar = contents_dir.join(bundled_sidecar_binary_filename());
        fs::write(&packaged_sidecar, "").expect("create packaged sidecar");

        let resolved = resolve_bundled_projectctl_path_with_manifest_dir(
            &current_exe,
            &root.join("src-tauri"),
        );
        assert_eq!(resolved, packaged_sidecar);

        fs::remove_dir_all(&root).expect("remove temp test dir");
    }

    #[test]
    fn falls_back_to_target_suffixed_dev_binary_when_packaged_sidecar_is_missing() {
        let root = unique_test_dir("dev-fallback");
        let run_dir = root.join("target/debug");
        let manifest_dir = root.join("src-tauri");
        let binaries_dir = manifest_dir.join("binaries");
        fs::create_dir_all(&run_dir).expect("create run dir");
        fs::create_dir_all(&binaries_dir).expect("create binaries dir");

        let current_exe = run_dir.join("parallel-desktop");
        fs::write(&current_exe, "").expect("create current exe");

        let dev_binary = binaries_dir.join(sidecar_binary_filename());
        fs::write(&dev_binary, "").expect("create dev sidecar");

        let resolved =
            resolve_bundled_projectctl_path_with_manifest_dir(&current_exe, &manifest_dir);
        assert_eq!(resolved, dev_binary);

        fs::remove_dir_all(&root).expect("remove temp test dir");
    }

    #[test]
    fn bridge_state_event_payload_omits_setup_stale_fields() {
        let payload = serde_json::to_value(BridgeStateEvent {
            reason: "snapshot".to_string(),
            mcp: BridgeSettings::default(),
            mcp_runtime: BridgeRuntimeSnapshot::default(),
        })
        .expect("payload should serialize");

        let runtime = payload
            .get("mcpRuntime")
            .and_then(serde_json::Value::as_object)
            .expect("runtime payload should serialize as object");
        assert!(runtime.get("setupStale").is_none());
        assert!(runtime.get("staleClients").is_none());
        assert!(runtime.get("staleReasons").is_none());
    }
}
