use std::{
    collections::BTreeSet,
    net::TcpListener,
    path::{Path, PathBuf},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use serde::{Deserialize, Serialize};

pub const DEFAULT_BRIDGE_PORT: u16 = 4855;
pub const BRIDGE_EVENT: &str = "bridge://state-changed";
pub const ALL_CLIENT_KINDS: [&str; 3] = ["codex", "claudeCode", "claudeDesktop"];

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
    pub setup_stale: bool,
    pub stale_reasons: Vec<String>,
    pub stale_clients: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeSnippet {
    pub kind: String,
    pub label: String,
    pub content: String,
    pub copy_label: String,
    pub notes: String,
    pub stale: bool,
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
    let extension = if cfg!(target_os = "windows") { ".exe" } else { "" };
    format!("projectctl-{}{}", target_triple(), extension)
}

pub fn bundled_sidecar_binary_filename() -> String {
    let extension = if cfg!(target_os = "windows") { ".exe" } else { "" };
    format!("projectctl{extension}")
}

pub fn resolve_bundled_projectctl_path(current_exe: &Path) -> PathBuf {
    resolve_bundled_projectctl_path_with_manifest_dir(current_exe, Path::new(env!("CARGO_MANIFEST_DIR")))
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

    let dev_binary = manifest_dir
        .join("binaries")
        .join(&binary_name);
    if dev_binary.exists() {
        return dev_binary;
    }

    packaged_sibling
}

pub fn mark_clients_stale(snapshot: &mut BridgeRuntimeSnapshot, reason: &str) {
    if !snapshot.stale_reasons.iter().any(|candidate| candidate == reason) {
        snapshot.stale_reasons.push(reason.to_string());
    }
    let mut clients = BTreeSet::from_iter(snapshot.stale_clients.iter().cloned());
    for kind in ALL_CLIENT_KINDS {
        clients.insert(kind.to_string());
    }
    snapshot.stale_clients = clients.into_iter().collect();
    snapshot.setup_stale = !snapshot.stale_clients.is_empty();
}

pub fn clear_client_stale(snapshot: &mut BridgeRuntimeSnapshot, kind: &str) {
    snapshot.stale_clients.retain(|candidate| candidate != kind);
    snapshot.setup_stale = !snapshot.stale_clients.is_empty();
    if !snapshot.setup_stale {
        snapshot.stale_reasons.clear();
    }
}

pub fn is_client_stale(snapshot: &BridgeRuntimeSnapshot, kind: &str) -> bool {
    snapshot.stale_clients.iter().any(|candidate| candidate == kind)
}

pub fn build_client_snippet(
    kind: &str,
    url: &str,
    token: &str,
    projectctl_path: &Path,
    snapshot: &BridgeRuntimeSnapshot,
) -> Result<BridgeSnippet, String> {
    let stale = is_client_stale(snapshot, kind);
    match kind {
        "codex" => Ok(BridgeSnippet {
            kind: kind.to_string(),
            label: "Codex setup".to_string(),
            copy_label: "Copy Codex setup".to_string(),
            notes: "Direct streamable HTTP MCP setup for Codex. Re-copy after endpoint or token changes.".to_string(),
            stale,
            content: format!(
                "export PARALLEL_MCP_TOKEN='{token}'\ncodex mcp add parallel --url {url} --bearer-token-env-var PARALLEL_MCP_TOKEN"
            ),
        }),
        "claudeCode" => Ok(BridgeSnippet {
            kind: kind.to_string(),
            label: "Claude Code setup".to_string(),
            copy_label: "Copy Claude Code setup".to_string(),
            notes: "Direct streamable HTTP MCP setup for Claude Code. Re-copy after endpoint or token changes.".to_string(),
            stale,
            content: format!(
                "claude mcp add --transport http parallel {url} --header \"Authorization: Bearer {token}\""
            ),
        }),
        "claudeDesktop" => Ok(BridgeSnippet {
            kind: kind.to_string(),
            label: "Claude Desktop setup".to_string(),
            copy_label: "Copy Claude Desktop setup".to_string(),
            notes: "Use the bundled projectctl stdio proxy. Re-copy after endpoint or token changes.".to_string(),
            stale,
            content: serde_json::to_string_pretty(&serde_json::json!({
                "mcpServers": {
                    "parallel": {
                        "command": projectctl_path.display().to_string(),
                        "args": [
                            "mcp",
                            "proxy-stdio",
                            "--url",
                            url,
                            "--token",
                            token
                        ]
                    }
                }
            }))
            .map_err(|error| error.to_string())?,
        }),
        _ => Err(format!("Unknown client snippet kind: {kind}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, time::{SystemTime, UNIX_EPOCH}};

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
    fn marks_all_clients_stale() {
        let mut snapshot = BridgeRuntimeSnapshot::default();
        mark_clients_stale(&mut snapshot, "endpointChanged");
        assert!(snapshot.setup_stale);
        assert_eq!(snapshot.stale_clients.len(), 3);
        assert!(snapshot.stale_reasons.contains(&"endpointChanged".to_string()));
    }

    #[test]
    fn clears_stale_state_per_client() {
        let mut snapshot = BridgeRuntimeSnapshot::default();
        mark_clients_stale(&mut snapshot, "tokenRotated");
        clear_client_stale(&mut snapshot, "codex");
        assert!(!snapshot.stale_clients.contains(&"codex".to_string()));
        clear_client_stale(&mut snapshot, "claudeCode");
        clear_client_stale(&mut snapshot, "claudeDesktop");
        assert!(!snapshot.setup_stale);
        assert!(snapshot.stale_reasons.is_empty());
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

        let resolved = resolve_bundled_projectctl_path_with_manifest_dir(&current_exe, &root.join("src-tauri"));
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

        let resolved = resolve_bundled_projectctl_path_with_manifest_dir(&current_exe, &manifest_dir);
        assert_eq!(resolved, dev_binary);

        fs::remove_dir_all(&root).expect("remove temp test dir");
    }
}
