---
name: parallel
description: "Product guidance for using parallel through its local MCP bridge or the projectctl CLI. Use when implementation is starting or resuming and execution state should be tracked through parallel: inspect projects, ensure a session, sync or read the plan, claim steps, log activity, manage blockers, propose decisions, or refresh handoff."
---

# Parallel

## When To Use

Use this skill when the user wants an agent to use `parallel` as the product:

- inspect active work across watched repos
- begin implementing an approved plan inside a repo tracked by `parallel`
- resume implementation work that was already in progress
- resume or continue a workflow session
- claim or complete steps
- record notes or activity
- set or clear blockers
- propose a decision for human review
- refresh or read the project handoff

Do not use this skill for hacking on the `parallel` codebase itself. This is about operating the product through MCP or `projectctl`.

## Starting Conditions

Reach for this skill when any of these are true:

- A plan is already approved and the agent is moving from planning into execution.
- The agent needs to resume work in a repo that may already have active sessions, a current step, blockers, or a handoff.
- The agent should make its work visible in `parallel` instead of keeping progress only in chat or local notes.
- The user asks for bridge-based workflow tracking, `projectctl`, MCP usage, handoff updates, or step ownership.
- The task requires updating execution state while work happens, not just reading code or editing files.

If the agent is beginning implementation and the repo is managed by `parallel`, default to checking `parallel` state before doing substantial work.

## What Parallel Is

`parallel` is a cross-repo workflow system with a desktop control surface plus two agent-facing adapters over the same workflow state:

- an authenticated local MCP bridge
- the `projectctl` CLI

The desktop app does three product-level jobs:

1. Watches one or more root folders and discovers git repos beneath them.
2. Shows a session-first board of active work across those repos.
3. Hosts a local authenticated MCP bridge so agents can read and mutate workflow state.

For each initialized repo, `parallel` maintains:

- a canonical ordered plan
- runtime focus and next action
- active and historical sessions
- activity log entries
- blockers
- pending decision proposals
- a generated handoff snapshot

`current_step_id` is the focused project view, not proof that only one step is active. Multiple active sessions can own different steps in the same project, while runtime focus and next action describe the primary step the product should foreground.

## Surface Map

Use either adapter depending on context:

- MCP is best when the agent is already connected through the bridge and wants structured tool calls.
- `projectctl` is best for shell-native workflows, automation, debugging, or when MCP is unavailable.

Both surfaces operate on the same underlying product model. Do not mix them with direct manual file edits unless the task is explicitly about repairing corrupted state.

## Bridge Model

- The bridge is local streamable HTTP on `127.0.0.1`.
- Access requires a bearer token.
- The desktop app is the source of truth for bridge URL, token rotation, and watched roots.
- When the endpoint or token changes, agents must use the freshly copied setup snippet from the desktop app.

If the user asks you to use `parallel`, assume the intended path is:

1. Open `parallel` desktop settings.
2. Make sure the target repo lives under a watched root.
3. Ensure Agent Bridge is enabled.
4. Connect with the copied setup snippet.
5. Use the bridge tools below rather than editing workflow files directly.

## CLI Model

- The CLI binary is `projectctl`.
- It operates on the same workflow state as MCP.
- Unless `--root` is provided, many commands resolve the current working directory as the repo root.
- Use `--json` when another tool or agent needs structured output.

## Agent Workflow

Follow this sequence unless the task is clearly read-only:

1. `list_projects`
   Use first to discover repos under watched roots and see whether each repo is initialized.
2. `get_project`
   Read full state before acting. This returns the manifest, canonical plan, runtime focus, sessions, recent activity, blockers, pending proposals, decisions, and handoff.
3. `ensure_session`
   Create or resume an agent session before making mutations. Reuse the same session when continuing related work.
4. `sync_plan`
   Use when the repo needs a canonical plan or when the plan should be updated. This is the authoritative ordered plan path.
