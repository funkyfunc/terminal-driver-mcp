/**
 * Session registry: each session pairs a live PTY (node-pty) with a headless
 * xterm emulator that mirrors the screen state. Sessions persist across MCP
 * tool calls; the emulator buffer stays readable after the child exits until
 * the session is explicitly killed.
 */
import { closeSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as pty from "node-pty";
import xterm from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";

const { Terminal } = xterm;
type Terminal = InstanceType<typeof xterm.Terminal>;

interface Recording {
  fd: number;
  path: string;
  startedAt: number;
  closed: boolean;
}

export interface TerminalSession {
  id: string;
  pty: pty.IPty;
  term: Terminal;
  serialize: SerializeAddon;
  lastDataAt: number;
  exited: boolean;
  exitCode: number | null;
  command: string;
  createdAt: number;
  recording?: Recording;
}

export const RECORDING_DIR =
  process.env.TERMINAL_DRIVER_MCP_RECORDING_DIR ?? join(homedir(), ".terminal-driver-mcp", "recordings");

/** Append one asciicast v2 event line; recording is best-effort, never throws. */
function recordEvent(session: TerminalSession, type: "o" | "i" | "r", data: string): void {
  const rec = session.recording;
  if (!rec || rec.closed) return;
  try {
    const elapsed = (Date.now() - rec.startedAt) / 1000;
    writeSync(rec.fd, JSON.stringify([elapsed, type, data]) + "\n");
  } catch {
    rec.closed = true;
  }
}

function closeRecording(session: TerminalSession): void {
  const rec = session.recording;
  if (!rec || rec.closed) return;
  rec.closed = true;
  try {
    closeSync(rec.fd);
  } catch {
    /* already closed */
  }
}

export const MAX_SESSIONS = 16;
export const SCROLLBACK = 1000;

const sessions = new Map<string, TerminalSession>();

export function getSession(id: string): TerminalSession {
  const session = sessions.get(id);
  if (!session) {
    const known = [...sessions.keys()];
    throw new Error(
      `No session "${id}". ${
        known.length
          ? `Active sessions: ${known.join(", ")}`
          : "No active sessions — use session_create first."
      }`
    );
  }
  return session;
}

export function listSessions(): TerminalSession[] {
  return [...sessions.values()];
}

export function createSession(
  id: string,
  command: string | undefined,
  cols: number,
  rows: number,
  cwd?: string,
  record = true
): TerminalSession {
  if (sessions.has(id)) {
    throw new Error(`Session "${id}" already exists. Use session_kill first or pick another id.`);
  }
  if (sessions.size >= MAX_SESSIONS) {
    throw new Error(
      `Session limit (${MAX_SESSIONS}) reached. Use session_list to inspect and session_kill to free one.`
    );
  }

  if (cwd !== undefined) {
    // A bad cwd makes posix_spawn fail with an unhelpful error; check upfront.
    try {
      if (!statSync(cwd).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new Error(`cwd "${cwd}" is not an existing directory.`);
    }
  }

  const shell = process.env.SHELL ?? "/bin/zsh";
  // Run commands through the user's shell so PATH, aliases, and pipelines work;
  // with no command, provide an interactive login shell.
  const args = command ? ["-lc", command] : ["-il"];

  const ptyProcess = pty.spawn(shell, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: cwd ?? process.cwd(),
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" } as {
      [key: string]: string;
    },
  });

  const term = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
  const serialize = new SerializeAddon();
  // SerializeAddon is typed against @xterm/xterm but is buffer-only; safe with headless.
  term.loadAddon(serialize as never);

  const session: TerminalSession = {
    id,
    pty: ptyProcess,
    term,
    serialize,
    lastDataAt: Date.now(),
    exited: false,
    exitCode: null,
    command: command ?? shell,
    createdAt: Date.now(),
  };

  if (record) {
    // Best-effort: a session must never fail because its recording can't be written.
    try {
      mkdirSync(RECORDING_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const path = join(RECORDING_DIR, `${id}-${stamp}.cast`);
      const fd = openSync(path, "w");
      const header = {
        version: 2,
        width: cols,
        height: rows,
        timestamp: Math.floor(Date.now() / 1000),
        title: session.command,
      };
      writeSync(fd, JSON.stringify(header) + "\n");
      session.recording = { fd, path, startedAt: Date.now(), closed: false };
    } catch {
      /* no recording */
    }
  }

  ptyProcess.onData((data) => {
    session.lastDataAt = Date.now();
    term.write(data);
    recordEvent(session, "o", data);
  });

  ptyProcess.onExit(({ exitCode }) => {
    session.exited = true;
    session.exitCode = exitCode;
    session.lastDataAt = Date.now();
    closeRecording(session);
  });

  sessions.set(id, session);
  return session;
}

/** Write agent input to the PTY, mirroring it into the recording. */
export function writeToSession(session: TerminalSession, data: string): void {
  session.pty.write(data);
  recordEvent(session, "i", data);
}

/** Resize PTY first (SIGWINCH), then the emulator, and note it in the recording. */
export function resizeSession(session: TerminalSession, cols: number, rows: number): void {
  session.pty.resize(cols, rows);
  session.term.resize(cols, rows);
  recordEvent(session, "r", `${cols}x${rows}`);
}

/** Wait until the emulator has parsed everything written to it so far. */
async function flush(session: TerminalSession): Promise<void> {
  await new Promise<void>((resolve) => session.term.write("", resolve));
}

/**
 * Plain-text grid of the visible screen, one line per row, optionally
 * preceded by up to `scrollbackLines` lines that have scrolled off-screen.
 */
export async function snapshotText(
  session: TerminalSession,
  scrollbackLines = 0
): Promise<string> {
  await flush(session);
  const buf = session.term.buffer.active;
  const startY = Math.max(0, buf.baseY - scrollbackLines);
  const lines: string[] = [];
  for (let y = startY; y < buf.baseY + session.term.rows; y++) {
    lines.push(buf.getLine(y)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

/**
 * Everything the session has produced: full scrollback plus visible screen,
 * with trailing blank rows trimmed. Used by execute_command.
 */
export async function fullTranscript(session: TerminalSession): Promise<string> {
  await flush(session);
  const buf = session.term.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < buf.baseY + session.term.rows; y++) {
    lines.push(buf.getLine(y)?.translateToString(true) ?? "");
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const dropped =
    buf.baseY >= SCROLLBACK
      ? `[note: earliest output was dropped beyond the ${SCROLLBACK}-line scrollback]\n`
      : "";
  return dropped + lines.join("\n");
}

/** Number of lines that have scrolled off the visible screen. */
export function scrolledOffLines(session: TerminalSession): number {
  return session.term.buffer.active.baseY;
}

/** Cursor position, 0-based, relative to the visible screen (row matches session_read output). */
export function cursorPosition(session: TerminalSession): { row: number; col: number } {
  const buf = session.term.buffer.active;
  return { row: buf.cursorY, col: buf.cursorX };
}

/** Rectangular region of the visible screen, padded to exact width. */
export async function snapshotRegion(
  session: TerminalSession,
  row: number,
  col: number,
  width: number,
  height: number
): Promise<string> {
  await flush(session);
  const buf = session.term.buffer.active;
  const lines: string[] = [];
  for (let y = row; y < Math.min(row + height, session.term.rows); y++) {
    const text = buf.getLine(buf.baseY + y)?.translateToString(false, col, col + width) ?? "";
    lines.push(text.padEnd(width));
  }
  return lines.join("\n");
}

export interface AssertResult {
  ok: boolean;
  message: string;
}

/**
 * Check that expected appears on the visible screen: anywhere, on a specific
 * row, or starting at an exact row+column. Failure messages include context.
 */
export async function assertScreen(
  session: TerminalSession,
  expected: string,
  row?: number,
  col?: number
): Promise<AssertResult> {
  const lines = (await snapshotText(session)).split("\n");

  if (col !== undefined && row === undefined) {
    return { ok: false, message: "FAIL: exact_col requires exact_row." };
  }

  if (row !== undefined) {
    if (row >= lines.length) {
      return { ok: false, message: `FAIL: row ${row} is outside the visible screen (0-${lines.length - 1}).` };
    }
    const actual = lines[row];

    if (col !== undefined) {
      const at = actual.slice(col, col + expected.length).padEnd(expected.length);
      if (at === expected) {
        return { ok: true, message: `PASS: row ${row}, col ${col} is "${expected}".` };
      }
      return {
        ok: false,
        message: `FAIL: row ${row}, col ${col}.\nExpected: "${expected}"\nActual:   "${at}"\nFull row ${row}: ${actual}`,
      };
    }

    if (actual.includes(expected)) {
      return { ok: true, message: `PASS: row ${row} contains "${expected}".\n  ${row}: ${actual}` };
    }
    const context = lines
      .map((line, y) => `  ${y}: ${line}`)
      .slice(Math.max(0, row - 2), row + 3)
      .join("\n");
    return {
      ok: false,
      message: `FAIL: row ${row} does not contain "${expected}".\nExpected: ${expected}\nActual row ${row}: ${actual}\nContext:\n${context}`,
    };
  }

  const hits = lines.map((line, y) => ({ line, y })).filter(({ line }) => line.includes(expected));
  if (hits.length > 0) {
    return {
      ok: true,
      message: `PASS: "${expected}" found on row(s) ${hits.map((h) => h.y).join(", ")}.\n${hits
        .map((h) => `  ${h.y}: ${h.line}`)
        .join("\n")}`,
    };
  }
  return {
    ok: false,
    message: `FAIL: "${expected}" not found on the visible screen.\n${statusHeader(session)}\n${lines.join("\n")}`,
  };
}

/** Screen with VT/ANSI sequences (colors, styles) via the serialize addon. */
export async function snapshotRaw(session: TerminalSession): Promise<string> {
  await flush(session);
  return session.serialize.serialize({ scrollback: 0 });
}

export function statusHeader(session: TerminalSession): string {
  const state = session.exited ? `exited(${session.exitCode})` : "running";
  const { row, col } = cursorPosition(session);
  const off = scrolledOffLines(session);
  const scroll =
    off > 0 ? ` — ${off} lines scrolled off-screen (session_read scrollback_lines to view)` : "";
  return `[session ${session.id} — ${session.term.cols}x${session.term.rows} — ${state} — cursor ${row}:${col}${scroll}]`;
}

/** True when the app has enabled DECCKM (application cursor keys). */
export function appCursorMode(session: TerminalSession): boolean {
  const modes = (session.term as { modes?: { applicationCursorKeysMode?: boolean } }).modes;
  return modes?.applicationCursorKeysMode ?? false;
}

export async function killSession(id: string): Promise<string> {
  const session = getSession(id);
  sessions.delete(id);

  if (!session.exited) {
    try {
      session.pty.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    // Escalate to SIGKILL if the process ignores SIGTERM.
    await new Promise((r) => setTimeout(r, 500));
    if (!session.exited) {
      try {
        session.pty.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
  closeRecording(session);
  session.term.dispose();
  const rec = session.recording ? ` Recording: ${session.recording.path}` : "";
  return `Session "${id}" killed (pid ${session.pty.pid}).${rec}`;
}

/** Synchronous hard-kill sweep — safe to call from process.on("exit"). */
export function killAll(): void {
  for (const session of sessions.values()) {
    if (!session.exited) {
      try {
        session.pty.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    closeRecording(session);
  }
  sessions.clear();
}
