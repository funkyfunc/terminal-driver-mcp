# terminal-driver-mcp

[![CI](https://github.com/funkyfunc/terminal-driver-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/funkyfunc/terminal-driver-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/terminal-driver-mcp)](https://www.npmjs.com/package/terminal-driver-mcp)

A PTY-backed terminal MCP server that gives AI agents a **real interactive terminal**: spawn persistent sessions, read a clean text snapshot of the rendered screen, send keystrokes, wait for patterns or idle, and assert screen state — so agents can drive and test stateful TUI applications (vim, htop, gdb, interactive git) the way a human does.

## Architecture

- **[node-pty](https://github.com/microsoft/node-pty)** allocates a real pseudo-terminal, so applications detect a TTY and behave fully interactively (colors, redraws, SIGWINCH).
- **[@xterm/headless](https://www.npmjs.com/package/@xterm/headless)** ingests the raw ANSI byte stream and maintains a stateful in-memory 2D screen grid.
- **@xterm/addon-serialize** + buffer iteration extract the grid as clean plain text (or raw VT sequences), eliminating "ANSI garbage".
- Sessions live in an in-memory registry and persist across tool calls; PTY children are hard-killed on server exit — no zombies.
- Local-first: stdio transport only, zero network access.

## Tools

| Tool | Purpose |
|---|---|
| `execute_command(command, cwd?, timeout_ms=30000)` | One-shot: run a command to completion in a fresh PTY, return full output + exit code, auto-cleanup. Kills the process and returns partial output on timeout |
| `session_create(session_id, command?, cwd?, cols=120, rows=30)` | Spawn a persistent PTY session (command via your shell, or an interactive shell) |
| `session_read(session_id, format=text\|raw, scrollback_lines=0)` | Snapshot the rendered screen; `scrollback_lines` also returns output that scrolled off the top (long logs) |
| `session_write(session_id, input?, special_keys[]?, raw_hex?, expect?)` | Type text, special keys (enter, escape, arrows, ctrl+c, f-keys, chords, …), and/or raw bytes; with `expect` it also waits for a regex — a write+wait in one call |
| `session_click(session_id, row, col, button?, count?)` | Send a mouse click (SGR) at a cell — for TUIs with mouse tracking; errors if the app isn't listening |
| `session_drag(session_id, from_row, from_col, to_row, to_col, button?)` | Mouse drag (press → move → release) for dividers, resize handles, selections |
| `session_info(session_id)` | Report what the app enabled: mouse tracking, bracketed paste, alt screen, cursor keys/keypad, insert, foreground process, dims |
| `session_wait(session_id, pattern, timeout_ms)` | Poll until a regex matches the screen |
| `session_wait_idle(session_id, idle_ms=80, timeout_ms, mode=silence\|stable_screen)` | Wait until output quiesces (byte silence) or the rendered screen stops changing |
| `session_assert(session_id, expected_text, exact_row?, exact_col?)` | Pass/fail screen assertion with contextual diff; `exact_col` pins the text to a starting column |
| `session_region(session_id, row, col, width, height)` | Extract a rectangle of the screen (a pane, status bar, or widget) |
| `session_resize(session_id, cols, rows)` | Resize PTY + emulator (SIGWINCH reflow) |
| `session_list()` | List sessions with pid/status/age |
| `session_kill(session_id)` | Terminate and clean up a session |
| `run_test(file \| test_json)` | Replay a JSON test script deterministically (see below) |

Every screen header includes the cursor position (`cursor row:col`, 0-based, matching screen row numbering).

Arrow keys are DECCKM-aware: when a full-screen app (vim, less) enables application cursor mode, arrows are sent as SS3 sequences automatically. Control chords use the byte the target understands: `ctrl+<letter>` and symbol chords (`ctrl+]`, `ctrl+\`) send their legacy C0 code (works everywhere), while chords with no legacy encoding (`shift+escape`, `ctrl+enter`, ...) fall back to CSI-u (fixterms/kitty). For anything no key name covers, `raw_hex` sends arbitrary bytes (e.g. `raw_hex: "1b5b41"` for `ESC[A`).

Typing a key name as literal text is a common mistake, so `input` values containing `{enter}`-style names or backslash escapes like `\r` are rejected with a hint pointing at `special_keys`.

The emulator also answers terminal queries (DA1, DSR cursor reports, ...) on the application's behalf, so query-happy TUIs (neovim and friends) behave as they would in a real terminal instead of hanging on a probe.

Mouse events (`session_click`, `session_drag`) are sent as SGR sequences and only when the app has enabled mouse tracking — otherwise the tools return a helpful error rather than injecting stray input. Use `session_info` to see the current tracking mode and other flags.

### Synchronization caveats

Both `session_wait_idle` modes are best-effort: continuously-animating UIs (spinners, progress bars, htop's periodic redraws) never go quiet, so those calls run to timeout — which still returns the current screen. When you know what you're waiting for, `session_wait` with a pattern is the reliable primitive. `stable_screen` mode helps with apps that emit bytes without visual change (cursor pings, identical redraws).

When a session's screen header says lines have scrolled off (e.g. after a long build), read them back with `session_read(scrollback_lines: N)` — up to 1000 lines are retained.

## Session recordings

Every persistent session is recorded to an [asciicast v2](https://docs.asciinema.org/manual/asciicast/v2/) file in `~/.terminal-driver-mcp/recordings/` (override with `TERMINAL_DRIVER_MCP_RECORDING_DIR`). Replay any session after the fact with `asciinema play <file>.cast` — full fidelity, including agent keystrokes (as input events), resizes, and emulator query responses (non-standard `"q"` events, ignored by players). The recording path is reported by `session_create` and `session_kill`. Recording is best-effort and never fails a session; `execute_command` runs are not recorded (their full output is already returned).

## Deterministic test replay

The agent drives your TUI interactively once, then writes a JSON test script that replays forever with **no LLM in the loop** — in CI via:

```sh
node dist/index.js run tests/*.json   # exit 0 = all pass, 1 = failures
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

Step types: `{"wait": "<regex>"}`, `{"idle_ms": N, "mode"?: "silence"|"stable_screen"}`, `{"write": "text", "keys": [...]}`, `{"assert": "text", "row"?, "col"?}`, `{"resize": [cols, rows]}`, `{"sleep_ms": N}`, `{"expect_exit": code}`. Execution stops at the first failing step and the report includes the final screen.

## Setup

```sh
git clone https://github.com/funkyfunc/terminal-driver-mcp.git
cd terminal-driver-mcp
npm install
npm run build
```

Register with Claude Code (from the repo directory):

```sh
claude mcp add terminal --scope user -- node "$(pwd)/dist/index.js"
```

Or, once published to npm:

```sh
claude mcp add terminal --scope user -- npx -y terminal-driver-mcp
```

Then `/mcp` inside Claude Code to confirm the connection.

## Recommended agent workflow (Assert–Act–Assert)

1. **Observe** — `session_read` for a fresh snapshot.
2. **Verify** — `session_wait` / `session_wait_idle` until the expected state is visible and stable.
3. **Act** — `session_write` with precise keystrokes.
4. **Re-verify** — `session_assert` that the action produced the expected change before proceeding.

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
