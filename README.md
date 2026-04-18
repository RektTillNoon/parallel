# parallel

`parallel` is a local workflow system for tracking execution across many git repos. It has three product surfaces over one shared workflow state:

- a desktop app for discovery, board view, and bridge management
- the `projectctl` CLI for shell-native workflows
- a local authenticated MCP bridge for agents

For each initialized repo, `parallel` tracks a canonical plan, runtime focus, sessions, activity, blockers, decision proposals, and a generated handoff.

## Repo layout

- `apps/desktop`
  React + Tauri desktop shell. This is the control surface for watched roots, project discovery, the session-first board, and local bridge lifecycle.
- `crates/workflow-core-rs`
  Shared Rust workflow engine, file/index storage, discovery, and read-model logic.
- `crates/projectctl-rs`
  `projectctl` CLI plus the local MCP HTTP/stdio bridge implementation.
- `plugins/parallel/skills/parallel`
  Product-usage guidance for agents using `parallel` through MCP or `projectctl`.
- `docs/`
  Design notes and implementation plans for active product work.

## Product model

The desktop app watches configured roots and discovers git repos beneath them. Initialized repos get a `.project-workflow/` state directory plus indexed summary data in the canonical SQLite index.

Two repo invariants matter when touching discovery or desktop state flow:

1. `refresh_projects` owns repo discovery and topology changes.
2. `load_state` is a snapshot read and should not rediscover repos.

That split keeps the desktop responsive and gives the UI separate signals for topology changes versus workflow state updates.

## Development

Install dependencies:

```bash
pnpm install --frozen-lockfile
```

Useful commands:

```bash
pnpm test
pnpm dev:desktop
pnpm build:desktop
cargo test
pnpm --filter @parallel/desktop test
```

`pnpm test` is the main repo-level verification gate today. It runs the workspace JS tests and the Rust test suites together.

The desktop app builds `projectctl` as a bundled sidecar during Tauri dev/build. Local macOS packaging writes bundles to:

- `target/release/bundle/macos/parallel.app`
- `target/release/bundle/dmg/*.dmg`

More packaging notes, including Cargo TLS/firewall caveats, live in [BUILDING.md](BUILDING.md).

## Using the product

For product operation, prefer MCP or `projectctl` over direct edits to workflow files.

Typical agent or operator flow:

1. list or inspect projects
2. ensure or resume a session
3. sync or read the plan
4. start the current step
5. log activity, notes, blockers, or decisions as work progresses
6. complete the step and refresh handoff when stopping

The detailed operator guidance lives in [plugins/parallel/skills/parallel/SKILL.md](plugins/parallel/skills/parallel/SKILL.md).
