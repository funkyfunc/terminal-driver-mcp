/**
 * Reading and formatting the emulator's screen state: snapshots, transcripts,
 * regions, cursor position, assertions, and the status header shown to agents.
 */
import { SCROLLBACK, type TerminalSession } from "./session-manager.js";

/** Wait until the emulator has parsed everything written to it so far. */
async function flush(session: TerminalSession): Promise<void> {
  await new Promise<void>((resolve) => session.term.write("", resolve));
}

/**
 * Buffer rows [startY, endY) as right-trimmed plain text.
 * Callers must flush() first AND compute startY/endY only after that flush:
 * pending output can scroll the buffer (moving baseY) or switch the active
 * buffer entirely, so a window computed pre-flush describes a stale screen.
 */
function bufferLines(session: TerminalSession, startY: number, endY: number): string[] {
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
  await flush(session);
  const buf = session.term.buffer.active;
  const startY = Math.max(0, buf.baseY - scrollbackLines);
  return bufferLines(session, startY, buf.baseY + session.term.rows).join("\n");
}

/**
 * Everything the session has produced: full scrollback plus visible screen,
 * with trailing blank rows trimmed. Used by execute_command.
 */
export async function fullTranscript(session: TerminalSession): Promise<string> {
  await flush(session);
  const buf = session.term.buffer.active;
  const lines = bufferLines(session, 0, buf.baseY + session.term.rows);
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
  height: number,
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

export type CellColor = string | { palette: number };

export interface CellStyle {
  fg?: CellColor;
  bg?: CellColor;
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strikethrough?: boolean;
}
export interface CellRun extends CellStyle {
  text: string;
}
export interface SnapshotLink {
  url: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}
export interface CellSnapshot {
  cols: number;
  rows: number;
  cursor: { row: number; col: number };
  lines: Array<{ y: number; runs: CellRun[] }>;
  links?: SnapshotLink[];
}

// Minimal structural view of an @xterm/headless buffer cell (avoids a hard
// dependency on the addon's Terminal type, which differs from headless).
interface BufferCell {
  getChars(): string;
  getWidth(): number;
  getFgColor(): number;
  getBgColor(): number;
  isFgRGB(): boolean;
  isBgRGB(): boolean;
  isFgDefault(): boolean;
  isBgDefault(): boolean;
  isBold(): number;
  isItalic(): number;
  isDim(): number;
  isUnderline(): number;
  isInverse(): number;
  isStrikethrough(): number;
}

function colorOf(cell: BufferCell, kind: "fg" | "bg"): CellColor | undefined {
  const isDefault = kind === "fg" ? cell.isFgDefault() : cell.isBgDefault();
  if (isDefault) return undefined;
  const isRGB = kind === "fg" ? cell.isFgRGB() : cell.isBgRGB();
  const value = kind === "fg" ? cell.getFgColor() : cell.getBgColor();
  if (isRGB) return `#${(value & 0xffffff).toString(16).padStart(6, "0")}`;
  return { palette: value }; // 256-color / 16-color palette index
}

function styleOf(cell: BufferCell): CellStyle {
  const style: CellStyle = {};
  const fg = colorOf(cell, "fg");
  const bg = colorOf(cell, "bg");
  if (fg !== undefined) style.fg = fg;
  if (bg !== undefined) style.bg = bg;
  if (cell.isBold()) style.bold = true;
  if (cell.isItalic()) style.italic = true;
  if (cell.isDim()) style.dim = true;
  if (cell.isUnderline()) style.underline = true;
  if (cell.isInverse()) style.inverse = true;
  if (cell.isStrikethrough()) style.strikethrough = true;
  return style;
}

/**
 * Structured view of the visible screen: per-row runs of styled text (adjacent
 * same-style cells coalesced), plus cursor and any tracked OSC 8 hyperlinks.
 * Lets an agent read color/attribute-encoded state that plain text discards.
 */
export async function snapshotCells(session: TerminalSession, scrollbackLines = 0): Promise<CellSnapshot> {
  await flush(session);
  const term = session.term;
  const buf = term.buffer.active;
  const startY = Math.max(0, buf.baseY - scrollbackLines);
  const endY = buf.baseY + term.rows;

  const lines: CellSnapshot["lines"] = [];
  for (let y = startY; y < endY; y++) {
    const line = buf.getLine(y);
    const runs: CellRun[] = [];
    let current: CellRun | null = null;
    let currentKey = "";
    if (line) {
      for (let x = 0; x < term.cols; x++) {
        const cell = line.getCell(x) as unknown as BufferCell | undefined;
        if (!cell) break;
        if (cell.getWidth() === 0) continue; // trailing cell of a wide char
        const chars = cell.getChars() || " ";
        const style = styleOf(cell);
        const key = JSON.stringify(style);
        if (current && key === currentKey) {
          current.text += chars;
        } else {
          current = { text: chars, ...style };
          currentKey = key;
          runs.push(current);
        }
      }
    }
    // Right-trim trailing whitespace from an unstyled final run (a styled run,
    // e.g. a colored background block, is meaningful and kept).
    const last = runs[runs.length - 1];
    if (last && Object.keys(last).length === 1) {
      last.text = last.text.replace(/\s+$/, "");
      if (last.text === "") runs.pop();
    }
    lines.push({ y: y - buf.baseY, runs });
  }

  const snapshot: CellSnapshot = {
    cols: term.cols,
    rows: term.rows,
    cursor: { row: buf.cursorY, col: buf.cursorX },
    lines,
  };
  const links = visibleLinks(session, buf.baseY, endY);
  if (links.length > 0) snapshot.links = links;
  return snapshot;
}

// OSC 8 hyperlinks tracked on the session (absolute buffer rows), projected to
// screen-relative rows and filtered to the visible window.
function visibleLinks(session: TerminalSession, baseY: number, endY: number): SnapshotLink[] {
  const links = session.links ?? [];
  return links
    .filter((l) => l.endRow >= baseY && l.startRow < endY)
    .map((l) => ({
      url: l.url,
      startRow: l.startRow - baseY,
      startCol: l.startCol,
      endRow: l.endRow - baseY,
      endCol: l.endCol,
    }));
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
  col?: number,
): Promise<AssertResult> {
  await flush(session);
  const lines = (await snapshotText(session)).split("\n");

  if (col !== undefined && row === undefined) {
    return { ok: false, message: "FAIL: exact_col requires exact_row." };
  }

  if (row !== undefined) {
    if (row >= lines.length) {
      return {
        ok: false,
        message: `FAIL: row ${row} is outside the visible screen (0-${lines.length - 1}).`,
      };
    }
    const actual = lines[row];

    if (col !== undefined) {
      // Column-accurate extraction: translateToString indexes by terminal
      // column, so a wide char (CJK/emoji) left of `col` shifts the position
      // correctly — plain string slicing would be off by one per wide cell.
      const buf = session.term.buffer.active;
      const fromCol = buf.getLine(buf.baseY + row)?.translateToString(false, col) ?? "";
      const at = fromCol.slice(0, expected.length).padEnd(expected.length);
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
