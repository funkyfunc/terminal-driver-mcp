/**
 * Deterministic TUI test runner: replays a JSON test script (steps of waits,
 * keystrokes, and assertions) against a fresh PTY session with no LLM in the
 * loop. An agent authors the script interactively once; CI replays it forever
 * via `terminal-driver-mcp run <files...>` or the run_test tool.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { matchGolden } from "./golden.js";
import { decodeHex, encodeKey } from "./keys.js";
import { assertScreen, type CellSnapshot, snapshotCells, snapshotText } from "./screen.js";
import {
  appCursorMode,
  createSession,
  killSession,
  resizeSession,
  type TerminalSession,
  writeToSession,
} from "./session-manager.js";
import { renderTrace } from "./trace.js";
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
    .object({
      write: z.string().default(""),
      keys: z.array(z.string()).default([]),
      raw_hex: z.string().default(""),
    })
    .strict()
    .refine((s) => s.write !== "" || s.keys.length > 0 || s.raw_hex !== "", {
      message: "write step needs 'write' text, 'keys', or 'raw_hex'",
    }),
  z
    .object({
      assert: z.string(),
      row: z.number().int().min(0).optional(),
      col: z.number().int().min(0).optional(),
    })
    .strict(),
  z
    .object({ resize: z.tuple([z.number().int().min(20).max(500), z.number().int().min(5).max(200)]) })
    .strict(),
  z.object({ sleep_ms: z.number().int().min(1).max(60000) }).strict(),
  z.object({ command_exit: z.number().int() }).strict(), // assert last shell command's exit code (needs shell_integration)
  z.object({ match_screen: z.string(), mask: z.array(z.string()).default([]) }).strict(), // golden snapshot: compare the whole screen to a stored file (regenerate with --update)
  z.object({ expect_exit: z.number().int(), timeout_ms: timeoutMs.default(30000) }).strict(),
]);

export const TestSchema = z
  .object({
    name: z.string().default("unnamed test"),
    command: z.string().optional(),
    cwd: z.string().optional(),
    cols: z.number().int().min(20).max(500).default(120),
    rows: z.number().int().min(5).max(200).default(30),
    shell_integration: z.boolean().default(false),
    steps: z.array(StepSchema).min(1),
  })
  .strict();

export type TestSpec = z.infer<typeof TestSchema>;
/** The pre-validation shape (schema defaults not yet applied) — for emitting clean skeletons. */
export type TestDraft = z.input<typeof TestSchema>;
type Step = z.infer<typeof StepSchema>;

export interface StepResult {
  index: number;
  desc: string;
  ok: boolean;
  detail: string;
  elapsedMs: number;
  screen?: CellSnapshot; // captured after the step when tracing is on
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
  if ("command_exit" in step) return `command exit ${step.command_exit}`;
  if ("match_screen" in step) return `match screen "${step.match_screen}"`;
  if ("expect_exit" in step) return `expect exit ${step.expect_exit}`;
  const keys = step.keys.length ? ` + [${step.keys.join(", ")}]` : "";
  const raw = step.raw_hex ? ` + raw_hex ${step.raw_hex}` : "";
  return `write ${JSON.stringify(step.write)}${keys}${raw}`;
}

/** Where golden snapshots live, whether to (re)write them, and an optional trace path. */
export interface RunOptions {
  screensDir?: string;
  update?: boolean;
  /** If set, capture each step's screen and write a self-contained HTML trace here. */
  trace?: string;
}

