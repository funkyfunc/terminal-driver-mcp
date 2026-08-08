# Roadmap

What's shipped, and a tiered backlog of candidate work with rationale. Tiers
are ranked by (value × strategic fit) ÷ effort; items cite the research signal
behind them. Nothing below Tier 1 is committed.

## Shipped

- **Structured cell snapshot** (`session_read format: "json"`) — per-cell colors/styles, cursor, OSC 8 links.
- **`session_screenshot`** — screen rendered to PNG for vision models (`@resvg/resvg-js`, no Chromium; JetBrains Mono + Noto Symbols 2 bundled).
- **OSC 133 semantic command boundaries** — `shell_integration` + `session_last_command` / `session_wait_command` / the `command_exit` test step.
- **Deterministic test runner + record→skeleton** — `run_test`, CLI `run`, `recording_to_test`.
- **OIDC trusted publishing** — tokenless CI release with provenance, manual-approval gate.
- **MCP tool annotations** — read tools marked read-only (auto-approve), `session_kill` destructive.
- **Golden screen snapshots** — `match_screen` step + `run --update`, volatile-region masking, readable row diffs.
- **Self-contained HTML trace viewer** — `run --trace` writes one inlined `trace.html` per run (step list + per-step rendered screen, defaults to the failing step); doubles as the failure artifact.
- **CI reporters** — `run --junit <path>` / `--json <path>`.
- **Soft assertions + step grouping** — assertion steps take `soft: true` (record and continue, still fails the test); any step takes a `group` label rendered as a named section in the CLI output, trace viewer, and reporters.
- **Retries / flake quarantine** — `run --retries N` re-runs a failing test; a test that then passes is reported flaky (not failed), the Playwright convention; flaky attempts recorded in the JSON report.
- **Distribution DX** — `mcpName` in package.json + `server.json` for the [MCP registry](https://registry.modelcontextprotocol.io); README leads with the published `npx` install plus a generic-client config block.
- **Negative & count assertions** — `session_assert` / the `assert` step take `absent: true` (text is *not* on screen) and `count: N` (exactly N occurrences); `session_wait` / the `wait` step take `absent: true` to block until a pattern *disappears* (the temporal counterpart — wait for a spinner/dialog/row to clear before asserting it's gone, avoiding a redraw race). _Field requests during 0.8.0 verification._
- **1.0 tool-surface reshape** — one tool per concept with a discriminator, after a design review against flutter-driver-mcp's "focused, LLM-optimized toolset" philosophy:
  - `session_wait` unified (`until: pattern | pattern_gone | idle | stable_screen | exit`), absorbing `session_wait_idle` and adding process-exit waits; `session_assert` moved from accreted flags to a `check` enum (`contains | absent | count | at | matches` — `matches` adds regex assertions); `session_last_command` folded into `session_wait_command`.
  - **`session_batch`** — run a write→wait→assert sequence against a LIVE session in one round-trip, reusing the `run_test` step grammar verbatim (the batch is the REPL for the test DSL).
  - **`session_wait_command` stale-race fix** — a completion is only reported "fresh" after the call starts; a grace window guards the just-typed-command marker race; sessions that can never produce OSC 133 records fail fast with coaching instead of burning the timeout.
  - **Bracketed paste** (`session_write paste: true` + the `paste` write-step field) — multi-line text as one atomic paste, refused with coaching when the app hasn't enabled DECSET 2004.
  - **Mouse wheel** — `session_click button: wheel_up | wheel_down` (SGR 64/65, `count` = ticks).
  - **Error coaching pack** — unknown key names get "did you mean…?" (aliases + edit distance); pattern-wait timeouts and assert failures hint when the target is in scrollback, wrapped across rows, or differs only by case/spacing; idle-wait timeouts point at pattern waits.
- **Settled-frame pattern waits (1.1.1)** — after a pattern match, waits let output go briefly quiet (capped 500ms, ~zero cost on already-stable screens) and return the repainted screen instead of a torn mid-render frame; transient matches are flagged. Applies to `session_wait`, `session_write expect`, and `wait` steps. _Field report: a torn frame after `expect` masqueraded as two app bugs._
- **Structured tool output (1.2.0)** — `session_wait_command`, `session_info`, and `session_list` declare `outputSchema` and return typed `structuredContent` (text block kept for compatibility). `session_read` deliberately excluded: mirroring a full screen into `structuredContent` would double the token cost of every read; revisit if clients learn to dedupe.
- **Fresh matching + lifecycle hygiene (1.5.0)** — `session_write expect_fresh: true` restricts expect matching to rows that CHANGED since before the write, eliminating the stale-match class the 1.4.1 warning only flagged (a fresh timeout while the pattern matches unchanged rows says so); a vanished server cwd (directory renamed/deleted after server start) is a coached `session_create` error instead of a silently exit-1 shell; exited sessions are reaped after a TTL (default 1h, `TERMINAL_DRIVER_MCP_EXITED_TTL_MS`, 0 disables; recordings survive); `pattern_gone` and `auto_wait` promoted in tool descriptions after a field report showed they weren't being discovered. _Field report: four stale matches in one session; a renamed project dir cost twenty minutes; a five-days-dead session still listed._
- **Expect hygiene (1.4.1)** — `session_write expect` flags a match that was already on screen BEFORE the write as possibly stale (with the pattern_gone workaround spelled out); pattern-wait timeouts additionally show the closest screen line to the pattern's literal part (catches wrong/overspecified regexes and truncated content). _Field report: a stale `CLAUDE_STUB_READY` matched instantly on a dead pane; two wrong regexes each cost a diagnostic round-trip._
- **Opt-in auto-waiting (1.4.0)** — `session_assert` / the `assert` step take `within_ms` (re-check every 50ms until pass or deadline — Cypress retry-ability, works with every `check`); `session_create` / the test spec take `auto_wait: true` (input-injecting tools and write steps wait for quiet output, 80ms/2s cap, before injecting — Playwright actionability). Both off by default so timing semantics only change by explicit opt-in. _TUA-Bench shows pass@5 reliability is the field's weak spot._
- **Frame-atomic snapshots via DECSET 2026 (1.3.0)** — every snapshot path (reads, waits, asserts, transcripts) holds while the app has a synchronized-output frame open and returns only committed frames (250ms cap; frames left open >1s are expired so reads can never wedge). The true fix for torn mid-render reads on modern TUI frameworks (ratatui/notcurses/textual); the 1.1.1 settle heuristic remains for apps that don't emit the mode. `session_info` exposes `modes.synchronizedOutput`. _Claude Code #37283._ (The "frame committed" wait condition was skipped as redundant — every wait already observes only committed frames.)

---

## Tier 2 — Reliability & CI adoption

_All Tier 2 items are shipped or dropped as of 1.4.0._

### Considered and dropped

- **Publish `server.json` to the MCP registry** — the manifest exists and ships in the package; the actual `mcp-publisher` submission needs the maintainer's GitHub OIDC auth, and the maintainer has opted not to pursue it for now.

- **ANSI / escape-sequence injection sanitization** — dropped after checking our capture path: all plain-text/JSON output (`session_read text`/`json`, `session_last_command`, command records) comes from xterm's `translateToString`, which returns rendered cell glyphs — the emulator has already consumed escape sequences into cell attributes, so no raw ANSI reaches the model. The only raw path is `session_read format: "raw"`, which is intentional and labeled. A sanitizer there would be dead code that could corrupt legitimate box-drawing. Revisit only if a concrete bypass is demonstrated.

## Tier 3 — Domain extensions & framework depth (validated, second-wave)

- **Incremental / dirty-row diff reads + spill-large-output-to-file** — return only changed rows with a token-count field; page huge output to a file the model navigates instead of truncating. _HN: "polling bloats context", "spill instead of truncating."_
- **Structured "accessibility" / highlights view** — inverse-video spans, active menu/tab/button, prompt-vs-output regions as typed JSON. _Requested on HN; tui-use `highlights` proved it resonates._
- **Codegen upgrades** — text-anchor "locators" for clicks (resolve to nearest stable label, not raw row/col), assertion-picking during recording, record-at-cursor (append to an existing test). _Playwright codegen._
- **Framework depth** — fixtures/setup-teardown, watch mode + UI mode, sharding/parallelism (PTYs are independent processes → natural).
- **Tested Windows (ConPTY) + WSL** — CI-tested; a wedge since ht-mcp calls Windows "experimental."
- **Terminal image-protocol extraction** (kitty graphics / Sixel / iTerm2) — surface images a TUI emits to the agent. Only kitty-graphics-agent exists (kitty/PNG-only, tiny adoption).
- **More MCP primitives** — resources (live screen + recordings via `terminal://…` URIs), prompts (slash commands like `/drive-and-test`), elicitation (confirm `session_kill`, disambiguate sessions), `.mcpb` bundle.
- **Trust/marketing** — "why this vs tmux/ht-mcp" token-cost benchmark page (HN literally asked for it), SBOM, SECURITY.md, signed release artifacts.
- **Docs** — OSC 133 support matrix (fish 4.1+/Ghostty now emit it natively; document rather than build more shell hooks).

## Deferred / non-goals

- **Live web view + human-takeover** (WebSocket + input relay) — human visibility, not agent capability; asciicast + `session_screenshot` cover the need. Revisit if demand for live watching/steering appears (Warp productized it).
- **Remote/SSH PTY sessions** — clear whitespace (nobody offers it), but medium effort; build on demand.
- **Multi-pane / split sessions** — catch-up with tmux/cmux, not differentiation; an agent can drive tmux inside a session.
- **Session persistence across server restart** (PTY-holding daemon) — deliberate non-goal; doubles operational complexity and revives the zombie problem. Persistence is composable via tmux-in-a-session.
- **Multi-agent orchestration** (spawning other coding agents) — cmux/cmuxlayer own this niche; a different product.
- **MCP sampling / logging / roots** — deprecated in the 2026-07-28 spec; do not build on them.
