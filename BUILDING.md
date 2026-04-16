## Building the desktop app

Local macOS build:

```bash
pnpm install --frozen-lockfile
pnpm build:desktop
```

Successful local builds write the macOS bundles to:

- `target/release/bundle/macos/parallel.app`
- `target/release/bundle/dmg/*.dmg`

## Cargo and firewall note

The desktop packaging step runs Rust builds for both `projectctl` and the Tauri app in `apps/desktop/src-tauri`.
If your machine sits behind a TLS-inspecting firewall or proxy, Cargo may fail to download crates with errors like `SSL certificate problem: unable to get local issuer certificate`.

When that happens, prefer one of these:

1. Fix Cargo trust for your environment or use your company's internal registry/mirror.
2. Use the GitHub Actions desktop build workflow and download the generated `.dmg` artifact from the workflow run's `Artifacts` section.

The CI workflow uploads the `.dmg` as a run artifact so you do not need to package releases on every developer machine.
