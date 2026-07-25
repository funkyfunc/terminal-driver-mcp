/**
 * MCP tool definitions: the agent-facing surface of the server. Each tool
 * validates input with zod, delegates to session/screen/wait primitives, and
 * returns text content — never a thrown error — so agents always get a
 * readable result, including the current screen wherever that helps.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { decodeHex, encodeKey } from "./keys.js";
import { encodeClick, encodeDrag, type MouseButton } from "./mouse.js";
import { formatResult, parseTest, runTest } from "./runner.js";
import {
  assertScreen,
  fullTranscript,
  snapshotRaw,
  snapshotRegion,
  snapshotText,
  statusHeader,
} from "./screen.js";
import {
  appCursorMode,
  createSession,
  getSession,
  killSession,
  listSessions,
  mouseTrackingMode,
  resizeSession,
  SCROLLBACK,
  sessionInfo,
  writeToSession,
} from "./session-manager.js";
import { recordingToSkeleton } from "./skeleton.js";
import { waitForExit, waitForIdle, waitForIdleSince, waitForPattern, waitForStableScreen } from "./wait.js";

/** stderr-only logger; stdout is reserved for MCP protocol traffic. */
export const log = (...args: unknown[]) => console.error("[terminal-driver-mcp]", ...args);

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** Wrap a handler so thrown errors become isError results instead of protocol failures. */
const safe =
  <A>(handler: (args: A) => Promise<ToolResult>) =>
  async (args: A): Promise<ToolResult> => {
    try {
      return await handler(args);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  };

/**
 * How long output must stay quiet before a tool returns the screen (idleMs),
 * bounded by timeoutMs so animated UIs cannot stall a tool call.
 */
const SETTLE = {
  afterCreate: { idleMs: 150, timeoutMs: 3000 },
  afterWrite: { idleMs: 80, timeoutMs: 2000 },
  afterResize: { idleMs: 100, timeoutMs: 3000 },
  drainAfterExit: { idleMs: 50, timeoutMs: 1000 },
  // Between input text and trailing keys: let the app finish ingesting a
  // large paste before a submit key lands, or the key can be processed
  // against half-applied text (a stray newline mid-text).
  betweenInputAndKeys: { idleMs: 60, timeoutMs: 2000 },
} as const;

type Settle = (typeof SETTLE)[keyof typeof SETTLE];

const settle = (session: Parameters<typeof waitForIdle>[0], timing: Settle) =>
  waitForIdle(session, timing.idleMs, timing.timeoutMs);

const sessionId = z.string().describe("Session identifier");
const colsSchema = z.number().int().min(20).max(500).default(120).describe("Terminal width in columns");
const rowsSchema = z.number().int().min(5).max(200).default(30).describe("Terminal height in rows");

async function screenWithHeader(id: string, scrollbackLines = 0): Promise<string> {
  const session = getSession(id);
  // Snapshot first: it flushes the emulator, so the header reflects current state.
  const screen = await snapshotText(session, scrollbackLines);
  return `${statusHeader(session)}\n${screen}`;
}

// Key names typed into 'input' as literal text (braces or backslash escapes)
// are almost always a mistaken keypress; return a hint instead of sending them.
function literalKeyMistake(input: string): string | null {
  const brace = input.match(
    /\{(enter|return|tab|esc|escape|space|backspace|delete|up|down|left|right|home|end|page_up|page_down|f\d{1,2}|(?:ctrl|alt|shift)\+[^}]+)\}/i,
  );
  if (brace) {
    return (
      `'input' contains "${brace[0]}", which would be typed as literal characters. ` +
      `To press the key, use special_keys: ["${brace[1].toLowerCase()}"]. ` +
      "If you really want the literal braces on screen, send the text in pieces."
    );
  }
  const escapeSeq = input.match(/\\([rnt])/);
  if (escapeSeq) {
    const key = escapeSeq[1] === "t" ? "tab" : "enter";
    return (
      `'input' contains the literal escape "${escapeSeq[0]}", which types a backslash and a letter, not a keypress. ` +
      `To press the key, use special_keys: ["${key}"]. ` +
      "If you really want a literal backslash, send the text in pieces."
    );
  }
  return null;
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    "session_create",
    {
      title: "Create terminal session",
      description:
        "Spawn a persistent PTY-backed terminal session running a command (or an interactive shell if omitted). " +
        "The session survives across tool calls; interact with it via session_write/session_read/session_wait. " +
        "Returns the initial screen after output settles.",
      inputSchema: {
        session_id: sessionId,
        command: z
          .string()
          .optional()
          .describe(
            "Command to run via the user's shell (e.g. 'vim /tmp/a.txt', 'htop'). Omit for an interactive shell.",
          ),
        cwd: z.string().optional().describe("Working directory (defaults to the server's cwd)"),
        cols: colsSchema,
        rows: rowsSchema,
      },
    },
    safe(async ({ session_id, command, cwd, cols, rows }) => {
      const session = createSession({ id: session_id, command, cols, rows, cwd });
      log(`created session "${session_id}" pid=${session.pty.pid} cmd=${session.command}`);
      await settle(session, SETTLE.afterCreate);
      const rec = session.recording ? `\nRecording: ${session.recording.path}` : "";
      return ok(
        `Created session "${session_id}" (pid ${session.pty.pid}).${rec}\n${await screenWithHeader(session_id)}`,
      );
    }),
  );

  let execCounter = 0;

  server.registerTool(
    "execute_command",
    {
      title: "Execute command to completion",
      description:
        "One-shot convenience: run a command in a fresh PTY, wait for it to finish, and return its full " +
        "output (including scrolled-off lines) plus exit code, cleaning up automatically. " +
        "Use for non-interactive commands; for TUIs or anything needing input mid-run, use session_create. " +
        "If the command outlives timeout_ms it is killed and partial output is returned as an error.",
      inputSchema: {
        command: z.string().describe("Command to run via the user's shell"),
        cwd: z.string().optional().describe("Working directory (defaults to the server's cwd)"),
        timeout_ms: z.number().int().min(100).max(600000).default(30000),
        cols: colsSchema,
        rows: rowsSchema,
      },
    },
    safe(async ({ command, cwd, timeout_ms, cols, rows }) => {
      const id = `__exec_${++execCounter}`;
      // Short-lived and fully returned to the caller — not worth recording.
      const session = createSession({ id, command, cols, rows, cwd, record: false });
      try {
        if (!(await waitForExit(session, timeout_ms))) {
          const partial = await fullTranscript(session);
          return fail(
            `Command still running after ${timeout_ms}ms; killing it.\nPartial output:\n${partial}`,
          );
        }
        // Drain any output that raced with process exit before reading.
        await settle(session, SETTLE.drainAfterExit);
        return ok(`Exit code: ${session.exitCode}\n${await fullTranscript(session)}`);
      } finally {
        await killSession(id);
      }
    }),
  );

  server.registerTool(
    "session_read",
    {
      title: "Read terminal screen",
      description:
        "Snapshot the current rendered screen of a session. 'text' returns the plain visual grid " +
        "(spatial layout preserved, ANSI codes stripped); 'raw' includes VT/ANSI sequences for color/style debugging. " +
        "Output that scrolled off-screen (e.g. long build/test logs) is retrievable via scrollback_lines.",
      inputSchema: {
        session_id: sessionId,
        format: z.enum(["text", "raw"]).default("text"),
        scrollback_lines: z
          .number()
          .int()
          .min(0)
          .max(SCROLLBACK)
          .default(0)
          .describe(
            "Also include up to this many lines that scrolled off the top of the screen ('text' format only)",
          ),
      },
    },
    safe(async ({ session_id, format, scrollback_lines }) => {
      const session = getSession(session_id);
      if (format === "raw") return ok(`${statusHeader(session)}\n${await snapshotRaw(session)}`);
      return ok(await screenWithHeader(session_id, scrollback_lines));
    }),
  );

  server.registerTool(
    "session_write",
    {
      title: "Write input to terminal",
      description:
        "Send keystrokes to a session: 'input' is written literally, then each entry in 'special_keys' " +
        "(enter, tab, escape, backspace, up/down/left/right, home, end, page_up, page_down, f1-f12, " +
        "ctrl+<key>, alt+<char>, shift+tab, modifier chords like shift+escape, space, delete, insert) is sent " +
        "in order, then 'raw_hex' bytes if given. Keys are held until the app finishes rendering 'input', so a " +
        "trailing Enter always submits the complete text. If 'expect' is given, waits for that regex to appear " +
        "and returns the matching screen (or errors with the final screen on timeout) — a write+wait in one call. " +
        "Note: submitting a command requires special_keys: ['enter'].",
      inputSchema: {
        session_id: sessionId,
        input: z.string().default("").describe("Literal text to type (no newline appended)"),
        special_keys: z
          .array(z.string())
          .default([])
          .describe("Special keys to send after 'input', in order"),
        raw_hex: z
          .string()
          .default("")
          .describe(
            "Escape hatch: raw bytes as hex (e.g. '1b5b41' for ESC[A) sent after keys, for sequences no key name covers",
          ),
        expect: z
          .string()
          .optional()
          .describe(
            "If set, wait for this regex on screen after writing, returning the matching (or timeout) screen",
          ),
        expect_timeout_ms: z.number().int().min(50).max(120000).default(10000),
      },
    },
    safe(async ({ session_id, input, special_keys, raw_hex, expect, expect_timeout_ms }) => {
      const session = getSession(session_id);
      if (session.exited) {
        return fail(
          `Session "${session_id}" has exited (code ${session.exitCode}); cannot write. Screen is still readable via session_read.`,
        );
      }
      const mistake = literalKeyMistake(input);
      if (mistake) return fail(mistake);

      // Encode everything up front so a bad key name, bad hex, or bad regex
      // fails before any bytes are sent (avoids leaving the terminal half-written).
      const app = appCursorMode(session);
      const encoded = special_keys.map((k) => encodeKey(k, app));
      const rawBytes = decodeHex(raw_hex);
      let regex: RegExp | undefined;
      if (expect !== undefined) {
        try {
          regex = new RegExp(expect, "m");
        } catch (err) {
          return fail(`Invalid expect regex "${expect}": ${err instanceof Error ? err.message : err}`);
        }
      }

      if (input) {
        const writtenAt = Date.now();
        writeToSession(session, input);
        // Let the app finish rendering the input before trailing keys land, so
        // a submit key (Enter) can't be processed against half-applied text.
        // Measured from the write, not last output, so an in-flight echo counts.
        if (encoded.length > 0 || rawBytes) {
          const { idleMs, timeoutMs } = SETTLE.betweenInputAndKeys;
          await waitForIdleSince(session, writtenAt, idleMs, timeoutMs);
        }
      }
      for (const bytes of encoded) writeToSession(session, bytes);
      if (rawBytes) writeToSession(session, rawBytes);

      if (regex) {
        const result = await waitForPattern(session, regex, expect_timeout_ms);
        const text = `${result.message}\n${statusHeader(session)}\n${result.screen}`;
        return result.ok ? ok(text) : fail(text);
      }
      await settle(session, SETTLE.afterWrite);
      return ok(await screenWithHeader(session_id));
    }),
  );

  server.registerTool(
    "session_wait",
    {
      title: "Wait for pattern on screen",
      description:
        "Poll the rendered screen until a regex matches (checked every 50ms against the plain-text grid, " +
        "multiline mode). Returns the screen on match; errors with the final screen on timeout. " +
        "Use this to synchronize with slow-rendering UIs before acting.",
      inputSchema: {
        session_id: sessionId,
        pattern: z.string().describe("JavaScript regex source, e.g. 'Password:' or '\\\\$\\\\s*$'"),
        timeout_ms: z.number().int().min(50).max(120000).default(10000),
      },
    },
    safe(async ({ session_id, pattern, timeout_ms }) => {
      const session = getSession(session_id);
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, "m");
      } catch (err) {
        return fail(`Invalid regex "${pattern}": ${err instanceof Error ? err.message : err}`);
      }
      const result = await waitForPattern(session, regex, timeout_ms);
      const text = `${result.message}\n${statusHeader(session)}\n${result.screen}`;
      return result.ok ? ok(text) : fail(text);
    }),
  );

  server.registerTool(
    "session_wait_idle",
    {
      title: "Wait for terminal to go idle",
      description:
        "Wait until the session stabilizes, then return the screen. Mode 'silence' resolves when no output " +
        "bytes arrive for idle_ms; 'stable_screen' resolves when the rendered text is unchanged for idle_ms " +
        "(better for apps that emit bytes without visual change). Both are best-effort and will time out on " +
        "continuously-animating UIs (spinners, progress bars) — prefer session_wait with a pattern when you " +
        "know what you're waiting for. Timeouts still return the current screen.",
      inputSchema: {
        session_id: sessionId,
        idle_ms: z
          .number()
          .int()
          .min(20)
          .max(10000)
          .default(80)
          .describe("Quiet/unchanged period required to consider the terminal stable"),
        timeout_ms: z.number().int().min(100).max(120000).default(10000),
        mode: z.enum(["silence", "stable_screen"]).default("silence"),
      },
    },
    safe(async ({ session_id, idle_ms, timeout_ms, mode }) => {
      const session = getSession(session_id);
      const result =
        mode === "stable_screen"
          ? await waitForStableScreen(session, idle_ms, timeout_ms)
          : await waitForIdle(session, idle_ms, timeout_ms);
      const text = `${result.message}\n${statusHeader(session)}\n${result.screen}`;
      return result.ok ? ok(text) : fail(text);
    }),
  );

  server.registerTool(
    "session_assert",
    {
      title: "Assert screen state",
      description:
        "Deterministic test primitive: check that expected_text appears on the visible screen. " +
        "With exact_row (0-based), the text must appear on that specific row; adding exact_col requires it " +
        "to start at that exact column. Failures include the actual content with surrounding context.",
      inputSchema: {
        session_id: sessionId,
        expected_text: z.string().describe("Substring expected on screen"),
        exact_row: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Restrict the check to this 0-based visible row"),
        exact_col: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Require expected_text to start at this 0-based column (needs exact_row)"),
      },
    },
    safe(async ({ session_id, expected_text, exact_row, exact_col }) => {
      const session = getSession(session_id);
      const result = await assertScreen(session, expected_text, exact_row, exact_col);
      return result.ok ? ok(result.message) : fail(result.message);
    }),
  );

  server.registerTool(
    "session_region",
    {
      title: "Read screen region",
      description:
        "Extract a rectangular region of the visible screen (0-based row/col, padded to exact width). " +
        "Useful for reading a specific pane, status bar, or widget without the surrounding noise.",
      inputSchema: {
        session_id: sessionId,
        row: z.number().int().min(0).describe("Top row of the region (0-based)"),
        col: z.number().int().min(0).describe("Left column of the region (0-based)"),
        width: z.number().int().min(1).max(500),
        height: z.number().int().min(1).max(200),
      },
    },
    safe(async ({ session_id, row, col, width, height }) => {
      const session = getSession(session_id);
      if (row >= session.term.rows) {
        return fail(`Row ${row} is outside the visible screen (0-${session.term.rows - 1}).`);
      }
      return ok(await snapshotRegion(session, row, col, width, height));
    }),
  );

  server.registerTool(
    "run_test",
    {
      title: "Run deterministic TUI test",
      description:
        "Replay a JSON test script against a fresh PTY session and return pass/fail per step — deterministic, " +
        "no agent in the loop, also runnable in CI via `terminal-driver-mcp run <file>`. Spec: " +
        '{"name", "command", "cwd"?, "cols"?, "rows"?, "steps": [...]} where each step is one of ' +
        '{"wait": "<regex>", "timeout_ms"?} | {"idle_ms": N, "mode"?: "silence"|"stable_screen"} | ' +
        '{"write": "text", "keys": ["enter", ...]} | {"assert": "text", "row"?: N, "col"?: N} | ' +
        '{"resize": [cols, rows]} | {"sleep_ms": N} | {"expect_exit": code}. ' +
        "Execution stops at the first failing step and includes the final screen.",
      inputSchema: {
        file: z.string().optional().describe("Path to a JSON test file"),
        test_json: z.string().optional().describe("Inline JSON test spec (alternative to file)"),
      },
    },
    safe(async ({ file, test_json }) => {
      let json: string;
      let source: string;
      if (file !== undefined && test_json !== undefined) {
        return fail("Provide either 'file' or 'test_json', not both.");
      } else if (file !== undefined) {
        json = readFileSync(file, "utf8");
        source = file;
      } else if (test_json !== undefined) {
        json = test_json;
        source = "inline test";
      } else {
        return fail("Provide 'file' (path to a JSON test) or 'test_json' (inline JSON).");
      }
      const result = await runTest(parseTest(json, source));
      const report = formatResult(result);
      return result.ok ? ok(report) : fail(report);
    }),
  );

  server.registerTool(
    "recording_to_test",
    {
      title: "Convert a recording into a test skeleton",
      description:
        "Turn a session's asciicast (.cast) recording into a run_test JSON draft — the 'drive it once by " +
        "hand, get a regression test' workflow. Recorded keystrokes become write/keys steps, pauses become " +
        "idle_ms settles (tighten these into 'wait' regexes), and the final screen becomes a suggested assert. " +
        "Returns the JSON (or writes it to out_file). Recording paths are reported by session_create/session_kill.",
      inputSchema: {
        file: z.string().describe("Path to a .cast recording"),
        out_file: z.string().optional().describe("Write the JSON here instead of returning it"),
      },
    },
    safe(async ({ file, out_file }) => {
      const spec = await recordingToSkeleton(readFileSync(file, "utf8"));
      const json = JSON.stringify(spec, null, 2);
      if (out_file) {
        writeFileSync(out_file, `${json}\n`);
        return ok(`Wrote a ${spec.steps.length}-step test skeleton to ${out_file}.`);
      }
      return ok(json);
    }),
  );

  const buttonSchema = z.enum(["left", "middle", "right"]).default("left");

  // Full-screen mouse apps require tracking mode; warn if the app isn't listening.
  function mouseGuard(session: ReturnType<typeof getSession>): string | null {
    if (mouseTrackingMode(session) === "none") {
      return (
        "The app has not enabled mouse tracking, so it will not receive mouse events " +
        "(they would be interpreted as stray input). Check session_info; the app may need focus or a mode that turns on the mouse."
      );
    }
    return null;
  }

  server.registerTool(
    "session_click",
    {
      title: "Click in the terminal",
      description:
        "Send a mouse click at a 0-based (row, col) as SGR mouse sequences — for TUIs that enable mouse " +
        "tracking (tree/list clicks, buttons, menus). button: left|middle|right; count: 2 for double-click. " +
        "Errors if the app has not enabled mouse tracking. Returns the resulting screen.",
      inputSchema: {
        session_id: sessionId,
        row: z.number().int().min(0).describe("0-based row (matches session_read)"),
        col: z.number().int().min(0).describe("0-based column"),
        button: buttonSchema,
        count: z.number().int().min(1).max(3).default(1).describe("Click count (2 = double-click)"),
      },
    },
    safe(async ({ session_id, row, col, button, count }) => {
      const session = getSession(session_id);
      const blocked = mouseGuard(session);
      if (blocked) return fail(blocked);
      writeToSession(session, encodeClick(button as MouseButton, row, col, count));
      await settle(session, SETTLE.afterWrite);
      return ok(await screenWithHeader(session_id));
    }),
  );

  server.registerTool(
    "session_drag",
    {
      title: "Drag in the terminal",
      description:
        "Press at (from_row, from_col), move to (to_row, to_col), and release — SGR mouse drag for pane " +
        "dividers, resize handles, and selections. All coordinates 0-based. Errors if mouse tracking is off.",
      inputSchema: {
        session_id: sessionId,
        from_row: z.number().int().min(0),
        from_col: z.number().int().min(0),
        to_row: z.number().int().min(0),
        to_col: z.number().int().min(0),
        button: buttonSchema,
      },
    },
    safe(async ({ session_id, from_row, from_col, to_row, to_col, button }) => {
      const session = getSession(session_id);
      const blocked = mouseGuard(session);
      if (blocked) return fail(blocked);
      writeToSession(session, encodeDrag(button as MouseButton, from_row, from_col, to_row, to_col));
      await settle(session, SETTLE.afterWrite);
      return ok(await screenWithHeader(session_id));
    }),
  );

  server.registerTool(
    "session_info",
    {
      title: "Inspect session state",
      description:
        "Report what the running app has configured: raw/mode flags (bracketed paste, mouse tracking, " +
        "application cursor/keypad, insert), alternate screen, cursor position, foreground process, and dims. " +
        "Use this to understand why input behaves unexpectedly without reverse-engineering it.",
      inputSchema: { session_id: sessionId },
    },
    safe(async ({ session_id }) => {
      // Flush pending output so mode flags reflect the latest escape sequences.
      await snapshotText(getSession(session_id));
      return ok(JSON.stringify(sessionInfo(getSession(session_id)), null, 2));
    }),
  );

  server.registerTool(
    "session_resize",
    {
      title: "Resize terminal",
      description:
        "Resize a session's terminal (PTY and emulator), triggering SIGWINCH so full-screen apps reflow. " +
        "Returns the redrawn screen.",
      inputSchema: { session_id: sessionId, cols: colsSchema, rows: rowsSchema },
    },
    safe(async ({ session_id, cols, rows }) => {
      const session = getSession(session_id);
      resizeSession(session, cols, rows);
      await settle(session, SETTLE.afterResize);
      return ok(`Resized to ${cols}x${rows}.\n${await screenWithHeader(session_id)}`);
    }),
  );

  server.registerTool(
    "session_list",
    {
      title: "List terminal sessions",
      description: "List all sessions with pid, command, dimensions, status, and age.",
      inputSchema: {},
    },
    safe(async () => {
      const sessions = listSessions();
      if (sessions.length === 0) return ok("No active sessions.");
      const rows = sessions.map((s) => {
        const state = s.exited ? `exited(${s.exitCode})` : "running";
        const age = Math.round((Date.now() - s.createdAt) / 1000);
        return `${s.id}  pid=${s.pty.pid}  ${s.term.cols}x${s.term.rows}  ${state}  ${age}s  ${s.command}`;
      });
      return ok(rows.join("\n"));
    }),
  );

  server.registerTool(
    "session_kill",
    {
      title: "Kill terminal session",
      description: "Terminate a session's process (SIGTERM, then SIGKILL) and free its resources.",
      inputSchema: { session_id: sessionId },
    },
    safe(async ({ session_id }) => {
      const { pid, recordingPath } = await killSession(session_id);
      const rec = recordingPath ? ` Recording: ${recordingPath}` : "";
      return ok(`Session "${session_id}" killed (pid ${pid}).${rec}`);
    }),
  );
}
