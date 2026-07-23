/**
 * Asciicast v2 session recordings (https://docs.asciinema.org/manual/asciicast/v2/).
 *
 * Recording is strictly best-effort: a session must never fail or slow down
 * because its recording cannot be written, so every filesystem error here is
 * absorbed by closing the recording.
 */
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const RECORDING_DIR =
  process.env.TERMINAL_DRIVER_MCP_RECORDING_DIR ?? join(homedir(), ".terminal-driver-mcp", "recordings");

/** "o" = output bytes, "i" = agent input, "r" = resize. */
export type RecordingEvent = "o" | "i" | "r";

export class Recording {
  private closed = false;

  private constructor(
    readonly path: string,
    private readonly fd: number,
    private readonly startedAt: number
  ) {}

  /** Open a recording file, or return undefined if the directory is unwritable. */
  static open(sessionId: string, title: string, cols: number, rows: number): Recording | undefined {
    try {
      mkdirSync(RECORDING_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const path = join(RECORDING_DIR, `${sessionId}-${stamp}.cast`);
      const fd = openSync(path, "w");
      const header = {
        version: 2,
        width: cols,
        height: rows,
        timestamp: Math.floor(Date.now() / 1000),
        title,
      };
      writeSync(fd, `${JSON.stringify(header)}\n`);
      return new Recording(path, fd, Date.now());
    } catch {
      return undefined;
    }
  }

  event(type: RecordingEvent, data: string): void {
    if (this.closed) return;
    try {
      const elapsed = (Date.now() - this.startedAt) / 1000;
      writeSync(this.fd, `${JSON.stringify([elapsed, type, data])}\n`);
    } catch {
      this.closed = true;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      closeSync(this.fd);
    } catch {
      /* already closed */
    }
  }
}
