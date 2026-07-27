/**
 * Golden screen snapshots for the test runner: assert the whole rendered screen
 * against a stored file, regenerate with --update. Because the screen is a
 * canonical text grid, mismatches are shown as a readable row diff — far better
 * than image diffing. Volatile regions (clocks, PIDs, spinners) are masked by
 * regex so snapshots stay deterministic.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { screenDiff } from "./diff.js";

/** Replace each regex match with a fixed placeholder so volatile text doesn't churn snapshots. */
export function applyMasks(text: string, masks: string[]): string {
  let out = text;
  for (const m of masks) out = out.replace(new RegExp(m, "g"), "«MASKED»");
  return out;
}

const safe = (s: string): string => s.replace(/[^a-z0-9_.-]/gi, "_").slice(0, 80);

export interface GoldenOptions {
  screensDir: string;
  testName: string;
  snapshotName: string;
  actual: string;
  masks: string[];
  update: boolean;
}

export interface GoldenResult {
  ok: boolean;
  detail: string;
}

/** Compare `actual` (masked) against the stored golden, or (re)write it under --update. */
export function matchGolden(opts: GoldenOptions): GoldenResult {
  const masked = applyMasks(opts.actual, opts.masks);
  const file = join(opts.screensDir, `${safe(opts.testName)}.${safe(opts.snapshotName)}.txt`);

  if (opts.update || !existsSync(file)) {
    if (!opts.update && !existsSync(file)) {
      // Missing golden without --update is a failure, not a silent create:
      // an accidental typo'd snapshot name shouldn't quietly "pass".
      return {
        ok: false,
        detail: `no golden snapshot "${opts.snapshotName}" at ${file}. Run with --update to create it.`,
      };
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${masked}\n`);
    return { ok: true, detail: `wrote golden "${opts.snapshotName}"` };
  }

  const expected = readFileSync(file, "utf8").replace(/\n$/, "");
  if (masked === expected) return { ok: true, detail: `golden "${opts.snapshotName}" matched` };
  return {
    ok: false,
    detail: `golden "${opts.snapshotName}" mismatch:\n${screenDiff(expected, masked)}\n(run with --update to accept)`,
  };
}
