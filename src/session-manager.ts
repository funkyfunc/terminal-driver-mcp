/**
 * Session registry and lifecycle: each session pairs a live PTY (node-pty)
 * with a headless xterm emulator that mirrors the screen state. Sessions
 * persist across MCP tool calls; the emulator buffer stays readable after the
 * child exits until the session is explicitly killed.
 */
import { statSync } from "node:fs";
import { SerializeAddon } from "@xterm/addon-serialize";
import xterm from "@xterm/headless";
import * as pty from "node-pty";
import { Recording } from "./recording.js";

const { Terminal } = xterm;
type Terminal = InstanceType<typeof xterm.Terminal>;

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

export interface CreateSessionOptions {
  id: string;
  /** Command run via the user's shell; omit for an interactive login shell. */
  command?: string;
  cols: number;
  rows: number;
  /** Working directory; defaults to the server's cwd. */
  cwd?: string;
  /** Write an asciicast recording of the session. Defaults to true. */
  record?: boolean;
}

export function createSession(options: CreateSessionOptions): TerminalSession {
  const { id, command, cols, rows, cwd, record = true } = options;

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
    session.recording = Recording.open(id, session.command, cols, rows);
  }

  ptyProcess.onData((data) => {
    session.lastDataAt = Date.now();
    term.write(data);
    session.recording?.event("o", data);
  });

  ptyProcess.onExit(({ exitCode }) => {
    session.exited = true;
    session.exitCode = exitCode;
    session.lastDataAt = Date.now();
    session.recording?.close();
  });

  sessions.set(id, session);
  return session;
}

/** Write agent input to the PTY, mirroring it into the recording. */
export function writeToSession(session: TerminalSession, data: string): void {
  session.pty.write(data);
  session.recording?.event("i", data);
}

/** Resize PTY first (SIGWINCH), then the emulator, and note it in the recording. */
export function resizeSession(session: TerminalSession, cols: number, rows: number): void {
  session.pty.resize(cols, rows);
  session.term.resize(cols, rows);
  session.recording?.event("r", `${cols}x${rows}`);
}

/** True when the app has enabled DECCKM (application cursor keys). */
export function appCursorMode(session: TerminalSession): boolean {
  const modes = (session.term as { modes?: { applicationCursorKeysMode?: boolean } }).modes;
  return modes?.applicationCursorKeysMode ?? false;
}

export interface KillResult {
  pid: number;
  recordingPath?: string;
}

export async function killSession(id: string): Promise<KillResult> {
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
  session.recording?.close();
  session.term.dispose();
  return { pid: session.pty.pid, recordingPath: session.recording?.path };
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
    session.recording?.close();
  }
  sessions.clear();
}
