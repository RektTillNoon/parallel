# Parallel Session Board Design

## Summary

Redesign the desktop app from a repo-first dashboard into a session-first personal command center. The default screen should foreground active work across repos, make ownership legible at a glance, and demote repo detail into a secondary contextual rail.

This is a structural and visual redesign only. The product identity stays within the existing `parallel` family.

## Design Context

- Target audience: one primary user operating `parallel` as a personal command center
- Core job: follow plans and tasks across all sessions in parallel, without losing track of ownership or next actions
- Tone: quiet editorial, soft and refined
- Visual constraint: preserve the existing `parallel` language rather than rebrand

## Non-Negotiables

- Keep the warm light canvas
- Keep the Doto `parallel` wordmark
- Keep mono utility labels and restrained red accents
- Keep the app feeling like `parallel`, not a new dashboard system
- Reduce noise, duplication, and card-heavy framing
- Make cross-repo session ownership the primary information layer

## Problem Statement

The current UI is crowded and repo-centric. It uses too many equally weighted panels, repeats metadata across surfaces, and makes it harder than necessary to scan live work across sessions. The result is visual competition where the user needs hierarchy.

## Primary Goal

Let the user answer this question within a few seconds of opening the app:

`What is active right now, who owns it, and what matters next?`

## Information Hierarchy

### Primary

The active session board across repos.

Each session row should make these fields immediately legible:

- Session title
- Repo name
- Owning step
- Status
- Last activity time

### Secondary

Selected context for the currently focused session or repo:

- Repo name
- Repo path
- Current step
- Step summary
- Compressed recent activity

### Tertiary

Operational metadata and navigation:

- Counts
- Last sync time
- Repo list
- Settings

## Layout

### Sidebar

Preserve the existing left sidebar footprint and role, but make it quieter.

Contents:

- Doto `parallel` wordmark
- Sync action
- Root/repo count
- Repo list
- Settings pill

The sidebar remains navigational, not informational. It should not compete with the main board.

### Main Canvas

The main canvas becomes a two-column board:

- Primary column: session ledger across repos
- Secondary rail: selected repo/session context

### Topline

A minimal top strip replaces the current repo hero card.

It should contain only:

- Small title for the board
- Brief guidance that this is a cross-repo session view
- Active session count
- Blocked session count
- Repos with live work
- Last sync/last activity time

This strip must read as orientation, not as a feature panel.

### Session Ledger

The ledger is the core of the screen.

Rules:

- Render as a calm vertical list, not a grid of cards
- Use thin rules and spacing for separation
- Avoid heavy panel nesting
- Keep one selected row slightly more prominent
- Preserve legibility when multiple sessions are visible

Session row content:

- Session title on the first line
- Status adjacent but visually lighter than the title
- Repo and owning step on a secondary line
- One-line summary or next action below
- Relative time on the far edge

### Context Rail

The right rail is a quiet note column, not a competing dashboard stack.

Contents:

- Selected repo
- Repo path
- Current step title
- Current step summary
- Recent activity, compressed to a short list

Plan detail should be limited by default to the current step and immediate next step. Full plan visibility can remain accessible later, but not dominant on the default screen.

## Visual System

### Color

- Background: warm off-white, close to the current app
- Surfaces: white or slightly warm white
- Rules: soft gray
- Text: near-black
- Muted metadata: warm gray
- Accent: current restrained red, used sparingly

Red remains an event color, not a decorative system color.

### Typography

Do not introduce a new typographic voice.

Keep:

- Doto for the `parallel` wordmark or one hero moment only
- Existing sans for body copy
- Existing mono for utility labels, timestamps, and status language

Typography should create hierarchy through size, spacing, and restraint rather than through more colors or more type styles.

### Shape and Framing

- Preserve soft rounded corners already present in the app
- Reduce the number of bordered panels
- Prefer open space and thin rules over stacked cards
- Keep a desktop-native softness without adding blur or glass effects

### Motion

Motion should stay minimal and mechanical:

- short fades
- subtle reveal on selection changes
- no decorative motion

## What To Remove Or Reduce

- The large repo hero card
- The equal weighting of focus, sessions, plan, and timeline panels
- Duplicate progress and ownership metadata across multiple areas
- Full plan presentation as a dominant default surface
- Heavy bordered containers around every section

## Functional Expectations

- Default state should open to the cross-repo session board
- Repo detail becomes secondary to the board
- Selecting a session or repo updates the context rail
- Users can still access repo-specific detail, but it should not dominate first paint

## Out Of Scope

- Rebranding `parallel`
- New dark theme work
- New information architecture beyond the approved session-first board
- Adding new workflow features during the redesign

## Success Criteria

- The user can identify all active sessions and their owners within a few seconds
- The user can identify the most important active step without scanning multiple cards
- The screen feels calmer and more distilled than the current dashboard
- The app still feels recognizably like `parallel`

## Implementation Notes

- Reuse the existing design tokens where possible
- Prefer removing structure over adding new structure
- Keep the redesign behavior-preserving wherever layout changes allow
- Preserve accessibility and keyboard navigation while simplifying the surface

## Spec Review

Quick self-review:

- No unresolved placeholders remain
- The approved direction is explicit: session-first board with detail rail
- Visual identity is constrained to the current `parallel` language
- Scope is bounded to layout and presentation, not feature expansion
