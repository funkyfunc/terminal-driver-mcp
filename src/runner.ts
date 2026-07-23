/**
 * Deterministic TUI test runner: replays a JSON test script (steps of waits,
 * keystrokes, and assertions) against a fresh PTY session with no LLM in the
 * loop. An agent authors the script interactively once; CI replays it forever
 * via `terminal-driver-mcp run <files...>` or the run_test tool.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { encodeKey } from "./keys.js";
import { assertScreen, snapshotText } from "./screen.js";
import {
  appCursorMode,
  createSession,
  killSession,
  resizeSession,
  type TerminalSession,
  writeToSession,
} from "./session-manager.js";
import { waitForExit, waitForIdle, waitForPattern, waitForStableScreen } from "./wait.js";

const timeoutMs = z.number().int().min(50).max(600000);

const StepSchema = z.union([
  z.object({ wait: z.string(), timeout_ms: timeoutMs.default(10000) }).strict(),
  z
    .object({
      idle_ms: z.number().int().min(20).max(10000),
      timeout_ms: timeoutMs.default(10000),
      mode: z.enum(["silence", "stable_screen"]).default("silence"),
    })
    .strict(),
  z
    .object({ write: z.string().default(""), keys: z.array(z.string()).default([]) })
    .strict()
    .refine((s) => s.write !== "" || s.keys.length > 0, { message: "write step needs 'write' text or 'keys'" }),
  z
    .object({
      assert: z.string(),
      row: z.number().int().min(0).optional(),
      col: z.number().int().min(0).optional(),
    })
    .strict(),
  z.object({ resize: z.tuple([z.number().int().min(20).max(500), z.number().int().min(5).max(200)]) }).strict(),
  z.object({ sleep_ms: z.number().int().min(1).max(60000) }).strict(),
  z.object({ expect_exit: z.number().int(), timeout_ms: timeoutMs.default(30000) }).strict(),
]);

export const TestSchema = z
  .object({
    name: z.string().default("unnamed test"),
    command: z.string().optional(),
    cwd: z.string().optional(),
    cols: z.number().int().min(20).max(500).default(120),
    rows: z.number().int().min(5).max(200).default(30),
    steps: z.array(StepSchema).min(1),
  })
  .strict();

export type TestSpec = z.infer<typeof TestSchema>;
type Step = z.infer<typeof StepSchema>;

export interface StepResult {
  index: number;
  desc: string;
  ok: boolean;
  detail: string;
  elapsedMs: number;
}

export interface TestResult {
  name: string;
  ok: boolean;
  steps: StepResult[];
  failureScreen?: string;
}

function describeStep(step: Step): string {
  if ("wait" in step) return `wait /${step.wait}/`;
  if ("idle_ms" in step) return `wait ${step.mode} ${step.idle_ms}ms`;
  if ("assert" in step)
    return `assert "${step.assert}"${step.row !== undefined ? ` @ row ${step.row}` : ""}${
      step.col !== undefined ? `, col ${step.col}` : ""
    }`;
  if ("resize" in step) return `resize ${step.resize[0]}x${step.resize[1]}`;
  if ("sleep_ms" in step) return `sleep ${step.sleep_ms}ms`;
  if ("expect_exit" in step) return `expect exit ${step.expect_exit}`;
  const keys = step.keys.length ? ` + [${step.keys.join(", ")}]` : "";
  return `write ${JSON.stringify(step.write)}${keys}`;
}

async function runStep(session: TerminalSession, step: Step): Promise<{ ok: boolean; detail: string }> {
  if ("wait" in step) {
    const result = await waitForPattern(session, new RegExp(step.wait, "m"), step.timeout_ms);
    return { ok: result.ok, detail: result.message };
  }
  if ("idle_ms" in step) {
    const result =
      step.mode === "stable_screen"
        ? await waitForStableScreen(session, step.idle_ms, step.timeout_ms)
        : await waitForIdle(session, step.idle_ms, step.timeout_ms);
    return { ok: result.ok, detail: result.message };
  }
  if ("assert" in step) {
    const result = await assertScreen(session, step.assert, step.row, step.col);
    return { ok: result.ok, detail: result.message };
  }
  if ("resize" in step) {
    resizeSession(session, step.resize[0], step.resize[1]);
    await waitForIdle(session, 100, 3000);
    return { ok: true, detail: `resized to ${step.resize[0]}x${step.resize[1]}` };
  }
  if ("sleep_ms" in step) {
    await new Promise((r) => setTimeout(r, step.sleep_ms));
    return { ok: true, detail: `slept ${step.sleep_ms}ms` };
  }
  if ("expect_exit" in step) {
    if (!(await waitForExit(session, step.timeout_ms))) {
      return { ok: false, detail: `process still running after ${step.timeout_ms}ms` };
    }
    const ok = session.exitCode === step.expect_exit;
    return {
      ok,
      detail: ok ? `exited ${session.exitCode}` : `expected exit ${step.expect_exit}, got ${session.exitCode}`,
    };
  }
  if (session.exited) {
    return { ok: false, detail: `cannot write: session exited (code ${session.exitCode})` };
  }
  const app = appCursorMode(session);
  const encoded = step.keys.map((k) => encodeKey(k, app));
  if (step.write) writeToSession(session, step.write);
  for (const bytes of encoded) writeToSession(session, bytes);
  await waitForIdle(session, 80, 2000);
  return { ok: true, detail: "written" };
}

let runCounter = 0;

export async function runTest(spec: TestSpec): Promise<TestResult> {
  const id = `__test_${++runCounter}`;
  const session = createSession({
    id,
    command: spec.command,
    cols: spec.cols,
    rows: spec.rows,
    cwd: spec.cwd,
  });
  const steps: StepResult[] = [];

  try {
    await waitForIdle(session, 150, 3000);
    for (const [index, step] of spec.steps.entries()) {
      const start = Date.now();
      let outcome: { ok: boolean; detail: string };
      try {
        outcome = await runStep(session, step);
      } catch (err) {
        outcome = { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
      steps.push({ index, desc: describeStep(step), ...outcome, elapsedMs: Date.now() - start });
      if (!outcome.ok) {
        return { name: spec.name, ok: false, steps, failureScreen: await snapshotText(session) };
      }
    }
    return { name: spec.name, ok: true, steps };
  } finally {
    await killSession(id);
  }
}

export function formatResult(result: TestResult): string {
  const lines = [`${result.ok ? "PASS" : "FAIL"}: ${result.name}`];
  for (const step of result.steps) {
    const mark = step.ok ? "✓" : "✗";
    const detail = step.ok ? "" : `\n      ${step.detail.split("\n").join("\n      ")}`;
    lines.push(`  ${mark} step ${step.index + 1}: ${step.desc} (${step.elapsedMs}ms)${detail}`);
  }
  if (result.failureScreen !== undefined) {
    lines.push(`  Final screen:\n${result.failureScreen.split("\n").map((l) => `  | ${l}`).join("\n")}`);
  }
  return lines.join("\n");
}

export function parseTest(json: string, source: string): TestSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`${source}: invalid JSON — ${err instanceof Error ? err.message : err}`);
  }
  const parsed = TestSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`${source}: invalid test spec —\n${issues}`);
  }
  return parsed.data;
}

/** CLI entry: run each test file, print results, return a process exit code. */
export async function runTestFiles(files: string[], print: (line: string) => void): Promise<number> {
  if (files.length === 0) {
    print("Usage: terminal-driver-mcp run <test.json...>");
    return 2;
  }
  let failures = 0;
  for (const file of files) {
    let result: TestResult;
    try {
      result = await runTest(parseTest(readFileSync(file, "utf8"), file));
    } catch (err) {
      print(`FAIL: ${file} — ${err instanceof Error ? err.message : err}`);
      failures++;
      continue;
    }
    print(formatResult(result));
    if (!result.ok) failures++;
  }
  print(failures === 0 ? `\nAll ${files.length} test(s) passed.` : `\n${failures} of ${files.length} test(s) failed.`);
  return failures === 0 ? 0 : 1;
}