5. `start_step`
   Claim the step your session is actively working on.
6. `append_activity`
   Log meaningful progress as you work. Use this for progress notes, observations, and execution breadcrumbs.
7. `set_blocker`
   Add a blocker when progress is gated, or clear one when unblocked.
8. `complete_step`
   Mark a step done when its contract is actually satisfied so runtime focus advances correctly.
9. `propose_decision`
   Use when a human needs to approve a tradeoff or direction.
10. `refresh_handoff`
    Run before handing work off or after significant state changes if you want the latest snapshot.

This is the default execution-time workflow for agents once planning is done.

## Execution Checklist

At the start of real work:

1. Check whether the repo is initialized and already tracked.
2. Read full state before touching code.
3. Reuse an existing session if you are clearly continuing the same line of work. Otherwise create a new session with a concrete title.
4. Confirm the current step, blockers, and next action.
5. Claim a step only when you are actually taking ownership of execution on that step.

Before stopping:

1. Log the most important progress made.
2. Clear or set blockers so the next state is truthful.
3. Complete the step if its contract is satisfied.
4. Refresh handoff so another agent can resume cleanly.

## MCP Tool Surface

The bridge exposes these product tools:

- `list_projects`
- `get_project`
- `sync_plan`
- `ensure_session`
- `update_runtime`
- `append_activity`
- `start_step`
- `complete_step`
- `set_blocker`
- `refresh_handoff`
- `propose_decision`

## CLI Surface

The equivalent `projectctl` commands are:

- `projectctl list [ROOT ...] --json`
- `projectctl show --root /path/to/repo --json`
- `projectctl session ensure --root /path/to/repo --session-id <id> --session-title "<title>" --json`
- `projectctl plan sync --root /path/to/repo --plan '<json>' --json`
- `projectctl step start <step-id> --root /path/to/repo --json`
- `projectctl step done <step-id> --root /path/to/repo --json`
- `projectctl activity add --type <type> --summary "<text>" --root /path/to/repo --json`
- `projectctl blocker add "<text>" --root /path/to/repo --json`
- `projectctl blocker clear [text] --root /path/to/repo --json`
- `projectctl note add "<text>" --root /path/to/repo --json`
- `projectctl handoff refresh --root /path/to/repo --json`
- `projectctl decision propose --title "<title>" --context "<context>" --decision "<decision>" --impact "<impact>" --root /path/to/repo --json`

Bridge lifecycle commands also exist in the CLI:

- `projectctl mcp serve-http --port <port> --token <token>`
- `projectctl mcp proxy-stdio --url <url> --token <token>`

In normal product usage, the desktop app manages bridge startup and setup snippets. Prefer the desktop app for bridge lifecycle unless the task is explicitly CLI-only.

## Operating Rules

1. Prefer MCP tools or `projectctl` over direct file edits. The product's value is that plan, runtime, sessions, activity, blockers, and handoff stay in sync.
2. Read before write. Call `get_project` or `projectctl show` before choosing a step or mutating runtime.
3. Ensure a session before starting or updating work so ownership is legible in the board.
4. Use `start_step` or `projectctl step start` only for the step you are actively taking ownership of.
5. Use `append_activity`, `projectctl activity add`, or `projectctl note add` for substantive progress, not noise.
6. Use `set_blocker` or `projectctl blocker add|clear` when the next action is genuinely blocked or unblocked.
7. Use `propose_decision` or `projectctl decision propose` instead of silently inventing policy when the user or a human maintainer needs to choose.
8. Refresh the handoff when leaving the repo in a new state another agent or human should pick up.

## Effective Usage Heuristics

