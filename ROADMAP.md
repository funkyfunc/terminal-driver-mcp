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

---

## Tier 1 — "The Playwright moment" (do now)

Deepen the testing moat with debugging DX that is *uniquely cheap for us*
because structured cells + asciicast + per-step PNGs are already captured. Plus
the near-free MCP hygiene that gates client auto-approval.

- **Golden screen snapshots + `run --update`** — `toMatchScreen`-style assertions storing the text (and optionally color) grid under `__screens__/`, diffed on rerun, regenerated with `--update`; volatile-region masking (clocks/PIDs/spinners) for determinism. Our cells give human-readable line diffs, better than image diffing. _teatest proves this is the idiomatic way to test TUIs; Jest/`--update` DX._
- **Self-contained HTML trace viewer** — one inlined `trace.html` per run: step list (from `run_test`), per-step screen before/after (PNG + cells), scrubbable asciicast timeline synced to steps, errors panel jumping to the failing step. The flagship "wow"; all inputs already exist. _Playwright trace viewer is the #1 cited migration reason._
- **Failure artifacts + text-diff error messages** — on a failed step, auto-retain the PNG, cells, and asciicast segment; assertion failures print expected-vs-actual screen region as a text diff plus OSC 133 command context. Cheap; reuses existing capture. _Playwright `screenshot: only-on-failure`; Testing Library "assert what the user sees."_
- **MCP tool annotations + titles** — `readOnlyHint` on read tools (auto-approve, no prompt), `destructiveHint` on `session_kill`, `idempotentHint`, friendly `title`s. ~½ day. _Missing annotations = every tool treated as maximally destructive; hurts auto-approve UX and directory acceptance._

## Tier 2 — Reliability, CI adoption, and the safety headline

- **Auto-waiting baked into actions** — promote `wait-for-idle`/pattern to implicit preconditions before each keystroke/click, and make screen assertions auto-retry to a timeout. Kills the dominant flake source. _Playwright actionability / Cypress retry-ability; TUA-Bench shows pass@5 reliability is the field's weak spot._
- **Reporters (JUnit/JSON/HTML) + `test.step` + soft assertions** — JUnit XML is the "runs in our CI" unlock; steps + soft assertions make long tests readable and report all failures at once. _Playwright reporters/steps._
- **Retries + flake detection/quarantine** — `--retries`, tri-state passed/flaky/failed, **fresh PTY per retry** (a wedged terminal is our #1 flake source), quarantine bucket. _Playwright test-retries._
- **ANSI / escape-sequence injection sanitization** — a snapshot mode that neutralizes dangerous escapes (hidden-text `\033[8m`, OSC exfil/clipboard triggers) before returning to the model, with a raw-vs-sanitized toggle and a flagged-sequence report. Novel — no terminal MCP does it. _Validated live threat: Trail of Bits / Bright Security "ANSI-in-MCP", 2026 macOS DNS-exfil-via-escape exploit; #1 concern on the HN "Show HN: tui-use" thread._
- **Structured tool output** (`outputSchema` + `structuredContent`) on `list_sessions`, `session_read`, `session_wait`, `session_create` — typed results instead of JSON-in-text so agents can chain calls reliably. Keep the text block for compatibility.
- **Distribution DX** — publish to the MCP Registry (`mcpName` in package.json + `server.json`), multi-client install snippets/badges in the README (`claude mcp add`, VS Code/Cursor/etc.), tool catalog. _playwright-mcp is the model; the registry is the discovery layer directories pull from._

## Tier 3 — Domain extensions & framework depth (validated, second-wave)

- **Synchronized-output (DECSET 2026) frame-atomic snapshots** — buffer between `\e[?2026h/l`, surface only complete frames, expose "frame committed" as a wait condition. Fixes torn mid-render reads. _Claude Code #37283._
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
