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
import { encodeClick, encodeDrag, encodeWheel, type MouseButton, type WheelDirection } from "./mouse.js";
import { renderPng } from "./render.js";
import { executeSteps, formatResult, parseTest, runTest, StepSchema } from "./runner.js";
import {
  assertScreenWithin,
  fullTranscript,
  snapshotCells,
  snapshotRaw,
  snapshotRegion,
  snapshotText,
  statusHeader,
} from "./screen.js";
import {
  appCursorMode,
  bracketedPasteMode,
  commandIsRunning,
  createSession,
  getSession,
  killSession,
  listSessions,
  mouseTrackingMode,
  resizeSession,
  SCROLLBACK,
  sessionInfo,
  wrapPaste,
  writeToSession,
} from "./session-manager.js";
import { recordingToSkeleton } from "./skeleton.js";
import { waitForExit, waitForIdle, waitForIdleSince, waitForPattern, waitForStableScreen } from "./wait.js";

/** stderr-only logger; stdout is reserved for MCP protocol traffic. */
export const log = (...args: unknown[]) => console.error("[terminal-driver-mcp]", ...args);

type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image"; data: string; mimeType: string };
type ToolResult = {
  content: (TextContent | ImageContent)[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
/** Success with typed structuredContent; the text block mirrors it for older clients. */
const okStructured = (data: Record<string, unknown>, text?: string): ToolResult => ({
  content: [{ type: "text", text: text ?? JSON.stringify(data, null, 2) }],
  structuredContent: data,
});
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });
const image = (png: Buffer, caption: string): ToolResult => ({
  content: [
    { type: "text", text: caption },
    { type: "image", data: png.toString("base64"), mimeType: "image/png" },
  ],
});

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

// Tool annotations: hints that let clients auto-approve reads and flag
// destructive ops. Without them, clients treat every tool as maximally
// destructive (confirmation friction on every call). openWorldHint stays false
// — a terminal driver is a closed domain (the tool, not the app it runs).
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const MUTATING = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

/**
 * How long output must stay quiet before a tool returns the screen (idleMs),
 * bounded by timeoutMs so animated UIs cannot stall a tool call.
 */
