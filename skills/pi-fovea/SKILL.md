---
name: pi-fovea
description: Token-efficient repo navigation with the pi-fovea code graph. Use when you need to survey an unfamiliar repository, trace where a symbol or route lives and what depends on it, assess the blast radius of a change before editing, or re-orient after files have been edited mid-session (by any tool path, including bash and pi-fabric fabric_exec programs).
---

# pi-fovea

pi-fovea maintains a cross-language code graph of the working repository — routes, symbols, imports, calls, string/env literals — and exposes it through progressive disclosure: cheap silhouettes first, detail only where you point it. It costs almost nothing until you ask, and it re-syncs automatically whenever file content drifts, no matter which tool made the edit.

## The loop

1. **`fovea_sketch`** — silhouettes only. Route/anchor inventory plus directory blobs ranked by heat. Start here in an unfamiliar repo. ~256–1024 tokens.
2. **`fovea_focus` `<query>`** — point at a symbol name, route path (`/api/users/{id}`), env key, or file path. Hot nodes come back with full signatures; warm neighbors as one-liners; the periphery stays collapsed. Already-shown nodes are suppressed, so repeated focus calls stay cheap.
3. **`fovea_dwell`** — optional second look. If a focus footer says more nodes are lit below the token threshold, dwell (diffusion time ×2) surfaces exactly those newcomers.
4. **`fovea_impact`** — blast radius. Seed with explicit repo-relative `files`, symbol names for what-if analysis, or uncommitted changes (`base` works PR-style against a ref). Output is the predicted co-change cascade ordered by warmth.

All four accept `maxTokens` (256–16000). Budget is roughly 4 chars per token.

## Working rules

- **Never bulk-read to find things.** Read what focus surfaced; let the graph answer "where is X" and "what uses X" instead of spawning searches.
- **Impact before destructive edits.** One `fovea_impact` call is cheaper than rediscovering dependents by breaking them.
- **Sketch is the safe opening bid.** If unsure, pay for a sketch; it almost never exceeds a few hundred tokens.

## Turn sync

After each assistant turn, pi-fovea diffs content hashes against its baseline. If edits moved route anchors or warmed files outside the session's disclosed set, a `[fovea turn sync]` message arrives in the next turn with the delta; otherwise everything stays silent. Treat that message as ground truth about mid-session state changes.

Sync is **mutation-path agnostic**: pi's edit/write tools, a pi-fabric `fabric_exec` program's inner `pi.edit`, a bash heredoc, a subagent, or an editor save outside the session all register identically. Content hashes are the source of truth; tool events are not consulted for detection. In repos with no `.git` directory this is also the only drift signal — do not fall back to `git status` assumptions.

## Using with pi-fabric (fabric_exec)

When writing or editing code **inside a `fabric_exec` program**, the fovea tools exist but the fabric sandbox has no built-in knowledge of them (it lazy-loads tools). Key points:

- Inside `fabric_exec`, captured extension tools use the `extensions` provider. For a known action call `await extensions.fovea_focus({ query: "CreateUserHandler", maxTokens: 6000 })`.
- For dynamic discovery, use `const hits = await tools.search({ query: "fovea_focus" })`, then call the returned namespaced ref with `tools.call({ ref: hits[0].ref, args: { query: "CreateUserHandler", maxTokens: 6000 } })`. The stable explicit ref is `extensions.fovea_focus`; bare `fovea_focus` and `fovea.fovea_focus` are invalid.
- Prefer a single `extensions.fovea_impact(...)` call over hand-rolled grep fan-outs when computing what an edit touches — the graph already resolved imports/calls across Go, TypeScript, Python, and Java.
- Any file mutation performed by the program (including `pi.edit`/`pi.write` calls inside the sandbox) is picked up by turn sync automatically, so post-edit verification does not need a re-sketch.
- The sketch `details` field carries counts (`files`, `nodes`, `anchors`); the hot-node list is the graph's highest-value entry points. On an unfamiliar repo, fetch it once and reuse instead of rediscovering entry points per call.

## CLI

The same engine runs headlessly as the `fovea` binary (repo root scan, plus JSON and TSV modes). Prefer the in-session tools unless you need scripting or a second opinion outside the extension's session state.

## Settings

`/fovea settings` in the TUI, or `fovea.json` under `~/.pi/agent/` or a trusted repo's `.pi/` directory. Relevant knobs: `sync.enabled`, `sync.budget`, `sync.warmFileThreshold` (files that must escape before a red sync fires), `tools.defaultBudget`, and `tools.replaceGrep` (default on; installs a grep-compatible Fovea override and reloads extensions).
