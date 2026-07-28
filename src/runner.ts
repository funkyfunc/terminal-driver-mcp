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
import { type FileResult, jsonReport, junitReport } from "./report.js";
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

// Optional section label carried by any step; consecutive steps sharing a label
// render as a named group in reports and the trace viewer (test.step, flattened).
const group = z.string().optional().describe("Section label to group this step under in reports");
// Assertion steps may be soft: a soft failure is recorded and fails the test
// overall, but execution continues instead of stopping at that step.
const soft = z.boolean().default(false).describe("Record the failure and keep going (still fails the test)");

const StepSchema = z.union([
  z
    .object({
      wait: z.string(),
      timeout_ms: timeoutMs.default(10000),
      absent: z.boolean().default(false),
      group,
    })
    .strict(),
  z
    .object({
      idle_ms: z.number().int().min(20).max(10000),
      timeout_ms: timeoutMs.default(10000),
      mode: z.enum(["silence", "stable_screen"]).default("silence"),
      group,
    })
    .strict(),
  z
    .object({
      write: z.string().default(""),
      keys: z.array(z.string()).default([]),
      raw_hex: z.string().default(""),
      group,
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
      absent: z.boolean().default(false), // invert: assert the text is NOT on screen
      count: z.number().int().min(0).optional(), // assert exactly N occurrences across the screen
      soft,
      group,
    })
    .strict(),
  z
    .object({
      resize: z.tuple([z.number().int().min(20).max(500), z.number().int().min(5).max(200)]),
      group,
    })
    .strict(),
  z.object({ sleep_ms: z.number().int().min(1).max(60000), group }).strict(),
  z.object({ command_exit: z.number().int(), soft, group }).strict(), // assert last shell command's exit code (needs shell_integration)
  z.object({ match_screen: z.string(), mask: z.array(z.string()).default([]), soft, group }).strict(), // golden snapshot: compare the whole screen to a stored file (regenerate with --update)
  z.object({ expect_exit: z.number().int(), timeout_ms: timeoutMs.default(30000), soft, group }).strict(),
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
  group?: string; // section label (test.step grouping)
  soft?: boolean; // a failed soft assertion: recorded, but execution continued
  screen?: CellSnapshot; // captured after the step when tracing is on
}

/** A soft assertion records its failure but does not stop the run. */
const isSoft = (step: Step): boolean => "soft" in step && step.soft === true;

export interface TestResult {
  name: string;
  ok: boolean;
  steps: StepResult[];
  failureScreen?: string;
}

function describeStep(step: Step): string {
  if ("wait" in step)
    return `wait ${step.absent ? "for /" : "/"}${step.wait}/${step.absent ? " to clear" : ""}`;
  if ("idle_ms" in step) return `wait ${step.mode} ${step.idle_ms}ms`;
  if ("assert" in step) {
    if (step.count !== undefined) return `assert "${step.assert}" ×${step.count}`;
    return `assert ${step.absent ? "not " : ""}"${step.assert}"${
      step.row !== undefined ? ` @ row ${step.row}` : ""
    }${step.col !== undefined ? `, col ${step.col}` : ""}`;
  }
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
    const result = await waitForPattern(session, new RegExp(step.wait, "m"), step.timeout_ms, step.absent);
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
    const result = await assertScreen(session, step.assert, {
      row: step.row,
      col: step.col,
      absent: step.absent,
      count: step.count,
    });
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
      const soft = isSoft(step);
      steps.push({
        index,
        desc: describeStep(step),
        ...outcome,
        elapsedMs: Date.now() - start,
        group: step.group,
        soft: soft && !outcome.ok ? true : undefined,
        screen,
      });
      // A hard failure stops the run; a soft failure is recorded and we continue.
      if (!outcome.ok && !soft) {
        return finish({ name: spec.name, ok: false, steps, failureScreen: await snapshotText(session) });
      }
    }
    // Ran every step: fail overall iff any (soft) assertion failed along the way.
    const ok = steps.every((s) => s.ok);
    return finish({
      name: spec.name,
      ok,
      steps,
      failureScreen: ok ? undefined : await snapshotText(session),
    });
  } finally {
    await killSession(id);
  }
}