const SETTLE = {
  afterCreate: { idleMs: 150, timeoutMs: 3000 },
  afterWrite: { idleMs: 80, timeoutMs: 2000 },
  // auto_wait actionability precondition: don't inject input while the screen
  // is still mutating (bounded, so an animating UI can't block input forever).
  beforeAction: { idleMs: 80, timeoutMs: 2000 },
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

/** auto_wait sessions: hold input until output quiesces (bounded) so keystrokes never land mid-redraw. */
const actionPrecondition = async (session: ReturnType<typeof getSession>): Promise<void> => {
  if (session.autoWait && !session.exited) await settle(session, SETTLE.beforeAction);
};

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
      annotations: MUTATING,
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
        shell_integration: z
          .boolean()
          .default(false)
          .describe(
            "Interactive-shell only (bash/zsh): inject OSC 133 hooks so session_wait_command " +
              "reports each command's exact output and exit code",
          ),
        auto_wait: z
          .boolean()
          .default(false)
          .describe(
            "Actionability opt-in: session_write/session_click/session_drag on this session first wait " +
              "for output to go quiet (80ms, capped at 2s) so input never lands on a mid-redraw screen. " +
              "Adds a little latency per action; avoid for continuously-animating UIs",
          ),
      },
    },
    safe(async ({ session_id, command, cwd, cols, rows, shell_integration, auto_wait }) => {
      const session = createSession({
        id: session_id,
        command,
        cols,
        rows,
        cwd,
        shellIntegration: shell_integration,
        autoWait: auto_wait,
      });
      log(`created session "${session_id}" pid=${session.pty.pid} cmd=${session.command}`);
      await settle(session, SETTLE.afterCreate);
      // Wait until shell-integration hooks are live so the first command is tracked.
      if (session.integrationReady) await session.integrationReady;
      const rec = session.recording ? `\nRecording: ${session.recording.path}` : "";
      const si = session.shellIntegration
        ? "\nShell integration active (OSC 133)."
        : session.shellIntegrationSkipped
          ? `\nWARNING: shell_integration was requested but not applied — ${session.shellIntegrationSkipped}. session_wait_command will not work.`
          : "";
      return ok(
        `Created session "${session_id}" (pid ${session.pty.pid}).${rec}${si}\n${await screenWithHeader(session_id)}`,
      );
    }),
  );

  let execCounter = 0;

  server.registerTool(
    "execute_command",
    {
      annotations: MUTATING,
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
      annotations: READ_ONLY,
      title: "Read terminal screen",
      description:
        "Snapshot the current rendered screen of a session. 'text' returns the plain visual grid " +
        "(spatial layout preserved, ANSI codes stripped); 'raw' includes VT/ANSI sequences for color/style debugging. " +
        "Output that scrolled off-screen (e.g. long build/test logs) is retrievable via scrollback_lines. " +
        "format 'json' returns a structured cell model (per-row runs with fg/bg colors and bold/italic/etc. " +
        "attributes, cursor position, and OSC 8 hyperlink ranges) for reading color/attribute-encoded state.",
      inputSchema: {
        session_id: sessionId,
        format: z.enum(["text", "raw", "json"]).default("text"),
        scrollback_lines: z
          .number()
          .int()
          .min(0)
          .max(SCROLLBACK)
          .default(0)
          .describe(
            "Also include up to this many lines that scrolled off the top of the screen (text/json only)",
          ),
      },
    },
    safe(async ({ session_id, format, scrollback_lines }) => {
      const session = getSession(session_id);
      if (format === "raw") return ok(`${statusHeader(session)}\n${await snapshotRaw(session)}`);
      if (format === "json") return ok(JSON.stringify(await snapshotCells(session, scrollback_lines)));
      return ok(await screenWithHeader(session_id, scrollback_lines));
    }),
  );

  server.registerTool(
    "session_write",
    {
      annotations: MUTATING,
      title: "Write input to terminal",
      description:
        "Send keystrokes to a session: 'input' is written literally, then each entry in 'special_keys' " +
        "(enter, tab, escape, backspace, up/down/left/right, home, end, page_up, page_down, f1-f12, " +
        "ctrl+<key>, alt+<char>, shift+tab, modifier chords like shift+escape, space, delete, insert) is sent " +
        "in order, then 'raw_hex' bytes if given. Keys are held until the app finishes rendering 'input', so a " +
        "trailing Enter always submits the complete text. If 'expect' is given, waits for that regex to appear " +
        "and returns the matching screen (or errors with the final screen on timeout) — a write+wait in one call. " +
        "Set paste:true to deliver 'input' as ONE bracketed paste (multi-line text lands atomically: newlines " +
        "don't submit, REPLs/editors don't auto-indent it) — requires the app to have bracketed paste on. " +
        "Note: submitting a command requires special_keys: ['enter'].",
      inputSchema: {
        session_id: sessionId,
        input: z.string().default("").describe("Literal text to type (no newline appended)"),
        special_keys: z
          .array(z.string())
          .default([])
          .describe("Special keys to send after 'input', in order"),
        paste: z
          .boolean()
          .default(false)
          .describe(
            "Send 'input' wrapped in bracketed-paste markers (one atomic paste; for multi-line text). " +
              "The app must have bracketed paste enabled (session_info shows it)",
          ),
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
    safe(async ({ session_id, input, special_keys, paste, raw_hex, expect, expect_timeout_ms }) => {
      const session = getSession(session_id);
      if (session.exited) {
        return fail(
          `Session "${session_id}" has exited (code ${session.exitCode}); cannot write. Screen is still readable via session_read.`,
        );
      }
      // A paste is literal by declaration — key-name-looking text is intended.
      const mistake = paste ? null : literalKeyMistake(input);
      if (mistake) return fail(mistake);
      if (paste && !bracketedPasteMode(session)) {
        return fail(
          "paste:true, but the app has not enabled bracketed paste mode (DECSET 2004), so the paste markers " +
            "would arrive as stray input. Check session_info; if the app never enables it, send the text as " +
            "plain 'input' instead (newlines will act as Enter).",
        );
      }

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

      await actionPrecondition(session);
      if (input) {
        const writtenAt = Date.now();
        writeToSession(session, paste ? wrapPaste(input) : input);
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
      annotations: READ_ONLY,
      title: "Wait for a session condition",
      description:
        "Block until the session reaches a condition, then return the screen (also returned on timeout, as an " +
        "error). until:'pattern' (default) polls every 50ms for a regex on the plain-text grid — the reliable " +
        "primitive when you know what you're waiting for. 'pattern_gone' waits until the regex STOPS matching " +
        "(spinner/dialog/just-deleted row cleared, without racing the redraw). 'idle' resolves when no output " +
        "bytes arrive for idle_ms; 'stable_screen' when the rendered text is unchanged for idle_ms (better for " +
        "apps that emit bytes without visual change) — both are best-effort and time out on continuously-" +
        "animating UIs. 'exit' resolves when the session's process terminates (e.g. after :q / ctrl+d).",
      inputSchema: {
        session_id: sessionId,
        until: z
          .enum(["pattern", "pattern_gone", "idle", "stable_screen", "exit"])
          .default("pattern")
          .describe("The condition to wait for"),
        pattern: z
          .string()
          .optional()
          .describe(
            "JavaScript regex source, e.g. 'Password:' or '\\\\$\\\\s*$' (required for 'pattern'/'pattern_gone')",
          ),
        idle_ms: z
          .number()
          .int()
          .min(20)
          .max(10000)
          .default(80)
          .describe("Quiet/unchanged period for 'idle'/'stable_screen'"),
        timeout_ms: z.number().int().min(50).max(600000).default(10000),
      },
    },
    safe(async ({ session_id, until, pattern, idle_ms, timeout_ms }) => {
      const session = getSession(session_id);

      if (until === "pattern" || until === "pattern_gone") {
        if (pattern === undefined) {
          return fail(`until:'${until}' needs a 'pattern' regex to watch for.`);
        }
        let regex: RegExp;
        try {
          regex = new RegExp(pattern, "m");
        } catch (err) {
          return fail(`Invalid regex "${pattern}": ${err instanceof Error ? err.message : err}`);
        }
        const result = await waitForPattern(session, regex, timeout_ms, until === "pattern_gone");
        const text = `${result.message}\n${statusHeader(session)}\n${result.screen}`;
        return result.ok ? ok(text) : fail(text);
      }
      if (pattern !== undefined) {
        return fail(`'pattern' is only used with until:'pattern'/'pattern_gone' (got until:'${until}').`);
      }
      if (until === "exit") {
        if (await waitForExit(session, timeout_ms)) {
          // Drain output that raced with process exit before reading.
          await settle(session, SETTLE.drainAfterExit);
          return ok(`Session exited (code ${session.exitCode}).\n${await screenWithHeader(session_id)}`);
        }
        return fail(
          `Process still running after ${timeout_ms}ms. To end it, send a quit keystroke via ` +
            `session_write or terminate with session_kill.\n${await screenWithHeader(session_id)}`,
        );
      }
      const result =
        until === "stable_screen"
          ? await waitForStableScreen(session, idle_ms, timeout_ms)
          : await waitForIdle(session, idle_ms, timeout_ms);
      const text = `${result.message}\n${statusHeader(session)}\n${result.screen}`;
      return result.ok ? ok(text) : fail(text);
    }),
  );

  server.registerTool(
    "session_assert",
    {
      annotations: READ_ONLY,
      title: "Assert screen state",
      description:
        "Deterministic test primitive: run one check against the visible screen. " +
        "check:'contains' (default) — text appears anywhere, or on a specific row if 'row' is given. " +
        "'absent' — text is NOT on screen (anywhere, or not on 'row'), for proving a dialog/row/item is gone. " +
        "'count' — text occurs exactly 'count' times across the screen (list sizes, duplicate checks). " +
        "'at' — text starts exactly at ('row','col'), wide-character aware. " +
        "'matches' — 'text' is a regex the screen must match (optionally scoped to 'row'). " +
        "Set within_ms to make the assertion retry-able: it re-checks every 50ms until it passes or the " +
        "deadline expires — the flake-proof way to assert right after an action, instead of a separate wait. " +
        "Failures include the actual content with context, plus near-miss hints (scrolled off, line-wrapped, " +
        "case/spacing differences).",
      inputSchema: {
        session_id: sessionId,
        check: z
          .enum(["contains", "absent", "count", "at", "matches"])
          .default("contains")
          .describe("The kind of assertion to run"),
        text: z.string().describe("Literal substring to check (regex source for check:'matches')"),
        row: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("0-based visible row: scopes 'contains'/'absent'/'matches'; required for 'at'"),
        col: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("0-based column where the text must start (only for check:'at')"),
        count: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Expected number of occurrences (required for check:'count')"),
        within_ms: z
          .number()
          .int()
          .min(50)
          .max(120000)
          .optional()
          .describe("Retry the check every 50ms until it passes or this deadline (omit: single check)"),
      },
    },
    safe(async ({ session_id, check, text, row, col, count, within_ms }) => {
      const session = getSession(session_id);
      // Reject parameter/check mismatches up front with the fix spelled out —
      // cheaper for the agent than a confusingly-scoped assertion result.
      if (check === "at" && (row === undefined || col === undefined)) {
        return fail("check:'at' needs both 'row' and 'col' (the exact start position of the text).");
      }
      if (check !== "at" && col !== undefined) {
        return fail(`'col' is only used with check:'at' (got check:'${check}').`);
      }
      if (check === "count" && count === undefined) {
        return fail("check:'count' needs the 'count' parameter (expected number of occurrences).");
      }
      if (check !== "count" && count !== undefined) {
        return fail(`'count' is only used with check:'count' (got check:'${check}').`);
      }
      if (check === "count" && row !== undefined) {
        return fail("check:'count' is whole-screen; it cannot be scoped to a row.");
      }
      const result = await assertScreenWithin(
        session,
        text,
        {
          row,
          col,
          absent: check === "absent",
          count: check === "count" ? count : undefined,
          regex: check === "matches",
        },
        within_ms,
      );
      return result.ok ? ok(result.message) : fail(result.message);
    }),
  );

  server.registerTool(
    "session_region",
    {
      annotations: READ_ONLY,
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
    "session_screenshot",
    {
      annotations: READ_ONLY,
      title: "Screenshot the terminal as an image",
      description:
        "Render the current screen (colors, styles, box-drawing, cursor) to a PNG image and return it. " +
        "Use when layout or color-encoded state reads better visually than as text — e.g. for a vision-capable " +
        "model to inspect a dashboard, diff, or full-screen TUI.",
      inputSchema: {
        session_id: sessionId,
        scrollback_lines: z
          .number()
          .int()
          .min(0)
          .max(SCROLLBACK)
          .default(0)
          .describe("Also render this many lines that scrolled off the top of the screen"),
      },
    },
    safe(async ({ session_id, scrollback_lines }) => {
      const session = getSession(session_id);
      const png = renderPng(await snapshotCells(session, scrollback_lines));
      return image(png, `${statusHeader(session)} — ${png.length} byte PNG`);
    }),
  );

  server.registerTool(
    "session_batch",
    {
      annotations: MUTATING,
      title: "Run a step sequence on a live session",
      description:
        "Execute a short write→wait→assert sequence against an EXISTING session in ONE call — the same step " +
        "grammar as run_test, so working steps can be pasted straight into a regression test. Steps run in " +
        "order; execution stops at the first failing step (assertion steps may set soft:true to record the " +
        "failure and continue). Returns a per-step report plus the final screen — far fewer round-trips and " +
        "tokens than issuing each step as its own tool call. " +
        'Steps: {"write","keys","raw_hex","paste"?} | {"wait":"<regex>","absent"?} | {"idle_ms","mode"?} | ' +
        '{"assert","row"?,"col"?,"absent"?,"count"?,"within_ms"?} | {"resize":[c,r]} | {"sleep_ms"} | ' +
        '{"command_exit"} | {"expect_exit"} | {"match_screen","mask"?}.',
      inputSchema: {
        session_id: sessionId,
        steps: z.array(StepSchema).min(1).max(50).describe("Steps to run, in run_test step format"),
        screens_dir: z
          .string()
          .optional()
          .describe("Directory for golden snapshots (only needed for match_screen steps)"),
      },
    },
    safe(async ({ session_id, steps, screens_dir }) => {
      const session = getSession(session_id);
      const outcome = await executeSteps(session, steps, {
        testName: `batch:${session_id}`,
        options: { screensDir: screens_dir },
      });
      const report = formatResult({
        name: `batch on "${session_id}"`,
        ok: outcome.ok,
        steps: outcome.steps,
        failureScreen: outcome.ok ? undefined : await snapshotText(session),
      });
      // On success the report has no screen; append one so the agent sees the
      // final state without a follow-up read.
      return outcome.ok ? ok(`${report}\n${await screenWithHeader(session_id)}`) : fail(report);
    }),
  );

  server.registerTool(
    "run_test",
    {
      annotations: MUTATING,
      title: "Run deterministic TUI test",
      description:
        "Replay a JSON test script against a fresh PTY session and return pass/fail per step — deterministic, " +
        "no agent in the loop, also runnable in CI via `terminal-driver-mcp run <file>`. Spec: " +
        '{"name", "command", "cwd"?, "cols"?, "rows"?, "auto_wait"?, "steps": [...]} ' +
        "(auto_wait: write steps hold until output quiesces before injecting) where each step is one of " +
        '{"wait": "<regex>", "timeout_ms"?, "absent"?: true} | {"idle_ms": N, "mode"?: "silence"|"stable_screen"} | ' +
        '{"write": "text", "keys": ["enter", ...], "paste"?: true} | ' +
        '{"assert": "text", "row"?: N, "col"?: N, "absent"?: true, "count"?: N, "within_ms"?: N} | ' +
        '{"resize": [cols, rows]} | {"sleep_ms": N} | {"command_exit": code} | ' +
        '{"match_screen": "name", "mask"?: ["<regex>"]} | {"expect_exit": code}. ' +
        'Any step may carry a "group" label (named section in reports/trace); assertion steps ' +
        '(assert/match_screen/command_exit/expect_exit) may set "soft": true to record a failure and keep ' +
        "going instead of stopping. Execution otherwise stops at the first (hard) failing step and includes " +
        "the final screen. match_screen (golden snapshots) needs screens_dir; regenerate with update_snapshots:true.",
      inputSchema: {
        file: z.string().optional().describe("Path to a JSON test file"),
        test_json: z.string().optional().describe("Inline JSON test spec (alternative to file)"),
        screens_dir: z
          .string()
          .optional()
          .describe("Directory for golden screen snapshots (for match_screen steps)"),
        update_snapshots: z
          .boolean()
          .default(false)
          .describe("(Re)write golden snapshots instead of comparing"),
        trace_file: z
          .string()
          .optional()
          .describe("Write a self-contained HTML trace of the run (per-step screens) to this path"),
      },
    },
    safe(async ({ file, test_json, screens_dir, update_snapshots, trace_file }) => {
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
      const result = await runTest(parseTest(json, source), {
        screensDir: screens_dir,
        update: update_snapshots,
        trace: trace_file,
      });
      const report = formatResult(result);
      const traceNote = trace_file && result ? `\nTrace: ${trace_file}` : "";
      return result.ok ? ok(report + traceNote) : fail(report + traceNote);
    }),
  );

  server.registerTool(
    "recording_to_test",
    {
      annotations: MUTATING,
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

  const clickButtonSchema = z.enum(["left", "middle", "right", "wheel_up", "wheel_down"]).default("left");
  const dragButtonSchema = z.enum(["left", "middle", "right"]).default("left");

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
      annotations: MUTATING,
      title: "Click or scroll-wheel in the terminal",
      description:
        "Send a mouse click at a 0-based (row, col) as SGR mouse sequences — for TUIs that enable mouse " +
        "tracking (tree/list clicks, buttons, menus). button: left|middle|right, or wheel_up|wheel_down to " +
        "scroll (lists, pagers); count: 2 for double-click, or the number of wheel ticks. " +
        "Errors if the app has not enabled mouse tracking. Returns the resulting screen.",
      inputSchema: {
        session_id: sessionId,
        row: z.number().int().min(0).describe("0-based row (matches session_read)"),
        col: z.number().int().min(0).describe("0-based column"),
        button: clickButtonSchema,
        count: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(1)
          .describe("Click count (2 = double-click) or wheel ticks"),
      },
    },
    safe(async ({ session_id, row, col, button, count }) => {
      const session = getSession(session_id);
      const blocked = mouseGuard(session);
      if (blocked) return fail(blocked);
      const bytes = button.startsWith("wheel_")
        ? encodeWheel(button as WheelDirection, row, col, count)
        : encodeClick(button as MouseButton, row, col, count);
      await actionPrecondition(session);
      writeToSession(session, bytes);
      await settle(session, SETTLE.afterWrite);
      return ok(await screenWithHeader(session_id));
    }),
  );

  server.registerTool(
    "session_drag",
    {
      annotations: MUTATING,
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
        button: dragButtonSchema,
      },
    },
    safe(async ({ session_id, from_row, from_col, to_row, to_col, button }) => {
      const session = getSession(session_id);
      const blocked = mouseGuard(session);
      if (blocked) return fail(blocked);
      await actionPrecondition(session);
      writeToSession(session, encodeDrag(button as MouseButton, from_row, from_col, to_row, to_col));
      await settle(session, SETTLE.afterWrite);
      return ok(await screenWithHeader(session_id));
    }),
  );

  server.registerTool(
    "session_info",
    {
      annotations: READ_ONLY,
      title: "Inspect session state",
      description:
        "Report what the running app has configured: raw/mode flags (bracketed paste, mouse tracking, " +
        "application cursor/keypad, insert), alternate screen, cursor position, foreground process, and dims. " +
        "Use this to understand why input behaves unexpectedly without reverse-engineering it.",
      inputSchema: { session_id: sessionId },
      outputSchema: {
        id: z.string(),
        pid: z.number().int(),
        command: z.string(),
        foregroundProcess: z.string(),
        cols: z.number().int(),
        rows: z.number().int(),
        status: z.string(),
        ageSeconds: z.number(),
        cursor: z.object({ row: z.number().int(), col: z.number().int() }),
        altScreen: z.boolean(),
        modes: z.object({
          applicationCursorKeys: z.boolean(),
          applicationKeypad: z.boolean(),
          bracketedPaste: z.boolean(),
          insert: z.boolean(),
          mouseTracking: z.string(),
          sendFocus: z.boolean(),
          originMode: z.boolean(),
          synchronizedOutput: z.boolean(),
          wraparound: z.boolean(),
        }),
      },
    },
    safe(async ({ session_id }) => {
      // Flush pending output so mode flags reflect the latest escape sequences.
      await snapshotText(getSession(session_id));
      return okStructured({ ...sessionInfo(getSession(session_id)) });
    }),
  );

  // Only nudge toward shell_integration when nothing has been captured; if an
  // app emits OSC 133 on its own, the records exist without our injection.
  const noCommandsHint = (session: ReturnType<typeof getSession>): string =>
    session.shellIntegration || session.commands.length > 0
      ? "No command has completed yet in this session."
      : "No OSC 133 command boundaries seen. Create the session with shell_integration:true (interactive bash/zsh).";

  const commandResult = (session: ReturnType<typeof getSession>): ToolResult => {
    const last = session.commands[session.commands.length - 1];
    return okStructured({
      command: last.command,
      exit_code: last.exitCode,
      duration_ms: last.durationMs,
      output: last.output,
    });
  };

  server.registerTool(
    "session_wait_command",
    {
      annotations: READ_ONLY,
      title: "Get the current/last shell command's result",
      description:
        "The reliable way to check a shell command: waits for the in-flight command to complete (OSC 133), " +
        "then returns its exact output, exit code, and duration — just that command's output, not the whole " +
        "screen, so it is also the token-cheap option. If the shell is already idle at a prompt, returns the " +
        "most recent completed command immediately. Requires a session created with shell_integration:true.",
      inputSchema: {
        session_id: sessionId,
        timeout_ms: z.number().int().min(50).max(600000).default(30000),
      },
      outputSchema: {
        command: z.string().describe("The command line as typed at the prompt"),
        exit_code: z.number().int().nullable().describe("Exit code (null if the shell did not report one)"),
        duration_ms: z.number().describe("Wall-clock runtime"),
        output: z.string().describe("The command's output only (no prompt, no screen)"),
      },
    },
    safe(async ({ session_id, timeout_ms }) => {
      const session = getSession(session_id);
      await snapshotText(session); // flush to let a pending C/D marker land
      // Fail fast instead of burning the whole timeout when this session can
      // never produce a command record.
      if (!session.shellIntegration && session.commands.length === 0 && !commandIsRunning(session)) {
        return fail(noCommandsHint(session));
      }
      // Stale-result guard: a command completing AFTER this call starts is
      // always fresh; returning the pre-existing latest is only safe once a
      // short grace window has passed without a start (C) marker appearing —
      // otherwise "write cmd, call wait" can race the marker and return the
      // PREVIOUS command's result as if it were the new one.
      const entryCount = session.commands.length;
      const GRACE_MS = Math.min(600, timeout_ms);
      const start = Date.now();
      for (;;) {
        await snapshotText(session); // flush to let a pending C/D marker land
        if (session.commands.length > entryCount) return commandResult(session);
        const running = commandIsRunning(session);
        const elapsed = Date.now() - start;
        if (!running) {
          if (session.exited) {
            // No new command can ever start; return what exists, or fail now.
            if (entryCount > 0) return commandResult(session);
            return fail(
              `Session exited (code ${session.exitCode}) without completing a command.\n${await screenWithHeader(session_id)}`,
            );
          }
          if (elapsed >= GRACE_MS && entryCount > 0) return commandResult(session);
        }
        if (elapsed >= timeout_ms) {
          const hint = session.commands.length === 0 ? `${noCommandsHint(session)}\n` : "";
          return fail(
            `No command completed within ${timeout_ms}ms.\n${hint}${await screenWithHeader(session_id)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }),
  );

  server.registerTool(
    "session_resize",
    {
      annotations: MUTATING,
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
      annotations: READ_ONLY,
      title: "List terminal sessions",
      description: "List all sessions with pid, command, dimensions, status, and age.",
      inputSchema: {},
      outputSchema: {
        sessions: z.array(
          z.object({
            id: z.string(),
            pid: z.number().int(),
            command: z.string(),
            cols: z.number().int(),
            rows: z.number().int(),
            status: z.string(),
            ageSeconds: z.number().int(),
          }),
        ),
      },
    },
    safe(async () => {
      const sessions = listSessions().map((s) => ({
        id: s.id,
        pid: s.pty.pid,
        command: s.command,
        cols: s.term.cols,
        rows: s.term.rows,
        status: s.exited ? `exited(${s.exitCode})` : "running",
        ageSeconds: Math.round((Date.now() - s.createdAt) / 1000),
      }));
      const text =
        sessions.length === 0
          ? "No active sessions."
          : sessions
              .map(
                (s) =>
                  `${s.id}  pid=${s.pid}  ${s.cols}x${s.rows}  ${s.status}  ${s.ageSeconds}s  ${s.command}`,
              )
              .join("\n");
      return okStructured({ sessions }, text);
    }),
  );

  server.registerTool(
    "session_kill",
    {
      annotations: DESTRUCTIVE,
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
