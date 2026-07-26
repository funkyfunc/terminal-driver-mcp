# Roadmap

Deferred ideas, kept here so they're recorded rather than lost. Nothing here is committed work — each has a one-line rationale for why it's *not* being built yet.

## Shipped (0.6.0)

- **Structured cell snapshot** (`session_read format: "json"`) — per-cell colors/styles, cursor, and OSC 8 links.
- **`session_screenshot`** — screen rendered to PNG for vision models (`@resvg/resvg-js`, no Chromium).
- **OSC 133 semantic command boundaries** — `shell_integration` + `session_last_command` / `session_wait_command` / the `command_exit` test step.

## Deferred

- **Live web view** (WebSocket + xterm.js browser preview, ht-mcp's marquee feature) — human-facing visibility, not an agent capability. Deferred because asciicast recording (post-hoc replay) and `session_screenshot` (on-demand image) already cover the need without running an HTTP/WS server and managing ports.
- **Terminal image-protocol extraction** (kitty graphics / Sixel / iTerm2 inline images) — surface images a TUI emits *to* the agent (image viewers, plots, `timg`). Genuinely novel — nobody in the space does it — but medium-high effort (parse APC/DCS payloads xterm ignores). Detection-only ("image emitted, N×M px") is a cheap first cut. Build after the multimodal PNG feature proves demand.
- **DECSET 2026 synchronized-output-aware snapshots** — honor `?2026h/?2026l` so snapshots/`wait_idle` capture only complete frames, eliminating torn/mid-render reads. Correctness polish that pairs with `wait_idle`; low-medium effort. Waiting for evidence torn frames actually cause flaky agent decisions in practice.
- **Visual golden snapshots in `run_test`** (`toMatchTerminalSnapshot`, `--update` flow, cell/pixel diffs on failure) — fuses the deterministic LLM-free runner with image regression. Builds directly on the `session_screenshot` renderer, so it's the natural follow-on once PNG rendering lands.
- **Incremental / dirty-row reads** (`session_read mode: "changes"`, `diff_since(token)`) — return only changed rows to cut token cost on large screens. Partly subsumed by OSC 133 returning just the last command's output; revisit if full-screen reads remain a cost problem after that ships.
- **Multi-pane / split sessions** — multiple logical panes per session with per-pane snapshots. This is catch-up with tmux/cmux, not differentiation. Build only if users ask; our single-PTY model is simpler and an agent can always drive tmux *inside* a session.
- **Session persistence across server restart** (a PTY-holding daemon the MCP server connects to over a Unix socket) — a deliberate non-goal for now. It roughly doubles operational complexity and reintroduces the process-lifecycle/zombie problem in a harder form, for a use case (surviving a *deliberate* server restart) that's rare now that crashes no longer cascade. Persistence is already composable: run tmux or another multiplexer inside a session. Revisit only if users report losing sessions they cared about in normal use.
