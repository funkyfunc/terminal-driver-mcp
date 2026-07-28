# terminal-driver-mcp

### A real terminal for your AI agent — one it can actually *use*, not just fire commands at.

[![CI](https://github.com/funkyfunc/terminal-driver-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/funkyfunc/terminal-driver-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/terminal-driver-mcp)](https://www.npmjs.com/package/terminal-driver-mcp)

An MCP server that gives an agent a persistent, PTY-backed terminal with a headless screen it can read, type into, wait on, and assert against — so it can drive `vim`, `htop`, `gdb`, a Python REPL, an SSH prompt, or **the very TUI you're building with it**, exactly the way a human would.

## Why not just let the agent use its built-in terminal?

Because the built-in terminal isn't really a terminal. Coding agents run each command against a **pipe**, fire-and-forget, and hand back the raw bytes. That breaks the moment anything is interactive:

| The built-in terminal | terminal-driver-mcp |
|---|---|
| **No TTY** — `vim`, `htop`, `top`, `less` detect a pipe and refuse, degrade, or hang until they're killed | A real pseudo-terminal: apps behave exactly as they do for a human (colors, redraws, `SIGWINCH`) |
| **Fire-and-forget** — the call returns only when the process *exits*, so it can never answer a password prompt, a `y/n`, an `ssh` 2FA, or a `git rebase -i` | Sessions **persist** across tool calls — type, read, type again; sit in a debugger or REPL for a whole conversation |
| **Chronological byte stream** — you get a log of ANSI escape codes; where anything landed on screen is unrecoverable | A live **2D screen** you read as clean text — menus, dialogs, cursor position, exact rows and columns |
| **No way to sync** — the agent guesses when the UI is ready and types blind | `wait` for a pattern or for output to go idle before acting — the Assert-Act-Assert loop |
| **Can't verify its own TUI work** — the feedback loop bottoms out at "it compiled" | Snapshot, assert, `session_click`, resize, and **record a session into a replayable regression test** |

Keep using the built-in terminal for `npm test` and `git status`. Reach for this the moment the work is **interactive, stateful, full-screen, mouse-driven, or something the agent needs to test rather than just run**.

## Architecture

- **[node-pty](https://github.com/microsoft/node-pty)** allocates a real pseudo-terminal, so applications detect a TTY and behave fully interactively (colors, redraws, SIGWINCH).
- **[@xterm/headless](https://www.npmjs.com/package/@xterm/headless)** ingests the raw ANSI byte stream and maintains a stateful in-memory 2D screen grid.
- **@xterm/addon-serialize** + buffer iteration extract the grid as clean plain text (or raw VT sequences), eliminating "ANSI garbage".
- Sessions live in an in-memory registry and persist across tool calls; PTY children are hard-killed on server exit — no zombies.
- Local-first: stdio transport only, zero network access.

**Session lifetime:** sessions are in-memory and last as long as the server process. They survive tool calls and child-process exit (the final screen stays readable), but **not** a restart of the MCP server itself — if the client relaunches it, or it is killed, all PTYs go with it. Stray async errors no longer trigger this: the server logs and keeps serving instead of crashing, and every deliberate shutdown logs its cause (signal, client disconnect) to stderr.

## Tools

| Tool | Purpose |
|---|---|
| `execute_command(command, cwd?, timeout_ms=30000)` | One-shot: run a command to completion in a fresh PTY, return full output + exit code, auto-cleanup. Kills the process and returns partial output on timeout |
| `session_create(session_id, command?, cwd?, cols=120, rows=30)` | Spawn a persistent PTY session (command via your shell, or an interactive shell) |
| `session_read(session_id, format=text\|raw\|json, scrollback_lines=0)` | Snapshot the rendered screen; `json` returns a structured cell model (colors, styles, cursor, OSC 8 links); `scrollback_lines` also returns output that scrolled off the top |
| `session_screenshot(session_id, scrollback_lines=0)` | Render the screen (colors, box-drawing, cursor) to a PNG image for vision models |
| `session_write(session_id, input?, special_keys[]?, paste?, raw_hex?, expect?)` | Type text, special keys (enter, escape, arrows, ctrl+c, f-keys, chords, …), and/or raw bytes; `paste:true` delivers `input` as one atomic bracketed paste; with `expect` it also waits for a regex — a write+wait in one call |
| `session_click(session_id, row, col, button?, count?)` | Mouse click or scroll wheel (SGR) at a cell — `button` also takes `wheel_up`/`wheel_down` (`count` = ticks); errors if the app isn't listening |
| `session_drag(session_id, from_row, from_col, to_row, to_col, button?)` | Mouse drag (press → move → release) for dividers, resize handles, selections |
| `session_info(session_id)` | Report what the app enabled: mouse tracking, bracketed paste, alt screen, cursor keys/keypad, insert, foreground process, dims |
| `session_wait_command(session_id, timeout_ms)` | Wait for the in-flight shell command to finish, then return its exact output/exit code/duration; returns the last completed command if the shell is idle (needs `shell_integration`) |
| `session_wait(session_id, until=pattern\|pattern_gone\|idle\|stable_screen\|exit, pattern?, idle_ms?, timeout_ms)` | One synchronization tool: wait for a regex to appear or disappear, for output silence, for a stable rendered screen, or for process exit |
| `session_assert(session_id, check=contains\|absent\|count\|at\|matches, text, row?, col?, count?)` | Pass/fail screen assertion with contextual diff and near-miss hints; one `check` discriminator instead of a pile of flags |
| `session_batch(session_id, steps[], screens_dir?)` | Run a write→wait→assert step sequence against a **live** session in one call — same step grammar as `run_test`, per-step results, stops on first hard failure |
| `session_region(session_id, row, col, width, height)` | Extract a rectangle of the screen (a pane, status bar, or widget) |
| `session_resize(session_id, cols, rows)` | Resize PTY + emulator (SIGWINCH reflow) |
| `session_list()` | List sessions with pid/status/age |
| `session_kill(session_id)` | Terminate and clean up a session |
| `run_test(file \| test_json)` | Replay a JSON test script deterministically (see below) |
| `recording_to_test(file, out_file?)` | Convert a session's `.cast` recording into a `run_test` JSON draft |

Every screen header includes the cursor position (`cursor row:col`, 0-based, matching screen row numbering).

### Migrating from 0.x

1.0 reshaped the tool surface so every concept has exactly one home ([design notes](ROADMAP.md)). JSON **test files are untouched** — only tool schemas changed:

| 0.x | 1.0 |
|---|---|
| `session_wait(pattern, absent: true)` | `session_wait(until: "pattern_gone", pattern)` |
| `session_wait_idle(mode: "silence" \| "stable_screen")` | `session_wait(until: "idle" \| "stable_screen")` |
| — | `session_wait(until: "exit")` *(new)* |
| `session_assert(expected_text, exact_row, exact_col)` | `session_assert(text, check: "at", row, col)` |
| `session_assert(…, absent: true)` / `(…, count: N)` | `session_assert(…, check: "absent")` / `(…, check: "count", count: N)` |
| — | `session_assert(check: "matches")` *(new: regex)* |
| `session_last_command(…)` | `session_wait_command(…)` (returns the last command immediately when the shell is idle) |

Arrow keys are DECCKM-aware: when a full-screen app (vim, less) enables application cursor mode, arrows are sent as SS3 sequences automatically. Control chords use the byte the target understands: `ctrl+<letter>` and symbol chords (`ctrl+]`, `ctrl+\`) send their legacy C0 code (works everywhere), while chords with no legacy encoding (`shift+escape`, `ctrl+enter`, ...) fall back to CSI-u (fixterms/kitty). For anything no key name covers, `raw_hex` sends arbitrary bytes (e.g. `raw_hex: "1b5b41"` for `ESC[A`).

Typing a key name as literal text is a common mistake, so `input` values containing `{enter}`-style names or backslash escapes like `\r` are rejected with a hint pointing at `special_keys` — and an unknown key name gets a "did you mean…?" suggestion (`pgup` → `page_up`).

Multi-line text belongs in a bracketed paste: `session_write(input: "...", paste: true)` wraps the text in paste markers so REPLs and editors receive it as **one atomic paste** — newlines don't submit, auto-indent doesn't mangle it. Requires the app to have bracketed paste enabled (`session_info` shows it); if it hasn't, the tool refuses rather than leaking markers as stray input.

The emulator also answers terminal queries (DA1, DSR cursor reports, ...) on the application's behalf, so query-happy TUIs (neovim and friends) behave as they would in a real terminal instead of hanging on a probe.

Mouse events (`session_click`, `session_drag`) are sent as SGR sequences and only when the app has enabled mouse tracking — otherwise the tools return a helpful error rather than injecting stray input. `session_click` with `button: "wheel_up"`/`"wheel_down"` scrolls (one SGR wheel event per `count` tick) for pagers, lists, and fzf-style pickers. Use `session_info` to see the current tracking mode and other flags.

### Synchronization

`session_wait` is the single synchronization tool; `until` picks the condition:

- `pattern` (default) — a regex appears on screen: the reliable primitive when you know what you're waiting for.
- `pattern_gone` — the regex *stops* matching: wait for a spinner/dialog/just-deleted row to clear without racing the redraw.
- `idle` / `stable_screen` — output goes quiet / the rendered text stops changing for `idle_ms`. Best-effort: continuously-animating UIs (spinners, progress bars, htop) never settle, so these run to timeout — which still returns the current screen, plus a hint to switch to a pattern wait.
- `exit` — the session's process terminates (after `:q`, `ctrl+d`, …).

Timed-out pattern waits coach recovery: if the pattern actually matched in scrollback (it scrolled off) or matches ignoring case, the error says so.

When a session's screen header says lines have scrolled off (e.g. after a long build), read them back with `session_read(scrollback_lines: N)` — up to 1000 lines are retained.

## Batched steps against a live session

`session_batch` runs a short write→wait→assert sequence against an **existing** session in one round-trip, using the exact `run_test` step grammar (including `soft:` and `group:`):

```
session_batch(session_id: "vim", steps: [
  { "write": ":%s/foo/bar/g", "keys": ["enter"] },
  { "wait": "substitutions" },
  { "assert": "bar", "row": 0 },
  { "assert": "foo", "absent": true }
])
  → per-step ✓/✗ report + one final screen
```

Execution stops at the first hard failure. Because the grammar is shared, a step sequence that works interactively pastes directly into a `run_test` script — `session_batch` is the REPL for the test DSL.

## Semantic command boundaries (OSC 133)

Create a shell session with `shell_integration: true` (interactive `bash`/`zsh`) and the server injects OSC 133 hooks, so it knows exactly when each command starts and finishes:

```
session_create(session_id: "sh", shell_integration: true)
session_write(session_id: "sh", input: "npm test", special_keys: ["enter"])
session_wait_command(session_id: "sh")   // blocks until npm test finishes
  → { command: "npm test", exit_code: 1, duration_ms: 8423, output: "…just the test output…" }
```

No blind waits, no CPU heuristics, no marker collisions — and the result contains **only that command's output** instead of the whole screen, which is far cheaper in tokens. If the shell is already idle at a prompt, `session_wait_command` returns the most recent completed command immediately (a short grace window guards against returning a stale result while a just-typed command's start marker is still in flight). On a session that can never produce command records it fails fast with the fix instead of burning the timeout. In `run_test` scripts, a `{ "command_exit": 0 }` step asserts the last command's exit code. Requires bash ≥ 4.4 or zsh; on shells without support the session still works, just without command tracking.

## Structured & visual snapshots

`session_read(format: "json")` returns a structured cell model — per-row runs with `fg`/`bg` colors and `bold`/`italic`/`underline`/etc. attributes, the cursor position, and any OSC 8 hyperlink ranges — so an agent can assert on color-encoded state (errors red, selection highlighted) that plain text discards. `session_screenshot` renders the same state to a PNG (bundled monospace font, Chromium-free via `@resvg/resvg-js`) for a vision-capable model to inspect layout and color directly.

## Session recordings

Every persistent session is recorded to an [asciicast v2](https://docs.asciinema.org/manual/asciicast/v2/) file in `~/.terminal-driver-mcp/recordings/` (override with `TERMINAL_DRIVER_MCP_RECORDING_DIR`). Replay any session after the fact with `asciinema play <file>.cast` — full fidelity, including agent keystrokes (as input events), resizes, and emulator query responses (non-standard `"q"` events, ignored by players). The recording path is reported by `session_create` and `session_kill`. Recording is best-effort and never fails a session; `execute_command` runs are not recorded (their full output is already returned).

## Deterministic test replay

The agent drives your TUI interactively once, then writes a JSON test script that replays forever with **no LLM in the loop** — in CI via:

```sh
node dist/index.js run tests/*.json               # exit 0 = all pass, 1 = failures
node dist/index.js run --junit out.xml tests/*.json  # + JUnit report for CI (also --json)
node dist/index.js run --trace tests/*.json          # + a self-contained HTML trace per test
node dist/index.js run --retries 2 tests/*.json      # re-run failures; pass-on-retry = flaky, not failed
```

or ad-hoc via the `run_test` tool. Example script:

```json
{
  "name": "editor smoke test",
  "command": "vim -u NONE /tmp/t.txt",
  "cols": 100,
  "rows": 24,
  "steps": [
    { "wait": "~", "timeout_ms": 8000 },
    { "write": "ihello", "keys": ["escape"] },
    { "assert": "hello", "row": 0, "col": 0 },
    { "resize": [60, 15] },
    { "write": ":q!", "keys": ["enter"] },
    { "expect_exit": 0 }
  ]
}
```

Step types: `{"wait": "<regex>", "absent"?}` (`absent:true` waits until the pattern *disappears*), `{"idle_ms": N, "mode"?: "silence"|"stable_screen"}`, `{"write": "text", "keys": [...], "raw_hex"?, "paste"?}` (`paste:true` sends the text as one bracketed paste), `{"assert": "text", "row"?, "col"?, "absent"?, "count"?}` (`absent:true` asserts the text is *not* on screen; `count:N` asserts exactly N occurrences), `{"match_screen": "name", "mask"?: ["<regex>"]}`, `{"resize": [cols, rows]}`, `{"sleep_ms": N}`, `{"command_exit": N}` (with `"shell_integration": true`), `{"expect_exit": code}`. Execution stops at the first failing step and the report includes the final screen. The same steps run against a live session via `session_batch`.

**Soft assertions & grouping.** Any assertion step (`assert`, `match_screen`, `command_exit`, `expect_exit`) can set `"soft": true` — a soft failure is recorded and still fails the test, but execution continues instead of stopping, so a single run surfaces every problem. Any step can carry a `"group": "label"`; consecutive steps sharing a label render as a named section in the CLI output, the trace viewer, and the reporters.

**Golden snapshots.** A `match_screen` step compares the whole rendered screen against a stored golden file (in a `__screens__/` dir beside the test); regenerate with `run --update`, and mask volatile regions (clocks, PIDs) with `mask` regexes. Because the screen is a canonical text grid, mismatches show as a readable row diff.

**HTML trace viewer.** `run --trace` (or the `run_test` `trace_file` param) writes a self-contained `trace.html` per test: a step list, the rendered screen captured after each step (colors and all), and a jump to the failing step — the terminal equivalent of Playwright's trace viewer, ideal as a CI failure artifact.

**CI reporters.** `--junit <path>` and `--json <path>` write aggregated reports every CI system understands.

### Drive once, get a test

You don't have to write the JSON by hand. Drive a session interactively, then convert its recording into a `run_test` draft:

```sh
node dist/index.js skeleton ~/.terminal-driver-mcp/recordings/<session>.cast tests/mytest.json
```

or the `recording_to_test` tool mid-session. Recorded keystrokes become `write`/`keys` steps, pauses become `idle_ms` settles (tighten these into precise `wait:` regexes), and the final screen becomes a suggested `assert`. The output is a runnable skeleton you refine — the fast path from "I just did this by hand" to "this is a regression test."

## Setup

Published to npm as [`terminal-driver-mcp`](https://www.npmjs.com/package/terminal-driver-mcp); no clone or build needed. Register with Claude Code in one line:

```sh
claude mcp add terminal --scope user -- npx -y terminal-driver-mcp
```

Then `/mcp` inside Claude Code to confirm the connection.

For any other MCP client, point it at the same command:

```json
{
  "mcpServers": {
    "terminal": {
      "command": "npx",
      "args": ["-y", "terminal-driver-mcp"]
    }
  }
}
```

The server is also listed in the [MCP registry](https://registry.modelcontextprotocol.io) as `io.github.funkyfunc/terminal-driver-mcp`.

### From source (for development)

```sh
git clone https://github.com/funkyfunc/terminal-driver-mcp.git
cd terminal-driver-mcp
npm install
npm run build
claude mcp add terminal --scope user -- node "$(pwd)/dist/index.js"
```

## Recommended agent workflow (Assert–Act–Assert)

1. **Observe** — `session_read` for a fresh snapshot.
2. **Verify** — `session_wait` (a pattern when you know it; `until:"idle"` otherwise) until the expected state is visible and stable.
3. **Act** — `session_write` with precise keystrokes.
4. **Re-verify** — `session_assert` that the action produced the expected change before proceeding.

Once a flow is understood, collapse the loop: `session_batch` runs act+verify sequences in one call.

## Development

```sh
npm run dev        # tsc --watch
npm test           # build + unit + e2e + gauntlet suites
npm run lint       # biome check
npm run format     # biome format --write
npm run inspector  # hand-drive tools in the MCP Inspector UI
```

Three test layers: `test/unit-screen.mjs` pins screen-reading invariants (flush-before-read, wide-char columns) fast and deterministically; `test/e2e.mjs` drives every tool over a real stdio MCP connection (including real vim); and `test/gauntlet.mjs` runs an adversarial `torture-tui.mjs` through the server in lockstep — capability probes, byte-split escape sequences, wide characters, an output firehose, a live-redrawing alternate screen, exact keystroke-byte verification (arrows in both cursor modes, CSI-u chords), SIGWINCH, and a slow dialog. The gauntlet is where the hard terminal-compatibility bugs surface.

Git hooks (activated automatically by `npm install` via `core.hooksPath`): pre-commit runs lint + typecheck, pre-push runs the full test suite. CI runs the same on Ubuntu and macOS.

Note: `postinstall` restores the execute bit on node-pty's prebuilt `spawn-helper` (npm strips it on macOS, which otherwise causes `posix_spawnp failed`).
