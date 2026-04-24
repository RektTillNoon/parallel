# Remote MCP and OAuth Track

Parallel should keep the desktop bridge local-first, but the production-grade path is a remote MCP server with standardized auth. The local bridge remains the fastest way for Codex and Claude Code on one machine to update repo-local workflow state. The remote track is for web, mobile, cloud agents, shared teams, and any client that cannot reach `127.0.0.1`.

This follows the MCP production guidance from Anthropic's April 22, 2026 article, especially three points: mature integrations usually ship API, CLI, and MCP layers; remote MCP maximizes reach across clients and deployment environments; and tools should be grouped around user intent instead of mirroring every endpoint.

## Product Boundary

- Keep `projectctl` as the local CLI and desktop sidecar.
- Keep the desktop app responsible for repo discovery, watched roots, and local setup.
- Add a hosted MCP server only after the local tool contract is stable behind `docs/generated/mcp-tools.snapshot.json`.
- Preserve the same intent-level tool names where possible: `ensure_session`, `record_execution`, `get_project`, `list_projects`.

## Hosted Server Shape

1. Introduce a remote service that exposes the same MCP tool contract over HTTPS.
2. Back it with an account/workspace model instead of raw filesystem roots.
3. Store project state in a server-side workflow store, with import/export bridges for repo-local `.project-workflow` state.
4. Keep large workflow reads progressive: `list_projects` returns summaries, `get_project` returns focused detail, and timeline payloads stay bounded.
5. Add tool-search metadata before adding broad low-level tools.

## OAuth/Auth Shape

1. Use MCP-standard OAuth client registration when supported by the target clients.
2. Treat browser/URL-mode auth as the boundary for credential collection.
3. Store refreshable credentials server-side; never ask an MCP client to pass long-lived secrets per tool call.
4. Represent authorization failures as actionable MCP errors with the reconnect URL, not generic bridge failures.
5. Keep desktop bearer tokens local-only and do not reuse them for hosted access.

## Migration Plan

1. Lock local MCP contract snapshots and smoke tests.
2. Add a hosted read-only MCP prototype with `list_projects` and `get_project`.
3. Add OAuth and workspace membership.
4. Add `record_execution` with server-side audit events.
5. Add repo-local import/export so desktop and hosted state can interoperate without shadow state.
6. Expose MCP Apps only after the plain tool contract is reliable.

## Non-Goals For The Current Desktop Pass

- No hosted auth inside Tauri.
- No cloud sync hidden behind local Settings.
- No duplicate remote-only tool names unless a real external boundary forces them.
- No endpoint-mirror MCP surface.
