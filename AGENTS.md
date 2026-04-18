# AGENTS.md

Repo-local guidance for agents working in this repository.

## Purpose

This repo builds the `parallel` product itself:

- desktop control surface in `apps/desktop`
- shared workflow engine in `crates/workflow-core-rs`
- CLI and MCP bridge in `crates/projectctl-rs`

Do not confuse product usage with repo implementation. If the task is to use `parallel` against another repo, prefer the product workflow in `plugins/parallel/skills/parallel/SKILL.md`. If the task is to change `parallel`, work in this codebase directly.

## Required workflow

1. Read the touched seam first.
2. Use TDD for code changes.
3. Prefer the smallest behavior-preserving change that keeps one canonical path per concept.
4. Run narrow tests during development, then finish with `pnpm test`.

Useful commands:

```bash
pnpm test
pnpm --filter @parallel/desktop test
cargo test
pnpm dev:desktop
pnpm build:desktop
```

## Hard architecture boundaries

- `refresh_projects` is the only path that should perform repo discovery.
- `load_state` must remain a discovery-free snapshot read.
- `crates/workflow-core-rs/src/read_model.rs` owns snapshot/read-model projection logic.
- `crates/workflow-core-rs/src/services.rs` owns mutation behavior.
- Keep topology-change signaling separate from snapshot-change signaling in the desktop app.

If a change blurs these boundaries, stop and simplify the design rather than patching around it.

## Canonical path rules

- Prefer one canonical representation per concept and one live path per behavior.
- Remove compatibility aliases, fallback paths, and duplicate commands when no real consumer remains.
- Translate legacy names only at the boundary, never in the core semantic layer.
- When cleanup reveals a dead seam, delete it in the same change if no concrete boundary still depends on it.

## Product-state rules

- Prefer `projectctl` or MCP mutations over direct manual edits when the task is about workflow state rather than repo internals.
- Preserve accurate ownership, blockers, and handoff semantics.
- Keep the system thinking in terms of the canonical `main` branch for workflow state unless a task explicitly requires a different contract.

## Documentation and API questions

- Use Context7 for current library, framework, SDK, API, CLI, or cloud-service documentation questions.
- Prefer the repo's real command surface over generic advice. Inspect the actual code before describing behavior.

## Verification expectations

- Favor focused tests close to the touched seam while iterating.
- Expand only as far as the change radius requires.
- Before claiming success, verify the real repo surface you changed, not just helper functions in isolation.

## Current high-signal seams

- Desktop state flow and board payload wiring live under `apps/desktop/src-tauri/src/main.rs` and `apps/desktop/src/lib`.
- CLI parsing and bridge lifecycle live in `crates/projectctl-rs/src/main.rs` and `crates/projectctl-rs/src/mcp.rs`.
- Index, watched-root resolution, and read-model projection live in `crates/workflow-core-rs/src`.
