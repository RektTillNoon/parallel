use std::{
    env, fs,
    path::{Path, PathBuf},
};

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("missing CARGO_MANIFEST_DIR"));
    let workspace_root = manifest_dir
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .expect("src-tauri should live under apps/desktop")
        .to_path_buf();
    let target = env::var("TARGET").expect("missing TARGET");
    let profile = env::var("PROFILE").expect("missing PROFILE");
    let extension = if target.contains("windows") { ".exe" } else { "" };
    let binary_name = format!("projectctl-{target}{extension}");
    let binaries_dir = manifest_dir.join("binaries");
    let bundled_binary = binaries_dir.join(&binary_name);

    println!("cargo:rerun-if-changed={}", workspace_root.join("crates/projectctl-rs").display());
    println!("cargo:rerun-if-changed={}", workspace_root.join("crates/workflow-core-rs").display());

    fs::create_dir_all(&binaries_dir).expect("failed to create sidecar binaries directory");

    let target_dir = env::var("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| workspace_root.join("target"));
    let default_layout = target_dir.join(&profile).join(format!("projectctl{extension}"));
    let explicit_target_layout = target_dir
        .join(&target)
        .join(&profile)
        .join(format!("projectctl{extension}"));
    let built_binary = if default_layout.exists() {
        default_layout
    } else {
        explicit_target_layout
    };

    if built_binary.exists() {
        fs::copy(&built_binary, &bundled_binary).unwrap_or_else(|error| {
            panic!(
                "failed to copy sidecar from {} to {}: {error}",
                built_binary.display(),
                bundled_binary.display()
            )
        });
    } else {
        println!(
            "cargo:warning=projectctl sidecar binary missing at {}; run the Tauri beforeDev/beforeBuild command first",
            built_binary.display()
        );
    }

    tauri_build::build();
}
