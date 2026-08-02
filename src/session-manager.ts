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
import { shellIntegrationSnippet } from "./shell-integration.js";

const { Terminal } = xterm;
type Terminal = InstanceType<typeof xterm.Terminal>;

export interface LinkRecord {
  url: string;
  startRow: number; // absolute buffer row (baseY + cursorY at the time)
  startCol: number;
  endRow: number;
  endCol: number;
}

export interface CommandRecord {
  command: string;
  exitCode: number | null;
  output: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
}

// xterm marker: tracks a buffer line across scrolling, disposes on eviction.
interface Marker {
  readonly line: number;
  readonly isDisposed: boolean;
  dispose(): void;
}

// In-progress command being assembled from OSC 133 markers.
interface ActiveCommand {
  bMarker?: Marker;
  bCol: number;
  cMarker?: Marker;
  startedAt: number;
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
  links: LinkRecord[];
  commands: CommandRecord[];
  activeCommand?: ActiveCommand;
  shellIntegration: boolean;
  /** Why shell integration was requested but not applied (for an up-front warning). */
  shellIntegrationSkipped?: string;
  /** Resolves once shell-integration hooks are injected and the shell is ready. */
  integrationReady?: Promise<void>;
  /** When the app opened the current synchronized-output frame (DECSET 2026), for stale-frame expiry. */
  syncOpenedAt?: number;
  /** Opt-in actionability: input-injecting tools wait for output to quiesce before sending. */
  autoWait: boolean;
}