export function formatResult(result: TestResult): string {
  const lines = [`${result.ok ? "PASS" : "FAIL"}: ${result.name}`];
  let lastGroup: string | undefined;
  for (const step of result.steps) {
    if (step.group !== lastGroup) {
      if (step.group) lines.push(`  ▸ ${step.group}`);
      lastGroup = step.group;
    }
    // ✓ passed, ✗ hard failure, ⚠ soft failure (recorded, run continued).
    const mark = step.ok ? "✓" : step.soft ? "⚠" : "✗";
    const tag = step.soft ? " (soft)" : "";
    const detail = step.ok ? "" : `\n      ${step.detail.split("\n").join("\n      ")}`;
    lines.push(`  ${mark} step ${step.index + 1}: ${step.desc}${tag} (${step.elapsedMs}ms)${detail}`);
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

// Pull `--flag value` out of an argv list, returning the value (or undefined).
function takeOption(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0 || i + 1 >= args.length) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

/**
 * CLI entry: run each test file, print results, return a process exit code.
 * Flags: `--update` regenerates golden snapshots (in a `__screens__/` dir
 * beside each file), `--trace` writes a `<file>.trace.html`, `--retries N`
 * re-runs a failing test up to N times (a test that then passes is reported
 * flaky, not failed — the Playwright convention), and `--junit <path>` /
 * `--json <path>` write aggregated CI reports.
 */
export async function runTestFiles(args: string[], print: (line: string) => void): Promise<number> {
  const rest = [...args];
  const junitOut = takeOption(rest, "--junit");
  const jsonOut = takeOption(rest, "--json");
  const retries = Math.max(0, Math.min(10, Number.parseInt(takeOption(rest, "--retries") ?? "0", 10) || 0));
  const update = rest.includes("--update");
  const trace = rest.includes("--trace");
  const files = rest.filter((a) => !a.startsWith("--"));
  if (files.length === 0) {
    print(
      "Usage: terminal-driver-mcp run [--update] [--trace] [--retries N] [--junit <path>] [--json <path>] <test.json...>",
    );
    return 2;
  }
  let failures = 0;
  let flakes = 0;
  const collected: FileResult[] = [];
  for (const file of files) {
    const options: RunOptions = {
      screensDir: join(dirname(file), "__screens__"),
      update,
      trace: trace ? `${file.replace(/\.json$/i, "")}.trace.html` : undefined,
    };
    let spec: TestSpec;
    try {
      spec = parseTest(readFileSync(file, "utf8"), file);
    } catch (err) {
      print(`FAIL: ${file} — ${err instanceof Error ? err.message : err}`);
      failures++;
      continue;
    }
    // Attempt up to retries+1 times; stop as soon as a run passes. Updating
    // golden snapshots is a single deterministic pass, so never retry then.
    const maxAttempts = update ? 1 : retries + 1;
    let result: TestResult;
    let attempts = 0;
    do {
      attempts++;
      if (attempts > 1) print(`  retry ${attempts - 1}/${retries} of ${spec.name}…`);
      result = await runTest(spec, options);
    } while (!result.ok && attempts < maxAttempts);
    if (trace && options.trace) print(`  trace: ${options.trace}`);

    const flaky = result.ok && attempts > 1;
    if (flaky) flakes++;
    collected.push({ file, result, attempts, flaky });
    print(formatResult(result));
    if (flaky) print(`  FLAKY: ${spec.name} passed on attempt ${attempts} of ${maxAttempts}.`);
    if (!result.ok) failures++;
  }
  if (junitOut) {
    writeFileSync(junitOut, junitReport(collected));
    print(`  JUnit report: ${junitOut}`);
  }
  if (jsonOut) {
    writeFileSync(jsonOut, jsonReport(collected));
    print(`  JSON report: ${jsonOut}`);
  }
  // Flaky tests passed (within the retry budget) and do not fail the build,
  // but are always called out so intermittent failures never hide silently.
  const flakeNote = flakes > 0 ? ` (${flakes} flaky)` : "";
  print(
    failures === 0
      ? `\nAll ${files.length} test(s) passed${flakeNote}.`
      : `\n${failures} of ${files.length} test(s) failed${flakeNote}.`,
  );
  return failures === 0 ? 0 : 1;
}
