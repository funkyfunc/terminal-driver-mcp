/**
 * Reading and formatting the emulator's screen state: snapshots, transcripts,
 * regions, cursor position, assertions, and the status header shown to agents.
 */
import { SCROLLBACK, type TerminalSession } from "./session-manager.js";

/** Wait until the emulator has parsed everything written to it so far. */
async function flush(session: TerminalSession): Promise<void> {
  await new Promise<void>((resolve) => session.term.write("", resolve));
}

/** Buffer rows [startY, endY) as right-trimmed plain text, after a flush. */
async function bufferLines(session: TerminalSession, startY: number, endY: number): Promise<string[]> {
  await flush(session);
  const buf = session.term.buffer.active;
  const lines: string[] = [];
  for (let y = startY; y < endY; y++) {
    lines.push(buf.getLine(y)?.translateToString(true) ?? "");
  }
  return lines;
}

/**
 * Plain-text grid of the visible screen, one line per row, optionally
 * preceded by up to `scrollbackLines` lines that have scrolled off-screen.
 */
export async function snapshotText(session: TerminalSession, scrollbackLines = 0): Promise<string> {
  const buf = session.term.buffer.active;
  const startY = Math.max(0, buf.baseY - scrollbackLines);
  const lines = await bufferLines(session, startY, buf.baseY + session.term.rows);
  return lines.join("\n");
}

/**
 * Everything the session has produced: full scrollback plus visible screen,
 * with trailing blank rows trimmed. Used by execute_command.
 */
export async function fullTranscript(session: TerminalSession): Promise<string> {
  const buf = session.term.buffer.active;
  const lines = await bufferLines(session, 0, buf.baseY + session.term.rows);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const dropped =
    buf.baseY >= SCROLLBACK
      ? `[note: earliest output was dropped beyond the ${SCROLLBACK}-line scrollback]\n`
      : "";
  return dropped + lines.join("\n");
}

/** Screen with VT/ANSI sequences (colors, styles) via the serialize addon. */
export async function snapshotRaw(session: TerminalSession): Promise<string> {
  await flush(session);
  return session.serialize.serialize({ scrollback: 0 });
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

/** Number of lines that have scrolled off the visible screen. */
export function scrolledOffLines(session: TerminalSession): number {
  return session.term.buffer.active.baseY;
}

/** Cursor position, 0-based, relative to the visible screen (row matches session_read output). */
export function cursorPosition(session: TerminalSession): { row: number; col: number } {
  const buf = session.term.buffer.active;
  return { row: buf.cursorY, col: buf.cursorX };
}

/** One-line session summary prefixed to every screen an agent reads. */
export function statusHeader(session: TerminalSession): string {
  const state = session.exited ? `exited(${session.exitCode})` : "running";
  const { row, col } = cursorPosition(session);
  const off = scrolledOffLines(session);
  const scroll = off > 0 ? ` — ${off} lines scrolled off-screen (session_read scrollback_lines to view)` : "";
  return `[session ${session.id} — ${session.term.cols}x${session.term.rows} — ${state} — cursor ${row}:${col}${scroll}]`;
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
      // Rows are right-trimmed, so pad the extracted slice: text expected at a
      // column beyond the row's content correctly compares against spaces.
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
    const listing = hits.map((h) => `  ${h.y}: ${h.line}`).join("\n");
    return {
      ok: true,
      message: `PASS: "${expected}" found on row(s) ${hits.map((h) => h.y).join(", ")}.\n${listing}`,
    };
  }
  return {
    ok: false,
    message: `FAIL: "${expected}" not found on the visible screen.\n${statusHeader(session)}\n${lines.join("\n")}`,
  };
}