const MAX_LINKS = 200;
const MAX_COMMANDS = 100;

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
      }`,
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
  /** Inject OSC 133 shell integration (interactive shell sessions only). */
  shellIntegration?: boolean;
  /** Opt-in actionability: wait for quiet output before each input injection. */
  autoWait?: boolean;
}

export function createSession(options: CreateSessionOptions): TerminalSession {
  const { id, command, cols, rows, cwd, record = true, shellIntegration = false, autoWait = false } = options;

  if (sessions.has(id)) {
    throw new Error(`Session "${id}" already exists. Use session_kill first or pick another id.`);
  }
  if (sessions.size >= MAX_SESSIONS) {
    throw new Error(
      `Session limit (${MAX_SESSIONS}) reached. Use session_list to inspect and session_kill to free one.`,
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
    links: [],
    commands: [],
    shellIntegration: false,
    autoWait,
  };
  if (record) {
    session.recording = Recording.open(id, session.command, cols, rows);
  }

  registerParserHandlers(session);

  ptyProcess.onData((data) => {
    session.lastDataAt = Date.now();
    // Contain any parser hiccup to this chunk: a single odd byte sequence must
    // not throw out of the async callback and risk taking the server down.
    try {
      term.write(data);
    } catch (err) {
      console.error(`[terminal-driver-mcp] emulator write error in session "${id}":`, err);
    }
    session.recording?.event("o", data);
  });

  // The emulator generates responses to terminal queries (DA1, DSR cursor
  // reports, ...) on its onData event; forward them to the application like a
  // real terminal would, or query-happy TUIs hang waiting for an answer.
  term.onData((response) => {
    if (session.exited) return;
    try {
      ptyProcess.write(response);
    } catch {
      /* pty already closed */
    }
    session.recording?.event("q", response);
  });

  ptyProcess.onExit(({ exitCode }) => {
    session.exited = true;
    session.exitCode = exitCode;
    session.lastDataAt = Date.now();
    session.recording?.close();
  });

  // OSC 133 shell integration: inject hooks into an interactive shell so it
  // emits prompt/command/exit markers. Only for interactive shell sessions
  // (no command) running a supported shell; note why it was skipped otherwise
  // so session_create can warn up front instead of failing later.
  if (shellIntegration) {
    const snippet = command ? undefined : shellIntegrationSnippet(shell);
    if (command) {
      session.shellIntegrationSkipped = "it applies only to interactive shell sessions (omit 'command')";
    } else if (!snippet) {
      session.shellIntegrationSkipped = `the shell '${shell}' is unsupported (bash or zsh only)`;
    } else {
      session.shellIntegration = true;
      // ` ` prefix keeps it out of history (ignorespace); `clear` hides it.
      // Injected only once the shell has drawn its first prompt — writing at
      // spawn time races the shell's own startup and gets lost/overridden.
      // Awaitable via integrationReady so callers can wait before sending input.
      session.integrationReady = injectWhenIdle(session, ` ${snippet}\r clear\r`);
    }
  }

  sessions.set(id, session);
  return session;
}

async function injectWhenIdle(session: TerminalSession, data: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!session.exited && Date.now() - session.lastDataAt >= 150) break; // prompt settled
    await new Promise((r) => setTimeout(r, 50));
  }
  if (session.exited) return;
  session.pty.write(data);
  // Let the snippet run and the shell redraw a fresh prompt before returning.
  const settleBy = Date.now() + 2000;
  while (Date.now() < settleBy) {
    if (Date.now() - session.lastDataAt >= 150) break;
    await new Promise((r) => setTimeout(r, 50));
  }
}

// Parser handlers run in-stream during parsing, so the emulator cursor
// reflects the position where the sequence appeared — which is what we record.
// Exported for unit tests that build sessions without a PTY.
export function registerParserHandlers(session: TerminalSession): void {
  const { term } = session;
  let pendingLink: { url: string; startRow: number; startCol: number } | null = null;

  // DECSET/DECRST 2026 (synchronized output): xterm tracks the mode itself
  // (term.modes.synchronizedOutputMode); we only stamp when the frame opened
  // so snapshot gating can expire a frame an app left open. Returning false
  // lets xterm's own handling proceed.
  term.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
    if (params.includes(2026)) session.syncOpenedAt = Date.now();
    return false;
  });
  term.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
    if (params.includes(2026)) session.syncOpenedAt = undefined;
    return false;
  });

  // OSC 8 ; params ; URI  — opens a hyperlink; OSC 8 ; ;  closes it.
  term.parser.registerOscHandler(8, (data: string) => {
    const buf = term.buffer.active;
    const uri = data.slice(data.indexOf(";") + 1); // strip params
    if (uri) {
      pendingLink = { url: uri, startRow: buf.baseY + buf.cursorY, startCol: buf.cursorX };
    } else if (pendingLink) {
      session.links.push({
        ...pendingLink,
        endRow: buf.baseY + buf.cursorY,
        endCol: buf.cursorX,
      });
      if (session.links.length > MAX_LINKS) session.links.shift();
      pendingLink = null;
    }
    return false; // let xterm apply its own OSC 8 handling too
  });

  // OSC 133 ; A|B|C|D[;exit]  — semantic command boundaries (FTCS).
  term.parser.registerOscHandler(133, (data: string) => {
    const buf = term.buffer.active;
    const kind = data[0];
    const absLine = () => buf.baseY + buf.cursorY;
    if (kind === "A") {
      // Prompt starting: any half-built command without output is abandoned.
      disposeActive(session.activeCommand);
      session.activeCommand = { bCol: buf.cursorX, startedAt: 0 };
    } else if (kind === "B") {
      if (session.activeCommand) {
        session.activeCommand.bMarker = term.registerMarker(0) ?? undefined;
        session.activeCommand.bCol = buf.cursorX;
      }
    } else if (kind === "C") {
      if (session.activeCommand) {
        session.activeCommand.cMarker = term.registerMarker(0) ?? undefined;
        session.activeCommand.startedAt = Date.now();
      }
    } else if (kind === "D") {
      const active = session.activeCommand;
      if (active?.cMarker && !active.cMarker.isDisposed) {
        const parts = data.split(";");
        const exitCode = parts.length > 1 && parts[1] !== "" ? Number(parts[1]) : null;
        const endedAt = Date.now();
        session.commands.push({
          command: readCommandText(term, active),
          exitCode: Number.isNaN(exitCode as number) ? null : exitCode,
          output: readRows(term, active.cMarker.line, absLine()),
          startedAt: active.startedAt,
          endedAt,
          durationMs: active.startedAt ? endedAt - active.startedAt : 0,
        });
        if (session.commands.length > MAX_COMMANDS) session.commands.shift();
      }
      disposeActive(active);
      session.activeCommand = undefined;
    }
    return true;
  });
}

function disposeActive(active?: ActiveCommand): void {
  active?.bMarker?.dispose();
  active?.cMarker?.dispose();
}

/** True while a shell command is executing (OSC 133 C seen, D not yet). */
export function commandIsRunning(session: TerminalSession): boolean {
  const c = session.activeCommand?.cMarker;
  return !!c && !c.isDisposed;
}

// The typed command: the prompt line from the B column to end (single-line).
function readCommandText(term: Terminal, active: ActiveCommand): string {
  if (!active.bMarker || active.bMarker.isDisposed) return "";
  return term.buffer.active.getLine(active.bMarker.line)?.translateToString(true, active.bCol).trim() ?? "";
}

// Rows [start, end) as trimmed plain text (a command's output between C and D).
function readRows(term: Terminal, start: number, end: number): string {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let y = Math.max(0, start); y < end; y++) {
    lines.push(buf.getLine(y)?.translateToString(true) ?? "");
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
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

interface TerminalModes {
  applicationCursorKeysMode?: boolean;
  applicationKeypadMode?: boolean;
  bracketedPasteMode?: boolean;
  insertMode?: boolean;
  mouseTrackingMode?: "none" | "x10" | "vt200" | "drag" | "any";
  originMode?: boolean;
  reverseWraparoundMode?: boolean;
  sendFocusMode?: boolean;
  synchronizedOutputMode?: boolean;
  wraparoundMode?: boolean;
}

function modes(session: TerminalSession): TerminalModes {
  return (session.term as { modes?: TerminalModes }).modes ?? {};
}

/** True when the app has enabled DECCKM (application cursor keys). */
export function appCursorMode(session: TerminalSession): boolean {
  return modes(session).applicationCursorKeysMode ?? false;
}

/** The app's mouse tracking mode; "none" means it is not listening for mouse events. */
export function mouseTrackingMode(session: TerminalSession): string {
  return modes(session).mouseTrackingMode ?? "none";
}

/** True when the app has enabled bracketed paste mode (DECSET 2004). */
export function bracketedPasteMode(session: TerminalSession): boolean {
  return modes(session).bracketedPasteMode ?? false;
}

/** True while the app holds a synchronized-output frame open (DECSET 2026). */
export function syncFrameOpen(session: TerminalSession): boolean {
  return modes(session).synchronizedOutputMode ?? false;
}

/** Wrap text in bracketed-paste markers so the app receives it as one atomic paste. */
export function wrapPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}

export interface SessionInfo {
  id: string;
  pid: number;
  command: string;
  foregroundProcess: string;
  cols: number;
  rows: number;
  status: string;
  ageSeconds: number;
  cursor: { row: number; col: number };
  altScreen: boolean;
  modes: {
    applicationCursorKeys: boolean;
    applicationKeypad: boolean;
    bracketedPaste: boolean;
    insert: boolean;
    mouseTracking: string;
    sendFocus: boolean;
    originMode: boolean;
    synchronizedOutput: boolean;
    wraparound: boolean;
  };
}

/** Snapshot of what the running app has configured — for debugging behavior. */
export function sessionInfo(session: TerminalSession): SessionInfo {
  const m = modes(session);
  const buf = session.term.buffer.active;
  return {
    id: session.id,
    pid: session.pty.pid,
    command: session.command,
    // node-pty tracks the current foreground process name (empty on some platforms).
    foregroundProcess: session.pty.process ?? "",
    cols: session.term.cols,
    rows: session.term.rows,
    status: session.exited ? `exited(${session.exitCode})` : "running",
    ageSeconds: Math.round((Date.now() - session.createdAt) / 1000),
    cursor: { row: buf.cursorY, col: buf.cursorX },
    altScreen: buf.type === "alternate",
    modes: {
      applicationCursorKeys: m.applicationCursorKeysMode ?? false,
      applicationKeypad: m.applicationKeypadMode ?? false,
      bracketedPaste: m.bracketedPasteMode ?? false,
      insert: m.insertMode ?? false,
      mouseTracking: m.mouseTrackingMode ?? "none",
      sendFocus: m.sendFocusMode ?? false,
      originMode: m.originMode ?? false,
      synchronizedOutput: m.synchronizedOutputMode ?? false,
      wraparound: m.wraparoundMode ?? true,
    },
  };
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