- Use the same surface consistently within one short workflow. If you started through MCP, prefer staying on MCP unless shell execution makes CLI clearly better.
- Give sessions concrete titles tied to the actual task, such as `Implement session board selection` or `Investigate bridge startup failure`.
- Use `start_step` only when the step is now your active execution focus. Do not claim a step just because you inspected it.
- If you are exploring or debugging without clear ownership yet, ensure the session and append activity first. Claim the step when execution truly starts.
- Activity entries should capture meaningful state transitions, evidence, or results. Good examples: test results, reproduction confirmed, migration synced, blocker cleared, handoff updated.
- Notes should be sparse and high signal. Prefer one clear note over a stream of tiny narration.
- If runtime, plan, or step ownership appears inconsistent, read state again before trying to patch around it.

## Session Guidance

- Reuse a session when the work is the same ongoing task and you are continuing it intentionally.
- Start a new session when the task meaningfully changes, when you are switching branches of work, or when you want a clean ownership trail.
- A good session title is short, specific, and action-oriented.
- If another active session already owns the step, do not steal it casually. Read the activity and handoff first, then decide whether to coordinate, pick another step, or escalate with a decision/blocker.

## Logging Guidance

Prefer logging when:

- a session starts or resumes
- a step is claimed
- a key fact was established
- a test or validation result matters
- a blocker appears or clears
- a step completes

Avoid logging:

- every tiny shell command
- speculative thoughts with no outcome
- duplicate restatements of chat messages
- progress that is already fully captured by a step start or completion event

## Blockers And Decisions

- Use a blocker when forward progress is currently gated by a missing dependency, unanswered question, failing environment, or another owner.
- Clear the blocker as soon as the condition is gone so runtime can become truthful again.
- Use a decision proposal when the unresolved issue is not just a temporary obstacle but a real choice a human should approve.
- Do not use blockers as a substitute for handoff, and do not use decisions as a substitute for basic progress logging.

## Anti-Patterns

- Editing workflow files directly instead of going through MCP or `projectctl`
- Starting substantial implementation work without first reading current state
- Creating a fresh session for every tiny action
- Claiming a step long before actual execution begins
- Leaving blockers, next action, or handoff stale after meaningful work
- Completing a step just because code changed, without satisfying the step's real contract
- Using `parallel` only at the end as a reporting layer instead of throughout execution

## Important Constraints

- `list_projects` only sees repos under watched roots configured in the desktop app.
- Uninitialized repos will appear in `list_projects`, but they do not have full workflow state yet.
- Human decision acceptance is outside the normal agent bridge mutation flow. Agents can propose decisions, but acceptance is an explicit human-authority action.
- The desktop app may mark bridge setups stale when the token or port changes. Re-copy setup in that case.
- The bridge is local-only; do not assume a public network endpoint.
- `projectctl list` discovers repos from watched roots or explicit roots, but full workflow state only exists after initialization.

## Recommended Behavior Patterns

- To start implementing an approved plan: inspect the repo in `parallel`, ensure or resume the session, confirm the current step, then claim the step before doing meaningful execution work
- To resume work over MCP: `get_project` -> `ensure_session` -> `start_step` -> work -> `append_activity` -> `complete_step` -> `refresh_handoff`
- To resume work over CLI: `projectctl show` -> `projectctl session ensure` -> `projectctl step start` -> work -> `projectctl activity add` or `projectctl note add` -> `projectctl step done` -> `projectctl handoff refresh`
- To diagnose a blocked repo: inspect blockers, proposals, handoff, and recent activity, then clear the blocker or propose a decision through the same surface you are already using
- To establish order in an unstructured repo: ensure a session, sync the canonical plan, inspect the resulting state, then claim the first real step

## What Good Usage Looks Like

Good `parallel` usage leaves three things true:

1. The focused current step and next action are accurate.
2. Session ownership is visible for active work, even when more than one session owns a different step in the same project.
3. A later agent can read `get_project` or the handoff and understand what happened without guessing.

An effective agent uses `parallel` at the boundaries of execution:

- before substantial work, to orient
- during meaningful progress, to keep state truthful
- before handoff or exit, to leave the next agent a usable starting point