async function runStep(
  session: TerminalSession,
  step: Step,
  ctx: { testName: string; options: RunOptions },
): Promise<{ ok: boolean; detail: string }> {
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
  if ("command_exit" in step) {
    await snapshotText(session); // flush a pending OSC 133 D marker
    const last = session.commands[session.commands.length - 1];
    if (!last) return { ok: false, detail: "no shell command recorded (needs shell_integration:true)" };
    const ok = last.exitCode === step.command_exit;
    return {
      ok,
      detail: ok ? `exit ${last.exitCode}` : `expected exit ${step.command_exit}, got ${last.exitCode}`,
    };
  }
  if ("match_screen" in step) {
    if (!ctx.options.screensDir) {
      return {
        ok: false,
        detail: "match_screen needs a screens directory (run a test file via the CLI, or pass screens_dir)",
      };
    }
    const actual = await snapshotText(session);
    return matchGolden({
      screensDir: ctx.options.screensDir,
      testName: ctx.testName,
      snapshotName: step.match_screen,
      actual,
      masks: step.mask,
      update: ctx.options.update ?? false,
    });
  }
  if ("expect_exit" in step) {
    if (!(await waitForExit(session, step.timeout_ms))) {
      return { ok: false, detail: `process still running after ${step.timeout_ms}ms` };
    }
    const ok = session.exitCode === step.expect_exit;
    return {
      ok,
      detail: ok
        ? `exited ${session.exitCode}`
        : `expected exit ${step.expect_exit}, got ${session.exitCode}`,
    };
  }
  if (session.exited) {
    return { ok: false, detail: `cannot write: session exited (code ${session.exitCode})` };
  }
  const app = appCursorMode(session);
  const encoded = step.keys.map((k) => encodeKey(k, app));
  const rawBytes = step.raw_hex ? decodeHex(step.raw_hex) : "";
  if (step.write) writeToSession(session, step.write);
  for (const bytes of encoded) writeToSession(session, bytes);
  if (rawBytes) writeToSession(session, rawBytes);
  await waitForIdle(session, 80, 2000);
  return { ok: true, detail: "written" };
}

let runCounter = 0;

export async function runTest(spec: TestSpec, options: RunOptions = {}): Promise<TestResult> {
  const id = `__test_${++runCounter}`;
  const session = createSession({
    id,
    command: spec.command,
    cols: spec.cols,
    rows: spec.rows,
    cwd: spec.cwd,
    shellIntegration: spec.shell_integration,
  });
  const steps: StepResult[] = [];
  const ctx = { testName: spec.name, options };

  const finish = (result: TestResult): TestResult => {
    if (options.trace) {
      try {
        writeFileSync(options.trace, renderTrace(result));
      } catch (err) {
        console.error("[terminal-driver-mcp] could not write trace:", err);
      }
    }
    return result;
  };

  try {
    await waitForIdle(session, 150, 3000);
    if (session.integrationReady) await session.integrationReady;
    for (const [index, step] of spec.steps.entries()) {
      const start = Date.now();
      let outcome: { ok: boolean; detail: string };
      try {
        outcome = await runStep(session, step, ctx);
      } catch (err) {
        outcome = { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
      const screen = options.trace ? await snapshotCells(session) : undefined;
      steps.push({ index, desc: describeStep(step), ...outcome, elapsedMs: Date.now() - start, screen });
      if (!outcome.ok) {
        return finish({ name: spec.name, ok: false, steps, failureScreen: await snapshotText(session) });
      }
    }
    return finish({ name: spec.name, ok: true, steps });
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
    lines.push(
      `  Final screen:\n${result.failureScreen
        .split("\n")
        .map((l) => `  | ${l}`)
        .join("\n")}`,
    );
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
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`${source}: invalid test spec —\n${issues}`);
  }
  return parsed.data;
}

/**
 * CLI entry: run each test file, print results, return a process exit code.
 * A `--update` argument (anywhere in the list) regenerates golden snapshots;
 * each file's goldens live in a `__screens__/` dir beside it.
 */
export async function runTestFiles(args: string[], print: (line: string) => void): Promise<number> {
  const update = args.includes("--update");
  const trace = args.includes("--trace");
  const files = args.filter((a) => !a.startsWith("--"));
  if (files.length === 0) {
    print("Usage: terminal-driver-mcp run [--update] [--trace] <test.json...>");
    return 2;
  }
  let failures = 0;
  for (const file of files) {
    let result: TestResult;
    try {
      const options: RunOptions = {
        screensDir: join(dirname(file), "__screens__"),
        update,
        trace: trace ? `${file.replace(/\.json$/i, "")}.trace.html` : undefined,
      };
      result = await runTest(parseTest(readFileSync(file, "utf8"), file), options);
      if (trace && options.trace) print(`  trace: ${options.trace}`);
    } catch (err) {
      print(`FAIL: ${file} — ${err instanceof Error ? err.message : err}`);
      failures++;
      continue;
    }
    print(formatResult(result));
    if (!result.ok) failures++;
  }
  print(
    failures === 0
      ? `\nAll ${files.length} test(s) passed.`
      : `\n${failures} of ${files.length} test(s) failed.`,
  );
  return failures === 0 ? 0 : 1;
}
