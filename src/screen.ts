/**
 * Reading and formatting the emulator's screen state: snapshots, transcripts,
 * regions, cursor position, assertions, and the status header shown to agents.
 */
import { SCROLLBACK, syncFrameOpen, type TerminalSession } from "./session-manager.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Synchronized-output (DECSET 2026) frame atomicity: while the app holds a
// frame open, the buffer is mid-repaint by declaration, so snapshots hold
// until the frame commits. waitCapMs bounds the hold (real frames close in
// milliseconds); staleMs expires a frame an app opened and never closed
// (crash mid-frame), so reads can never wedge.
const SYNC_FRAME = { waitCapMs: 250, staleMs: 1000 };

/**
 * Wait until the emulator has parsed everything written to it so far — and,
 * if the app is inside a synchronized-output frame, until that frame commits
 * (bounded). Every snapshot path goes through here, so reads, waits, and
 * asserts all observe committed frames from apps that emit DECSET 2026.
 */
async function flush(session: TerminalSession): Promise<void> {
  await new Promise<void>((resolve) => session.term.write("", resolve));
  const deadline = Date.now() + SYNC_FRAME.waitCapMs;
  while (syncFrameOpen(session) && !session.exited && Date.now() < deadline) {
    const openedAt = session.syncOpenedAt;
    if (openedAt !== undefined && Date.now() - openedAt > SYNC_FRAME.staleMs) break;
    await sleep(10);
    // Re-parse pending output each pass so the frame-close can land.
    await new Promise<void>((resolve) => session.term.write("", resolve));
  }
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

/** Modifiers for {@link assertScreen}; all optional and mutually constrained. */
export interface AssertOptions {
  row?: number; // restrict to this 0-based visible row
  col?: number; // require the text to start at this column (needs row)
  absent?: boolean; // invert: pass when the text is NOT present
  count?: number; // require exactly this many occurrences across the screen
  regex?: boolean; // treat `expected` as a regex source instead of a literal substring
}

/**
 * When a presence assertion fails, probe the near-misses an agent can act on:
 * the text scrolled off-screen, spans a soft line wrap, differs only by case,
 * or differs only in whitespace. Returns "" when nothing applies, so failures
 * only pay for a hint that is actually useful.
 */
async function nearMissHint(session: TerminalSession, expected: string, lines: string[]): Promise<string> {
  if (!expected || expected.includes("\n")) return "";
  if ((await snapshotText(session, SCROLLBACK)).includes(expected)) {
    return "\nHint: the text IS in scrollback — it scrolled off-screen; view it with session_read scrollback_lines.";
  }
  if (expected.length > 1 && lines.join("").includes(expected)) {
    return "\nHint: the text spans a line break (wrapped across rows) — assert a shorter fragment that fits on one row.";
  }
  const lower = expected.toLowerCase();
  if (lines.some((line) => line.toLowerCase().includes(lower))) {
    return "\nHint: the text appears with different capitalization — check the case.";
  }
  const squash = (s: string) => s.replace(/\s+/g, " ").trim();
  if (squash(expected).length > 0 && lines.map(squash).join(" ").includes(squash(expected))) {
    return "\nHint: the text appears with different spacing (the terminal pads columns with spaces) — assert a shorter fragment.";
  }
  return "";
}

/**
 * Check that expected appears on the visible screen: anywhere, on a specific
 * row, or starting at an exact row+column. Failure messages include context.
 * With absent=true the sense is inverted — the check passes iff expected is
 * NOT present (anywhere, or not on the given row); exact_col is not meaningful
 * for an absence check and is rejected. With count=N it passes iff expected
 * occurs exactly N times across the screen (count subsumes absent as count=0
 * and is whole-screen only, so row/col/absent are rejected alongside it).
 */
export async function assertScreen(
  session: TerminalSession,
  expected: string,
  opts: AssertOptions = {},
): Promise<AssertResult> {
  const { row, col, absent = false, count, regex = false } = opts;
  await flush(session);
  const lines = (await snapshotText(session)).split("\n");

  let pattern: RegExp | undefined;
  if (regex) {
    if (col !== undefined) {
      return {
        ok: false,
        message: "FAIL: a regex check cannot be pinned to a column; use a literal substring.",
      };
    }
    try {
      pattern = new RegExp(expected, "m");
    } catch (err) {
      return {
        ok: false,
        message: `FAIL: invalid regex "${expected}": ${err instanceof Error ? err.message : err}`,
      };
    }
  }
  const label = regex ? `/${expected}/` : `"${expected}"`;
  const lineHas = (line: string): boolean => (pattern ? pattern.test(line) : line.includes(expected));
  // Presence-failure hints only make sense for literal substrings.
  const hint = async (): Promise<string> => (pattern ? "" : await nearMissHint(session, expected, lines));

  if (count !== undefined) {
    if (row !== undefined || col !== undefined || absent) {
      return { ok: false, message: "FAIL: count cannot be combined with row/col/absent." };
    }
    // Non-overlapping occurrences across the whole screen text.
    const hay = lines.join("\n");
    let occurrences = 0;
    if (pattern) {
      occurrences = [...hay.matchAll(new RegExp(expected, "gm"))].length;
    } else {
      for (
        let i = expected.length > 0 ? hay.indexOf(expected) : -1;
        i !== -1;
        i = hay.indexOf(expected, i + expected.length)
      ) {
        occurrences++;
      }
    }
    const rowsWith = lines.map((line, y) => ({ line, y })).filter(({ line }) => lineHas(line));
    const listing = rowsWith.length > 0 ? `\n${rowsWith.map((h) => `  ${h.y}: ${h.line}`).join("\n")}` : "";
    if (occurrences === count) {
      return { ok: true, message: `PASS: ${label} appears ${occurrences} time(s).${listing}` };
    }
    return {
      ok: false,
      message: `FAIL: expected ${label} ${count} time(s), found ${occurrences}.${listing}`,
    };
  }

  if (col !== undefined && row === undefined) {
    return { ok: false, message: "FAIL: col requires row." };
  }

  if (absent) {
    if (col !== undefined) {
      return { ok: false, message: "FAIL: absent cannot be combined with col." };
    }
    if (row !== undefined) {
      if (row >= lines.length) {
        return {
          ok: false,
          message: `FAIL: row ${row} is outside the visible screen (0-${lines.length - 1}).`,
        };
      }
      const actual = lines[row];
      if (!lineHas(actual)) {
        return { ok: true, message: `PASS: row ${row} does not contain ${label}.\n  ${row}: ${actual}` };
      }
      return {
        ok: false,
        message: `FAIL: row ${row} unexpectedly contains ${label}.\n  ${row}: ${actual}`,
      };
    }
    const found = lines.map((line, y) => ({ line, y })).filter(({ line }) => lineHas(line));
    if (found.length === 0) {
      return { ok: true, message: `PASS: ${label} is absent from the visible screen.` };
    }
    const listing = found.map((h) => `  ${h.y}: ${h.line}`).join("\n");
    return {
      ok: false,
      message: `FAIL: ${label} should be absent but appears on row(s) ${found.map((h) => h.y).join(", ")}.\n${listing}`,
    };
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

    if (lineHas(actual)) {
      return { ok: true, message: `PASS: row ${row} contains ${label}.\n  ${row}: ${actual}` };
    }
    const context = lines
      .map((line, y) => `  ${y}: ${line}`)
      .slice(Math.max(0, row - 2), row + 3)
      .join("\n");
    return {
      ok: false,
      message: `FAIL: row ${row} does not contain ${label}.\nExpected: ${expected}\nActual row ${row}: ${actual}${await hint()}\nContext:\n${context}`,
    };
  }

  const hits = lines.map((line, y) => ({ line, y })).filter(({ line }) => lineHas(line));
  if (hits.length > 0) {
    const listing = hits.map((h) => `  ${h.y}: ${h.line}`).join("\n");
    return {
      ok: true,
      message: `PASS: ${label} found on row(s) ${hits.map((h) => h.y).join(", ")}.\n${listing}`,
    };
  }
  // A multiline regex (e.g. one using \n or ^...$ anchors across rows) can
  // match the joined screen without matching any single line.
  if (pattern?.test(lines.join("\n"))) {
    return { ok: true, message: `PASS: ${label} matches the visible screen.` };
  }
  return {
    ok: false,
    message: `FAIL: ${label} not found on the visible screen.${await hint()}\n${statusHeader(session)}\n${lines.join("\n")}`,
  };
}
